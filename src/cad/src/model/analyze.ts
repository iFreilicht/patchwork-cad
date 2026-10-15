import { parse, type AnyNode, type CallExpression, type Expression, type ModuleDeclaration, type Program, type Statement } from "acorn";
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
   * (`const [left, right] = body(…)`) under the same conditions as `variable`.
   */
  variables: string[];
  /** Whether the result is destructured as an array, even of one name. */
  destructured: boolean;
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
  const variables =
    declared?.type === "Identifier"
      ? [declared.name]
      : declared?.type === "ArrayPattern" && declared.elements.length > 0 && declared.elements.every((e) => e?.type === "Identifier")
        ? declared.elements.map((e) => (e as { name: string }).name)
        : [];
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
    destructured: declared?.type === "ArrayPattern" && variables.length > 0,
    statement,
  };
}
