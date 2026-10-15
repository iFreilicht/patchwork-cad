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
import { graph, inputOf as consumedInput, type Graph } from "./deps.ts";
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

/** The whole lines a span covers, with the line break after them. */
function lines(source: string, span: Span): Span {
  const lineEnd = source.indexOf("\n", span.end);
  return { start: source.lastIndexOf("\n", span.start - 1) + 1, end: lineEnd < 0 ? span.end : lineEnd + 1 };
}

/** Replaces an identifier; a shorthand property (`{ body }`) keeps its key (`{ body: fillet1 }`). */
const replaceIdentifier = (span: Span, text: string, shorthand: string | undefined): Edit => ({ start: span.start, end: span.end, text: shorthand ? `${shorthand}: ${text}` : text });

/**
 * Deletes a feature statement. Features that used its body (`body:`, `target:`) and the return use
 * its input instead; references that named it (`notch.side.c`, `.piece(notch, 1)`) name it through
 * `ref.notch`, so that they report themselves as broken instead of throwing a ReferenceError.
 */
export function deleteFeature(source: string, analysis: Analysis, entry: FeatureEntry): Edit[] {
  const edits: Edit[] = [{ ...lines(source, entry.span), text: "" }];
  const input = inputOf(source, entry.call);
  walk(analysis.program as Program, (node, ancestors) => {
    if (node.type !== "Identifier" || node.name !== entry.name || node.start < entry.span.end) return;
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;
    const key = parent?.type === "Property" && parent.value === node && parent.key.type === "Identifier" ? parent.key.name : undefined;
    const shorthand = parent?.type === "Property" && parent.shorthand ? key : undefined;
    const asValue = key === "body" || key === "target";
    const inReturn = ancestors.some((a) => a.type === "ReturnStatement");
    if (asValue || inReturn) {
      if (input) edits.push(replaceIdentifier(node, input, shorthand));
    } else edits.push(replaceIdentifier(node, `ref.${entry.name}`, shorthand));
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

/** Where code goes that is inserted before entry `position`: the start of its line, or of the return's line at the end. */
function insertionPoint(source: string, analysis: Analysis, tl: Timeline, position: number): number | undefined {
  const entry = tl.entries[position];
  if (entry) return lines(source, entry.span).start;
  if (tl.returned) return lines(source, tl.returned).start;
  return analysis.main ? lines(source, { start: analysis.main.body.end - 1, end: analysis.main.body.end - 1 }).start : undefined;
}

/** The current name of every use, edited as a move or an insert rewires the chain of bodies. */
type Names = string[];

/** The edits that rename uses whose name changed, except those in `skip`. */
const renames = (g: Graph, names: Names, skip: Span | undefined): Edit[] =>
  g.uses.flatMap((u, k) => (names[k] !== u.name && !(skip && u.span.start >= skip.start && u.span.end <= skip.end) ? [replaceIdentifier(u.span, names[k]!, u.shorthand)] : []));

/**
 * Inserts `const name = code;` before entry `position` (research/07, "The timeline marker"). A
 * feature that consumes a body (`effect.consumes`) is inserted into its chain, as in Fusion: every
 * later feature and the return that used that version of the body use the new feature instead.
 * At the end, it is `insertFeature`.
 */
export function insertFeatureAt(source: string, analysis: Analysis, tl: Timeline, name: string, code: string, position: number, effect: { consumes?: string; body: boolean }): Edit[] {
  if (position >= tl.entries.length) return insertFeature(source, analysis, name, code, effect);
  const at = insertionPoint(source, analysis, tl, position);
  if (at === undefined) return [];
  const g = graph(analysis, tl);
  const edits: Edit[] = [...ensureImports(analysis, usedFunctions(code)), { start: at, end: at, text: `${indentOf(source, tl.entries[position]!.span.start)}const ${name} = ${code};\n` }];
  if (effect.consumes) {
    const names = g.uses.map((u) => (u.name === effect.consumes && u.role !== "hard" && u.owner >= position ? name : u.name));
    edits.push(...renames(g, names, undefined));
  } else if (effect.body) edits.push(...addToReturn(source, analysis, name));
  return edits;
}

/**
 * Moves entry `index` before entry `position` (`entries.length`: before the return) as one change.
 * A feature moves Fusion-style (research/07, "Reordering"): first it leaves its chain of bodies, so
 * whatever used its result uses its input; then it joins the chain at the new place, working on the
 * version of its body there, and whatever used that version later uses its result instead. A
 * sketch's body becomes the version at the new place. Custom Script code moves as it is. The caller
 * checks the move with `canMove` (deps.ts).
 */
export function moveEntry(source: string, analysis: Analysis, tl: Timeline, index: number, position: number): Edit[] {
  const entry = tl.entries[index];
  const at = insertionPoint(source, analysis, tl, position);
  if (!entry || at === undefined || position === index || position === index + 1) return [];
  const g = graph(analysis, tl);
  const n = tl.entries.length;
  const order = [...Array(n).keys()].filter((i) => i !== index);
  order.splice(position > index ? position - 1 : position, 0, index);
  const pos = (owner: number) => (owner >= n ? n : order.indexOf(owner));
  const here = pos(index);
  const names: Names = g.uses.map((u) => u.name);
  const used = (k: number) => g.uses[k]!;

  /** The input of the feature that declares `name`, under the current renames. */
  const inputName = (name: string) => {
    const d = g.declaredBy.get(name);
    const input = d === undefined ? undefined : consumedInput(g, d);
    return input ? names[g.uses.indexOf(input)] : undefined;
  };
  /** The version of the chain of body `name` that is current at the moved entry's new place. */
  const versionHere = (name: string): string | undefined => {
    let version: string | undefined = name;
    for (let guard = 0; version !== undefined && pos(g.declaredBy.get(version) ?? -1) > here && guard < n; guard++) version = inputName(version);
    if (version === undefined) return undefined;
    for (let guard = 0; guard < n; guard++) {
      const next = g.uses.findIndex((u, k) => u.role === "consume" && names[k] === version && u.owner !== index && u.owner < n && pos(u.owner) < here);
      if (next < 0) break;
      version = g.declares[used(next).owner]![0]!;
    }
    return version;
  };

  if (entry.kind === "feature") {
    const own = g.declares[index]![0]!;
    const inputUse = g.uses.findIndex((u) => u.owner === index && u.role === "consume");
    const readUse = g.uses.findIndex((u) => u.owner === index && u.role === "read");
    if (inputUse >= 0) {
      const input = names[inputUse]!;
      names.forEach((name, k) => {
        if (name === own && used(k).owner !== index && used(k).role !== "hard") names[k] = input;
      });
      const version = versionHere(input);
      if (version === undefined) return [];
      names[inputUse] = version;
      names.forEach((name, k) => {
        const u = used(k);
        if (k !== inputUse && name === version && u.role !== "hard" && u.owner !== index && pos(u.owner) > here) names[k] = own;
      });
    }
    if (readUse >= 0) {
      const version = versionHere(names[readUse]!);
      if (version === undefined) return [];
      names[readUse] = version;
    }
  }

  const range = lines(source, entry.span);
  const inside = renames(g, names, undefined).filter((e) => e.start >= range.start && e.end <= range.end);
  let moved = source.slice(range.start, range.end);
  for (const e of inside.sort((a, b) => b.start - a.start)) moved = moved.slice(0, e.start - range.start) + e.text + moved.slice(e.end - range.start);
  if (!moved.endsWith("\n")) moved += "\n";
  return [{ ...range, text: "" }, { start: at, end: at, text: moved }, ...renames(g, names, range)];
}
