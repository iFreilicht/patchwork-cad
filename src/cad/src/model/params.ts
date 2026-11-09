/**
 * A model's parameters (research/17-parameters.md): `export const defaultParams = {…}`, the names
 * `main` destructures from its argument, the derived constants at the start of `main`, and
 * `export const paramConfig = {…}`; and the edits that add, rename, remove and change them.
 */
import type { AnyNode, AssignmentProperty, Expression, ObjectExpression, ObjectPattern, Pattern, Property, Statement } from "acorn";
import { schemas, type ParamSpec } from "@patchwork-cad/features/schema";
import { derivedStatements, propertyKey, type Analysis, type Span } from "./analyze.ts";
import { usesIn } from "./deps.ts";
import { clashes, declarable, renameProperty } from "./refactor.ts";
import { indentOf, lines, replaceIdentifier, type Edit } from "./splice.ts";

import type { ParamValue } from "../types.ts";

export type { ParamValue };

/** What `paramConfig` says about one parameter: JSON Schema's names, and `unit` (research/17, "Kinds, units, ranges"). */
export interface ParamConfig {
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: ParamValue[];
  unit?: string;
}

/** A keyed property of an object literal or pattern. */
export interface KeyedProp {
  key: string;
  /** The whole property. */
  span: Span;
  keySpan: Span;
  value: Span;
  node: Property | AssignmentProperty;
}

export interface Parameter {
  key: string;
  /** The variable `main` reads it as: the key, or `width` in `{ w: width }`. */
  local: string;
  /** Its default as code, if `defaultParams` has one. */
  value: string | undefined;
  /** Its default as JSON, if it is a literal. */
  literal: ParamValue | undefined;
}

/** A derived parameter: a `const` at the start of `main` that only computes a value. */
export interface Derived {
  name: string;
  statement: Span;
  init: Span;
  text: string;
}

export interface Parameters {
  params: Parameter[];
  derived: Derived[];
  config: Record<string, ParamConfig>;
  /** Why the editor can only show them, if it can't edit them; `main` or `defaultParams` aren't written as it writes them. */
  readOnly: string | undefined;
  defaults: { object: Span; props: KeyedProp[]; statement: Span } | undefined;
  pattern: { object: Span; props: KeyedProp[] } | undefined;
  configObject: { object: Span; props: KeyedProp[] } | undefined;
  /** Where `main`'s parameter list is, `(…)`, to add a pattern to. */
  paramList: Span | undefined;
  /** The `export default` statement of `main`. */
  mainStatement: Span | undefined;
  mainBody: Span | undefined;
}

