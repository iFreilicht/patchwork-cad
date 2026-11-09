import { parse, type AnyNode, type AssignmentProperty, type CallExpression, type Expression, type ModuleDeclaration, type ObjectPattern, type Program, type Property, type RestElement, type SpreadElement, type Statement } from "acorn";
import { isFeatureType, type FeatureType } from "@patchwork-cad/features/schema";

/** The module models import features from. */
export const FEATURES_MODULE = "@patchwork-cad/features";

export interface Span {
  start: number;
  end: number;
}

export interface Prop {
  key: string;
  /** The whole `key: value` property. */
  span: Span;
  value: Span;
  node: Expression;
}

/** A call of an imported built-in feature, e.g. `const extrude1 = extrude({ … })`. */
export interface FeatureCall {
  type: FeatureType;
  span: Span;
  /** 1-based line of the call. */
  line: number;
  args: Span[];
  /** The properties of the first argument, if it is an object literal. */
  props: Prop[] | undefined;
  /** The object literal's braces, for inserting properties. */
  object: Span | undefined;
  /**
   * The `const` it initializes, if that name identifies one feature per build: declared in the
   * module or in `main`, outside of loops and nested functions.
   */
  variable: string | undefined;
  /**
   * All variables the call initializes: `[variable]`, or the names of a destructured result
   * (`const { base, lid: top } = body(…)`) under the same conditions as `variable`.
   */
  variables: string[];
  /** The keys a destructured result is read by, one per variable (`["base", "lid"]`); undefined if it isn't destructured. */
  keys: string[] | undefined;
  /** The statement of `main` (or the module) that contains the call. */
  statement: Statement | ModuleDeclaration | undefined;
}

export interface Analysis {
  program: Program;
  /** Local names of the feature library's imports, by local name → imported name. */
  imports: Map<string, string>;
  /** The default-exported `main` function's body statements, if there is one. */
  main: { statements: Statement[]; body: Span } | undefined;
  calls: FeatureCall[];
}

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const v of value) if (v && typeof v.type === "string") out.push(v);
    if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") out.push(value as AnyNode);
  }
  return out;
}

type FunctionNode = Extract<AnyNode, { type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression" }>;

/** Parses a model and finds its feature calls. Throws acorn's SyntaxError (with `loc`) on invalid code. */
export function analyze(source: string): Analysis {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const imports = new Map<string, string>();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== FEATURES_MODULE) continue;
    for (const s of node.specifiers) {
      if (s.type !== "ImportSpecifier") continue;
      imports.set(s.local.name, s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value));
    }
  }

  let mainFn: FunctionNode | undefined;
  let main: Analysis["main"];
  for (const node of program.body) {
    if (node.type === "ExportDefaultDeclaration" && (node.declaration.type === "FunctionDeclaration" || node.declaration.type === "FunctionExpression" || node.declaration.type === "ArrowFunctionExpression")) {
      mainFn = node.declaration;
      const body = node.declaration.body;
      if (body.type === "BlockStatement") main = { statements: body.body, body: { start: body.start, end: body.end } };
    }
  }

  const calls: FeatureCall[] = [];
  const ancestors: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    if (node.type === "CallExpression") {
      const call = node as CallExpression;
      const imported = call.callee.type === "Identifier" ? imports.get(call.callee.name) : undefined;
      if (imported && isFeatureType(imported)) calls.push(describeCall(call, imported, [...ancestors], mainFn, program));
    }
    ancestors.push(node);
    for (const child of children(node)) visit(child);
    ancestors.pop();
  };
  visit(program);
  return { program, imports, main, calls };
}

/** The key of a property that isn't computed: `a` or `"a"` in `{ a: x }`. */
export function propertyKey(p: Property | SpreadElement | AssignmentProperty | RestElement): string | undefined {
  if (p.type !== "Property" || p.computed) return undefined;
  return p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" && typeof p.key.value === "string" ? p.key.value : undefined;
}

/** `{ a, b: c }` as keys and the identifiers they hold, if every property is one such pair: an object, or a destructuring pattern. */
export function keyedNames(properties: readonly (Property | SpreadElement | AssignmentProperty | RestElement)[]): { key: string; name: string; span: Span }[] | undefined {
  const pairs = properties.map((p) => {
    const key = propertyKey(p);
    return key !== undefined && p.type === "Property" && p.value.type === "Identifier" ? { key, name: p.value.name, span: { start: p.value.start, end: p.value.end } } : undefined;
  });
  return pairs.every((p) => p !== undefined) ? (pairs as { key: string; name: string; span: Span }[]) : undefined;
}

/** `{ base, lid: top }` as keys and variables. */
function destructuring(pattern: ObjectPattern): { key: string; name: string }[] | undefined {
  const pairs = keyedNames(pattern.properties);
  return pairs && pairs.length > 0 ? pairs : undefined;
}

