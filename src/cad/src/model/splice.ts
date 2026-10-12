/**
 * GUI edits as minimal text splices (research/02, "GUI edits work because the API has a fixed
 * shape"): each edit replaces only the source span it changes, so it merges with concurrent typing
 * and keeps formatting and comments.
 */
import { splice } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { AnyNode, ArrayExpression, Expression, Program } from "acorn";
import type { CadModelDoc } from "../types.ts";
import { FEATURES_MODULE, type Analysis, type FeatureCall, type Prop, type Span } from "./analyze.ts";
import type { FeatureEntry, Timeline } from "./timeline.ts";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits computed against the current source, in one change. */
export function apply(handle: DocHandle<CadModelDoc>, edits: Edit[]): void {
  if (edits.length === 0) return;
  handle.change((doc) => {
    for (const e of [...edits].sort((a, b) => b.start - a.start)) splice(doc, ["source"], e.start, e.end - e.start, e.text);
  });
}

const prop = (call: FeatureCall, key: string): Prop | undefined => call.props?.find((p) => p.key === key);

/** Sets property `key` of a feature call's object to the expression `text`. */
export function setProp(call: FeatureCall, key: string, text: string): Edit[] {
  const existing = prop(call, key);
  if (existing) return [{ ...existing.value, text }];
  if (!call.object) return [];
  const last = call.props?.[call.props.length - 1];
  return last ? [{ start: last.span.end, end: last.span.end, text: `, ${key}: ${text}` }] : [{ start: call.object.start + 1, end: call.object.start + 1, text: ` ${key}: ${text} ` }];
}

/** Removes an element of a comma-separated list (properties, array elements), with its separator. */
function removeFromList(items: Span[], index: number, container: Span): Edit {
  const item = items[index]!;
  const next = items[index + 1];
  const previous = items[index - 1];
  if (next) return { start: item.start, end: next.start, text: "" };
  if (previous) return { start: previous.end, end: item.end, text: "" };
  return { start: container.start + 1, end: container.end - 1, text: "" };
}

export function removeProp(call: FeatureCall, key: string): Edit[] {
  const props = call.props ?? [];
  const index = props.findIndex((p) => p.key === key);
  if (index < 0 || !call.object) return [];
  return [removeFromList(props.map((p) => p.span), index, call.object)];
}

const arrayOf = (call: FeatureCall, key: string): ArrayExpression | undefined => {
  const node = prop(call, key)?.node;
  return node?.type === "ArrayExpression" ? node : undefined;
};

/** The source spans of the elements of an array property. */
export function elements(call: FeatureCall, key: string): Span[] {
  return (arrayOf(call, key)?.elements ?? []).flatMap((e) => (e && e.type !== "SpreadElement" ? [{ start: e.start, end: e.end }] : []));
}

/** Appends an element to an array property, creating the property if needed. */
export function appendElement(call: FeatureCall, key: string, text: string): Edit[] {
  const array = arrayOf(call, key);
  if (!array) return setProp(call, key, `[${text}]`);
  const items = elements(call, key);
  const last = items[items.length - 1];
  return last ? [{ start: last.end, end: last.end, text: `, ${text}` }] : [{ start: array.start + 1, end: array.start + 1, text }];
}

export function removeElement(call: FeatureCall, key: string, index: number): Edit[] {
  const array = arrayOf(call, key);
  if (!array) return [];
  return [removeFromList(elements(call, key), index, array)];
}

export function replaceElement(call: FeatureCall, key: string, index: number, text: string): Edit[] {
  const item = elements(call, key)[index];
  return item ? [{ ...item, text }] : [];
}

/** Identifiers of the given names that are used but not imported, as one import edit. */
export function ensureImports(analysis: Analysis, names: readonly string[]): Edit[] {
  const missing = names.filter((n) => !analysis.imports.has(n));
  if (missing.length === 0) return [];
  const declaration = analysis.program.body.find((n) => n.type === "ImportDeclaration" && n.source.value === FEATURES_MODULE);
  if (declaration?.type === "ImportDeclaration") {
    const last = declaration.specifiers[declaration.specifiers.length - 1];
    if (last) return [{ start: last.end, end: last.end, text: `, ${missing.join(", ")}` }];
  }
  return [{ start: 0, end: 0, text: `import { ${missing.join(", ")} } from "${FEATURES_MODULE}";\n` }];
}

/** Library functions a piece of generated code calls, so that they can be imported. */
export const usedFunctions = (code: string): string[] =>
  ["sketch", "extrude", "fillet", "chamfer", "plane", "rect", "circle", "polygon", "edge", "any", "ref"].filter((f) => new RegExp(`(^|[^.\\w$])${f}\\b`).test(code));

function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** The identifiers a `return` returns: `return extrude2` or `return [a, b]`. */
function returnedNames(analysis: Analysis): { node: Expression; names: string[] } | undefined {
  const statement = analysis.main?.statements.at(-1);
  if (statement?.type !== "ReturnStatement" || !statement.argument) return undefined;
  const arg = statement.argument;
  if (arg.type === "Identifier") return { node: arg, names: [arg.name] };
  if (arg.type === "ArrayExpression" && arg.elements.every((e) => e?.type === "Identifier")) return { node: arg, names: arg.elements.map((e) => (e as { name: string }).name) };
  return undefined;
}

/** The variables `main` returns, i.e. the visible bodies. */
export const returnedVariables = (analysis: Analysis): string[] => returnedNames(analysis)?.names ?? [];

const printReturn = (names: string[]) => (names.length === 1 ? names[0]! : `[${names.join(", ")}]`);

/**
 * Inserts `const name = code;` as the last feature of `main`, before its `return`. If the feature
 * consumes a returned body (`consumes`), the return shows the new one instead; a new body is
 * added to it.
 */