type FunctionNode = Extract<AnyNode, { type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression" }>;

/** The keyed properties of an object literal or pattern, if all of them are plain `key: value` pairs. */
function keyedProps(object: ObjectExpression | ObjectPattern, values: "any" | "identifiers"): KeyedProp[] | undefined {
  const out: KeyedProp[] = [];
  for (const p of object.properties) {
    const key = propertyKey(p);
    if (key === undefined || p.type !== "Property" || p.kind !== "init" || p.method) return undefined;
    if (values === "identifiers" && p.value.type !== "Identifier") return undefined;
    if (values === "any" && p.shorthand) return undefined;
    out.push({ key, span: { start: p.start, end: p.end }, keySpan: { start: p.key.start, end: p.key.end }, value: { start: p.value.start, end: p.value.end }, node: p });
  }
  return out;
}

/** A literal as JSON: numbers (also negative), strings, booleans, null, and arrays and objects of them. */
export function literal(node: AnyNode): ParamValue | undefined {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "number" || typeof node.value === "string" || typeof node.value === "boolean" || node.value === null ? node.value : undefined;
    case "UnaryExpression": {
      const value = node.operator === "-" || node.operator === "+" ? literal(node.argument) : undefined;
      return typeof value === "number" ? (node.operator === "-" ? -value : value) : undefined;
    }
    case "TemplateLiteral":
      return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? undefined) : undefined;
    case "ArrayExpression": {
      const items = node.elements.map((e) => (e && e.type !== "SpreadElement" ? literal(e) : undefined));
      return items.every((i) => i !== undefined) ? (items as ParamValue[]) : undefined;
    }
    case "ObjectExpression": {
      const out: Record<string, ParamValue> = {};
      for (const p of node.properties) {
        const key = propertyKey(p);
        const value = key !== undefined && p.type === "Property" && !p.shorthand ? literal(p.value) : undefined;
        if (key === undefined || value === undefined) return undefined;
        out[key] = value;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** The declarator of `export const <name> = …`, if the module has one. */
function exported(analysis: Analysis, name: string): { init: Expression | null | undefined; statement: Span } | undefined {
  for (const node of analysis.program.body) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "VariableDeclaration") continue;
    const d = node.declaration.declarations.find((x) => x.id.type === "Identifier" && x.id.name === name);
    if (d) return { init: d.init, statement: { start: node.start, end: node.end } };
  }
  return undefined;
}

function mainFunction(analysis: Analysis): { fn: FunctionNode; statement: Span } | undefined {
  for (const node of analysis.program.body) {
    if (node.type === "ExportDefaultDeclaration" && (node.declaration.type === "FunctionDeclaration" || node.declaration.type === "FunctionExpression" || node.declaration.type === "ArrowFunctionExpression")) return { fn: node.declaration, statement: { start: node.start, end: node.end } };
  }
  return undefined;
}

export function parameters(source: string, analysis: Analysis): Parameters {
  const readOnly: string[] = [];
  const main = mainFunction(analysis);

  const defaultsDecl = exported(analysis, "defaultParams");
  let defaults: Parameters["defaults"];
  if (defaultsDecl) {
    const props = defaultsDecl.init?.type === "ObjectExpression" ? keyedProps(defaultsDecl.init, "any") : undefined;
    if (props && defaultsDecl.init) defaults = { object: { start: defaultsDecl.init.start, end: defaultsDecl.init.end }, props, statement: defaultsDecl.statement };
    else readOnly.push("defaultParams isn't an object of keyed values");
  }

  let pattern: Parameters["pattern"];
  let paramList: Span | undefined;
  if (!main) readOnly.push("the model has no default-exported main function");
  else {
    const first = main.fn.params[0] as Pattern | undefined;
    const objectPattern = first?.type === "ObjectPattern" ? first : first?.type === "AssignmentPattern" && first.left.type === "ObjectPattern" ? first.left : undefined;
    if (objectPattern) {
      const props = keyedProps(objectPattern, "identifiers");
      if (props) pattern = { object: { start: objectPattern.start, end: objectPattern.end }, props };
      else readOnly.push("main destructures its parameters with defaults or a rest");
    } else if (first) readOnly.push(`main takes its parameters as ${source.slice(first.start, first.end)}, not destructured`);
    const open = source.indexOf("(", main.fn.type === "ArrowFunctionExpression" ? main.fn.start : (main.fn.id?.end ?? main.fn.start));
    if (open >= 0 && open < main.fn.body.start) paramList = { start: open, end: source.lastIndexOf(")", main.fn.body.start) + 1 };
  }

  const configDecl = exported(analysis, "paramConfig");
  const configObject = configDecl?.init?.type === "ObjectExpression" ? keyedProps(configDecl.init, "any") : undefined;
  const config: Record<string, ParamConfig> = {};
  for (const p of configObject ?? []) {
    const value = literal(p.node.value);
    if (value && typeof value === "object" && !Array.isArray(value)) config[p.key] = value as ParamConfig;
  }

  const params: Parameter[] = [];
  for (const p of defaults?.props ?? []) {
    const local = pattern?.props.find((x) => x.key === p.key);
    params.push({ key: p.key, local: local ? source.slice(local.value.start, local.value.end) : p.key, value: source.slice(p.value.start, p.value.end), literal: literal(p.node.value) });
  }
  for (const p of pattern?.props ?? []) if (!params.some((x) => x.key === p.key)) params.push({ key: p.key, local: source.slice(p.value.start, p.value.end), value: undefined, literal: undefined });

  const derived = derivedStatements(analysis).map((s): Derived => {
    const d = (s as Extract<Statement, { type: "VariableDeclaration" }>).declarations[0]!;
    const init = d.init!;
    return { name: (d.id as { name: string }).name, statement: { start: s.start, end: s.end }, init: { start: init.start, end: init.end }, text: source.slice(init.start, init.end) };
  });

  return {
    params,
    derived,
    config,
    readOnly: readOnly.length ? readOnly.join("; ") : undefined,
    defaults,
    pattern,
    configObject: configObject && configDecl?.init ? { object: { start: configDecl.init.start, end: configDecl.init.end }, props: configObject } : undefined,
    paramList,
    mainStatement: main?.statement,
    mainBody: analysis.main?.body,
  };
}

/** How often `main` reads `name`. */
export function usesOf(analysis: Analysis, name: string): number {
  let n = 0;
  for (const statement of analysis.main?.statements ?? []) usesIn(statement, new Set([name]), () => n++);
  return n;
}

/** An edit that adds `text` as the last item of a comma-separated list in `container` (braces included), on its own line if the list has its items on lines of their own. */
function appendItem(source: string, container: Span, items: Span[], text: string): Edit {
  const last = items[items.length - 1];
  if (!last) return { start: container.start + 1, end: container.end - 1, text: ` ${text} ` };
  const multiline = source.slice(container.start, items[0]!.start).includes("\n");
  return { start: last.end, end: last.end, text: multiline ? `,\n${indentOf(source, last.start)}${text}` : `, ${text}` };
}

/** Removes an item of a comma-separated list with its separator. */
function removeItem(items: Span[], index: number, container: Span): Edit {
  const item = items[index]!;
  const next = items[index + 1];
  const previous = items[index - 1];
  if (next) return { start: item.start, end: next.start, text: "" };
  if (previous) return { start: previous.end, end: item.end, text: "" };
  return { start: container.start + 1, end: container.end - 1, text: "" };
}

/** Why `name` can't be a new name in the model, if it can't. */
export function nameProblem(analysis: Analysis, p: Parameters, name: string): string | undefined {
  if (!declarable(name)) return `${name} is not a valid name`;
  if (p.params.some((x) => x.key === name || x.local === name) || clashes(analysis, "", name)) return `${name} is already used in the model`;
  return undefined;
}

export type ParamEdit = { edits: Edit[] } | { error: string };

/** Sets parameter `key`'s default to the expression `text`, adding it to `defaultParams` if it has none. */
export function setDefault(source: string, p: Parameters, key: string, text: string): ParamEdit {
  if (p.readOnly) return { error: p.readOnly };
  const prop = p.defaults?.props.find((x) => x.key === key);
  if (prop) return { edits: [{ ...prop.value, text }] };
  return { edits: [defaultsEdit(source, p, `${key}: ${text}`)] };
}

/** Adds the property `text` to `defaultParams`, creating it before `main` if the model has none. */
function defaultsEdit(source: string, p: Parameters, text: string): Edit {
  if (p.defaults) return appendItem(source, p.defaults.object, p.defaults.props.map((x) => x.span), text);
  const at = p.mainStatement ? lines(source, p.mainStatement).start : 0;
  return { start: at, end: at, text: `export const defaultParams = { ${text} };\n\n` };
}

/** Adds parameter `key` with the default `text`: to `defaultParams` and to what `main` destructures. */
export function addParam(source: string, analysis: Analysis, p: Parameters, key: string, text: string): ParamEdit {
  if (p.readOnly) return { error: p.readOnly };
  const why = nameProblem(analysis, p, key);
  if (why) return { error: why };
  const edits = [defaultsEdit(source, p, `${key}: ${text}`)];
  if (p.pattern) edits.push(appendItem(source, p.pattern.object, p.pattern.props.map((x) => x.span), key));
  else if (p.paramList) edits.push({ start: p.paramList.start + 1, end: p.paramList.end - 1, text: `{ ${key} }` });
  else return { error: "main has no parameter list" };
  return { edits };
}

/** Renames parameter `from`: its key in `defaultParams`, `main`'s pattern and `paramConfig`, and its uses in `main` if `main` reads it by its key. */
export function renameParam(analysis: Analysis, p: Parameters, from: string, to: string): ParamEdit {
  if (p.readOnly) return { error: p.readOnly };
  if (from === to) return { edits: [] };
  const param = p.params.find((x) => x.key === from);
  if (!param) return { error: `there is no parameter ${from}` };
  const why = nameProblem(analysis, p, to);
  if (why) return { error: why };
  const edits: Edit[] = [];
  const defaultsProp = p.defaults?.props.find((x) => x.key === from);
  if (defaultsProp) edits.push({ ...defaultsProp.keySpan, text: to });
  const configProp = p.configObject?.props.find((x) => x.key === from);
  if (configProp) edits.push({ ...configProp.keySpan, text: to });
  const patternProp = p.pattern?.props.find((x) => x.key === from);
  if (patternProp && !patternProp.node.shorthand) edits.push({ ...patternProp.keySpan, text: to });
  else if (patternProp) {
    // Read by its key: the variable is renamed with it.
    edits.push({ ...patternProp.span, text: to });
    for (const statement of analysis.main?.statements ?? []) {
      usesIn(statement, new Set([from]), (id, ancestors) => {
        const parent = ancestors[ancestors.length - 1];
        edits.push(parent?.type === "Property" && parent.value === id ? renameProperty(parent, to) : replaceIdentifier(id, to, undefined));
      });
    }
  }
  return { edits };
}

/** Removes parameter `key`, which `main` must not use. */
export function removeParam(analysis: Analysis, p: Parameters, key: string): ParamEdit {
  if (p.readOnly) return { error: p.readOnly };
  const param = p.params.find((x) => x.key === key);
  if (!param) return { error: `there is no parameter ${key}` };
  const uses = usesOf(analysis, param.local);
  if (uses > 0) return { error: `${key} is used ${uses === 1 ? "once" : `${uses} times`} in the model` };
  const edits: Edit[] = [];
  for (const list of [p.defaults, p.pattern, p.configObject]) {
    const index = list?.props.findIndex((x) => x.key === key) ?? -1;
    if (list && index >= 0) edits.push(removeItem(list.props.map((x) => x.span), index, list.object));
  }
  return { edits };
}

/** Adds the derived parameter `const name = text;` after the others, at the start of `main`. */
export function addDerived(source: string, analysis: Analysis, p: Parameters, name: string, text: string): ParamEdit {
  const why = nameProblem(analysis, p, name);
  if (why) return { error: why };
  const last = p.derived[p.derived.length - 1];
  if (last) return { edits: [{ start: last.statement.end, end: last.statement.end, text: `\n${indentOf(source, last.statement.start)}const ${name} = ${text};` }] };
  const first = analysis.main?.statements[0];
  if (first) return { edits: [{ start: first.start, end: first.start, text: `const ${name} = ${text};\n${indentOf(source, first.start)}` }] };
  if (!p.mainBody) return { error: "the model has no main function" };
  return { edits: [{ start: p.mainBody.start + 1, end: p.mainBody.start + 1, text: `\n  const ${name} = ${text};\n` }] };
}

export function setDerived(d: Derived, text: string): Edit[] {
  return [{ ...d.init, text }];
}

/** Renames derived parameter `from` and its uses. */
export function renameDerived(analysis: Analysis, p: Parameters, from: string, to: string): ParamEdit {
  if (from === to) return { edits: [] };
  const d = p.derived.find((x) => x.name === from);
  if (!d) return { error: `there is no derived parameter ${from}` };
  const why = nameProblem(analysis, p, to);
  if (why) return { error: why };
  const statement = analysis.main?.statements.find((s) => s.start === d.statement.start) as Extract<Statement, { type: "VariableDeclaration" }> | undefined;
  const id = statement?.declarations[0]?.id;
  if (!id) return { error: `there is no derived parameter ${from}` };
  const edits: Edit[] = [{ start: id.start, end: id.end, text: to }];
  for (const s of analysis.main?.statements ?? []) {
    usesIn(s, new Set([from]), (use, ancestors) => {
      const parent = ancestors[ancestors.length - 1];
      edits.push(parent?.type === "Property" && parent.value === use ? renameProperty(parent, to) : replaceIdentifier(use, to, undefined));
    });
  }
  return { edits };
}

/** Removes derived parameter `name`, which `main` must not use. */
export function removeDerived(source: string, analysis: Analysis, p: Parameters, name: string): ParamEdit {
  const d = p.derived.find((x) => x.name === name);
  if (!d) return { error: `there is no derived parameter ${name}` };
  const uses = usesOf(analysis, name);
  if (uses > 0) return { error: `${name} is used ${uses === 1 ? "once" : `${uses} times`} in the model` };
  return { edits: [{ ...lines(source, d.statement), text: "" }] };
}

/** A parameter's quantity, as far as its uses tell: a length if it goes into a length, a profile or a plane, a number into a number. */
export type Quantity = "length" | "number";

/**
 * Infers each parameter's and derived parameter's quantity from the feature arguments it is used in
 * (research/17, "Kinds, units, ranges"); a derived parameter passes its quantity on to the names
 * its expression uses. A name used as both stays a plain number.
 */
export function quantities(analysis: Analysis, p: Parameters): Map<string, Quantity> {
  const names = new Set([...p.params.map((x) => x.local), ...p.derived.map((d) => d.name)]);
  const found = new Map<string, Set<Quantity>>();
  const note = (node: AnyNode, quantity: Quantity) => {
    const visit = (n: AnyNode) => {
      usesIn(n, names, (id) => {
        const set = found.get(id.name) ?? new Set<Quantity>();
        set.add(quantity);
        found.set(id.name, set);
      });
    };
    visit(node);
  };
  for (const call of analysis.calls) {
    const specs = (schemas as Record<string, { params: Record<string, ParamSpec> }>)[call.type]?.params ?? {};
    for (const prop of call.props ?? []) {
      const kind = specs[prop.key]?.kind;
      if (kind === "length" || kind === "profile" || kind === "plane") note(prop.node, "length");
      else if (kind === "number") note(prop.node, "number");
    }
  }
  // Backwards through the derived parameters: one's quantity is that of what it is computed from.
  for (const d of [...p.derived].reverse()) {
    const own = found.get(d.name);
    if (!own) continue;
    const statement = analysis.main?.statements.find((s) => s.start === d.statement.start);
    const init = statement?.type === "VariableDeclaration" ? statement.declarations[0]?.init : undefined;
    if (init) for (const q of own) note(init, q);
  }
  const out = new Map<string, Quantity>();
  for (const [name, set] of found) out.set(name, set.size === 1 ? [...set][0]! : "number");
  return out;
}

/** The unit a quantity has in every model: lengths are millimetres (research/17, "Kinds, units, ranges"). */
export const unitOf = (q: Quantity | undefined): string | undefined => (q === "length" ? "mm" : undefined);