/**
 * One thing `main` returns (research/15, "Output"): a version, by its variable, under its key. In
 * `return x` or `return [a, b]`, as in `return { x }`, the key is the variable's name.
 */
export interface Output {
  key: string;
  name: string;
  /** The returned identifier. */
  span: Span;
}

/** What `main` returns, if it is names: an object of them (`return { plate: notched, lid }`), one, or a list of them. */
export function returnedOutputs(analysis: Pick<Analysis, "main">): { node: Expression; outputs: Output[] } | undefined {
  const statement = analysis.main?.statements.at(-1);
  if (statement?.type !== "ReturnStatement" || !statement.argument) return undefined;
  const arg = statement.argument;
  const span = (n: AnyNode) => ({ start: n.start, end: n.end });
  if (arg.type === "Identifier") return { node: arg, outputs: [{ key: arg.name, name: arg.name, span: span(arg) }] };
  if (arg.type === "ArrayExpression" && arg.elements.every((e) => e?.type === "Identifier")) return { node: arg, outputs: arg.elements.map((e) => ({ key: (e as { name: string }).name, name: (e as { name: string }).name, span: span(e!) })) };
  const outputs = arg.type === "ObjectExpression" ? keyedNames(arg.properties) : undefined;
  return outputs ? { node: arg, outputs } : undefined;
}

function describeCall(call: CallExpression, type: FeatureType, ancestors: AnyNode[], mainFn: FunctionNode | undefined, program: Program): FeatureCall {
  const first = call.arguments[0];
  const object = first?.type === "ObjectExpression" ? first : undefined;
  const props = object?.properties.flatMap((p): Prop[] => {
    if (p.type !== "Property" || p.computed) return [];
    const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
    if (key === undefined) return [];
    return [{ key, span: { start: p.start, end: p.end }, value: { start: p.value.start, end: p.value.end }, node: p.value as Expression }];
  });

  // The innermost function around the call must be main (or none), with no loop in between.
  const fnIndex = ancestors.findLastIndex((a) => FUNCTIONS.has(a.type));
  const scope = fnIndex >= 0 ? ancestors[fnIndex] : program;
  const inScope = scope === program || scope === mainFn;
  const loop = ancestors.slice(fnIndex + 1).some((a) => LOOPS.has(a.type));
  const parent = ancestors[ancestors.length - 1];
  const declaration = ancestors[ancestors.length - 2];
  const declared = inScope && !loop && parent?.type === "VariableDeclarator" && parent.init === call && declaration?.type === "VariableDeclaration" && declaration.kind === "const" ? parent.id : undefined;
  const pattern = declared?.type === "ObjectPattern" ? destructuring(declared) : undefined;
  const variables = declared?.type === "Identifier" ? [declared.name] : (pattern?.map((p) => p.name) ?? []);
  const variable = variables[0];

  const inMain = mainFn !== undefined && mainFn.start <= call.start && call.end <= mainFn.end;
  const mainBody = inMain && mainFn.body.type === "BlockStatement" ? mainFn.body.body : undefined;
  const statement = (mainBody ?? program.body).find((s) => s.start <= call.start && call.end <= s.end);

  return {
    type,
    span: { start: call.start, end: call.end },
    line: call.loc?.start.line ?? 1,
    args: call.arguments.map((a) => ({ start: a.start, end: a.end })),
    props,
    object: object ? { start: object.start, end: object.end } : undefined,
    variable,
    variables,
    keys: pattern?.map((p) => p.key),
    statement,
  };
}

/**
 * Whether evaluating `node` can do nothing but compute a value: no calls but `Math.…(…)`, no
 * functions, no assignments, and no objects or arrays, which later code could change.
 */
function pure(node: AnyNode): boolean {
  if (node.type === "CallExpression") {
    const callee = node.callee;
    const math = callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === "Math";
    if (!math) return false;
  }
  if (["ObjectExpression", "ArrayExpression", "NewExpression", "FunctionExpression", "ArrowFunctionExpression", "ClassExpression", "AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression", "TaggedTemplateExpression", "ImportExpression"].includes(node.type)) return false;
  for (const value of Object.values(node)) for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === "object" && typeof (v as AnyNode).type === "string" && !pure(v as AnyNode)) return false;
  return true;
}

/** The leading `const x = <pure expression>;` statements of `main`: its derived parameters (research/17, "Derived parameters"). */
export function derivedStatements(analysis: Analysis): Statement[] {
  const out: Statement[] = [];
  for (const s of analysis.main?.statements ?? []) {
    const d = s.type === "VariableDeclaration" && s.kind === "const" && s.declarations.length === 1 ? s.declarations[0] : undefined;
    if (!d || d.id.type !== "Identifier" || !d.init || !pure(d.init)) break;
    out.push(s);
  }
  return out;
}