export function insertFeature(source: string, analysis: Analysis, name: string, code: string, effect: { consumes?: string; body: boolean }): Edit[] {
  if (!analysis.main) return [];
  const edits: Edit[] = [...ensureImports(analysis, usedFunctions(code))];
  const ret = analysis.main.statements.at(-1);
  const statement = `const ${name} = ${code};`;
  if (ret?.type === "ReturnStatement") {
    edits.push({ start: ret.start, end: ret.start, text: `${statement}\n${indentOf(source, ret.start)}` });
    const returned = returnedNames(analysis);
    if (effect.body && returned) {
      const names = effect.consumes && returned.names.includes(effect.consumes) ? returned.names.map((n) => (n === effect.consumes ? name : n)) : [...returned.names, name];
      edits.push({ start: returned.node.start, end: returned.node.end, text: printReturn(names) });
    }
  } else {
    const indent = analysis.main.statements[0] ? indentOf(source, analysis.main.statements[0].start) : "  ";
    const close = analysis.main.body.end - 1;
    edits.push({ start: close, end: close, text: `${indent}${statement}\n${effect.body ? `${indent}return ${name};\n` : ""}` });
  }
  return edits;
}

function walk(node: AnyNode, visit: (node: AnyNode, ancestors: AnyNode[]) => void, ancestors: AnyNode[] = []): void {
  visit(node, ancestors);
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) if (child && typeof child === "object" && typeof (child as AnyNode).type === "string") walk(child as AnyNode, visit, [...ancestors, node]);
  }
}

/** The input body of a feature: what its consumers should use when it is deleted. */
function inputOf(source: string, call: FeatureCall): string | undefined {
  const p = prop(call, "body") ?? prop(call, "target");
  return p ? source.slice(p.value.start, p.value.end) : undefined;
}

/**
 * Deletes a feature statement. Features that used its body (`body:`, `target:`) and the return use
 * its input instead; references that named it (`notch.side.c`, `.piece(notch, 1)`) name it through
 * `ref.notch`, so that they report themselves as broken instead of throwing a ReferenceError.
 */
export function deleteFeature(source: string, analysis: Analysis, entry: FeatureEntry): Edit[] {
  const lineStart = source.lastIndexOf("\n", entry.span.start - 1) + 1;
  const lineEnd = source.indexOf("\n", entry.span.end);
  const edits: Edit[] = [{ start: lineStart, end: lineEnd < 0 ? entry.span.end : lineEnd + 1, text: "" }];
  const input = inputOf(source, entry.call);
  walk(analysis.program as Program, (node, ancestors) => {
    if (node.type !== "Identifier" || node.name !== entry.name || node.start < entry.span.end) return;
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;
    const asValue = parent?.type === "Property" && parent.value === node && ["body", "target"].includes(parent.key.type === "Identifier" ? parent.key.name : "");
    const inReturn = ancestors.some((a) => a.type === "ReturnStatement");
    if (asValue || inReturn) {
      if (input) edits.push({ start: node.start, end: node.end, text: input });
    } else edits.push({ start: node.start, end: node.end, text: `ref.${entry.name}` });
  });
  if (edits.some((e) => e.text.startsWith("ref."))) edits.push(...ensureImports(analysis, ["ref"]));
  return edits;
}

/** A variable name for a new feature that is not used anywhere in the source yet. */
export function freshName(source: string, base: string): string {
  for (let n = 1; ; n++) if (!new RegExp(`\\b${base}${n}\\b`).test(source)) return `${base}${n}`;
}

/** The variable of the last feature entry that produces a body or a sketch, for defaults of new features. */
export function lastOf(tl: Timeline, kind: "sketch" | "body"): string | undefined {
  return tl.entries.filter((e): e is FeatureEntry => e.kind === "feature" && (kind === "sketch" ? e.type === "sketch" : e.type !== "sketch")).at(-1)?.name;
}

/** Whether a feature call other than `except` uses the body `name` as its `body` or `target`. */
function consumedBy(analysis: Analysis, name: string, except: FeatureCall): boolean {
  return analysis.calls.some(
    (c) => c.span.start !== except.span.start && (c.props ?? []).some((p) => (p.key === "body" || p.key === "target") && p.node.type === "Identifier" && p.node.name === name),
  );
}

/**
 * Keeps the return in step when feature `name` (`call`) switches its `body` or `target` from
 * `previous` to `next`: it replaces `next` in the result, and `previous`, if nothing else uses it
 * any more, comes back into the result instead of being silently dropped.
 */
export function retarget(analysis: Analysis, call: FeatureCall, name: string, previous: string | undefined, next: string | undefined): Edit[] {
  const returned = returnedNames(analysis);
  if (!returned) return [];
  let names = [...returned.names];
  if (next && names.includes(next)) names = names.includes(name) ? names.filter((n) => n !== next) : names.map((n) => (n === next ? name : n));
  if (previous && previous !== next && !names.includes(previous) && !consumedBy(analysis, previous, call)) names.push(previous);
  if (names.join() === returned.names.join()) return [];
  return [{ start: returned.node.start, end: returned.node.end, text: printReturn(names) }];
}

/** Adds a feature's result to what `main` returns. */
export function addToReturn(source: string, analysis: Analysis, name: string): Edit[] {
  const returned = returnedNames(analysis);
  if (returned) return returned.names.includes(name) ? [] : [{ start: returned.node.start, end: returned.node.end, text: printReturn([...returned.names, name]) }];
  if (!analysis.main) return [];
  const statement = analysis.main.statements.at(-1);
  const indent = statement ? indentOf(source, statement.start) : "  ";
  const close = analysis.main.body.end - 1;
  return [{ start: close, end: close, text: `${indent}return ${name};\n` }];
}
