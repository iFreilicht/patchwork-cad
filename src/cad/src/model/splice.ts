/**
 * GUI edits as minimal text splices (research/02, "GUI edits work because the API has a fixed
 * shape"): each edit replaces only the source span it changes, so it merges with concurrent typing
 * and keeps formatting and comments.
 */
import { splice } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { AnyNode, ArrayExpression, Expression, Program } from "acorn";
import type { CadModelDoc } from "../types.ts";
import { FEATURES_MODULE, returnedOutputs, type Analysis, type FeatureCall, type Output, type Prop, type Span } from "./analyze.ts";
import { graph, inputOf as consumedInput, type Graph, type Use } from "./deps.ts";
import { lanes } from "./lanes.ts";
import { timeline, type FeatureEntry, type Timeline } from "./timeline.ts";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The text after non-overlapping edits computed against `source`. */
export function applyToText(source: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), source);
}

/** Applies non-overlapping edits computed against the current source, in one change. */
export function apply(handle: DocHandle<CadModelDoc>, edits: Edit[]): void {
  if (edits.length === 0) return;
  handle.change((doc) => {
    for (const e of [...edits].sort((a, b) => b.start - a.start)) splice(doc, ["content"], e.start, e.end - e.start, e.text);
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
  ["sketch", "extrude", "fillet", "chamfer", "combine", "move", "plane", "rect", "circle", "polygon", "edge", "any", "ref"].filter((f) => new RegExp(`(^|[^.\\w$])${f}\\b`).test(code));

export function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** What `main` returns, as the editor edits it: a version by its variable, under its key; one it adds has none yet. */
export type Out = Pick<Output, "name"> & { key: string | undefined };

/** The variables `main` returns, i.e. the visible bodies. */
export const returnedVariables = (analysis: Analysis): string[] => returnedOutputs(analysis)?.outputs.map((o) => o.name) ?? [];

const has = (outs: Out[], name: string) => outs.some((o) => o.name === name);
const without = (outs: Out[], name: string | undefined) => outs.filter((o) => o.name !== name);
/** Adds a version under `key`, or else its variable's name, unless it is returned already. */
const withName = (outs: Out[], name: string, key?: string): Out[] => (has(outs, name) ? outs : [...outs, { key: key !== undefined && !outs.some((o) => o.key === key) ? key : undefined, name }]);

/**
 * The name of the body that version `name` is the head of (research/15, "Bodies and lineages"), if
 * it isn't the version's: the key a version gets when the editor returns it, so that returning a
 * body doesn't rename it.
 */
function bodyName(analysis: Analysis, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  // Lanes don't need the source, which only gives Custom Scripts their lines.
  const tl = timeline("", analysis, []);
  const l = lanes(tl, graph(analysis, tl));
  const lane = l.lanes[l.laneOf.get(name) ?? -1];
  return lane && !lane.output && lane.versions.at(-1)?.name === name && lane.name !== name ? lane.name : undefined;
}
/** Returns `to` where `from` was, under the same key; a version once, under its first key. */
const rewire = (outs: Out[], from: string, to: string): Out[] => outs.map((o) => (o.name === from ? { ...o, name: to } : o)).filter((o, i, all) => all.findIndex((p) => p.name === o.name) === i);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The keys outputs are returned under: their own, or else their variable's, numbered if another
 * output has that key already (research/15, "Output").
 */
export function outputKeys(outs: Out[]): string[] {
  const taken = new Set(outs.flatMap((o) => (o.key === undefined ? [] : [o.key])));
  return outs.map((o) => {
    if (o.key !== undefined) return o.key;
    let key = o.name;
    for (let n = 2; taken.has(key); n++) key = `${o.name}_${n}`;
    taken.add(key);
    return key;
  });
}

/** `{ plate: notched, lid }`: an output whose key is its variable's name is shorthand. */
export function printReturn(outs: Out[]): string {
  const keys = outputKeys(outs);
  const props = outs.map((o, i) => (keys[i] === o.name ? o.name : `${IDENTIFIER.test(keys[i]!) ? keys[i] : JSON.stringify(keys[i])}: ${o.name}`));
  return props.length === 0 ? "{}" : `{ ${props.join(", ")} }`;
}

/**
 * What a new feature does to the result: its body or sketch shows (`shows`), in place of the body it
 * consumes (`consumes`) or the sketch it uses (`hides`), which no longer shows, as in Fusion.
 */
export interface InsertEffect {
  shows: boolean;
  consumes?: string;
  hides?: string;
}

/**
 * What a return shows after inserting feature `name`: in place of what it replaces, under its key.
 * A sketch returned under its own name, `{ sketch2 }`, has no key of its own: the body made of it
 * goes under the body's name.
 */
function showing(analysis: Analysis, outs: Out[], name: string, effect: InsertEffect): Out[] {
  const replaced = [effect.consumes, effect.hides].find((n) => n !== undefined && has(outs, n));
  const own = (o: Out) => o.name === effect.hides && (o.key === undefined || o.key === o.name);
  const unkeyed = outs.map((o) => (own(o) ? { key: undefined, name: o.name } : o));
  const shown = !effect.shows ? outs : replaced ? rewire(unkeyed, replaced, name) : withName(outs, name, bodyName(analysis, effect.consumes));
  return without(shown, effect.hides);
}

/** Rewrites what `main` returns as an object, if it changes; a return that no edit changes keeps its form. */
export function setReturned(returned: { node: Expression; outputs: Out[] }, outs: Out[]): Edit[] {
  const same = outs.length === returned.outputs.length && outs.every((o, i) => o.name === returned.outputs[i]!.name && o.key === returned.outputs[i]!.key);
  return same ? [] : [{ start: returned.node.start, end: returned.node.end, text: printReturn(outs) }];
}

/** Inserts `const name = code;` as the last feature of `main`, before its `return`, which changes by `effect`. */
export function insertFeature(source: string, analysis: Analysis, name: string, code: string, effect: InsertEffect): Edit[] {
  if (!analysis.main) return [];
  const edits: Edit[] = [...ensureImports(analysis, usedFunctions(code))];
  const ret = analysis.main.statements.at(-1);
  const statement = `const ${name} = ${code};`;
  if (ret?.type === "ReturnStatement") {
    edits.push({ start: ret.start, end: ret.start, text: `${statement}\n${indentOf(source, ret.start)}` });
    const returned = returnedOutputs(analysis);
    if (returned) edits.push(...setReturned(returned, showing(analysis, returned.outputs, name, effect)));
  } else {
    const indent = analysis.main.statements[0] ? indentOf(source, analysis.main.statements[0].start) : "  ";
    const close = analysis.main.body.end - 1;
    edits.push({ start: close, end: close, text: `${indent}${statement}\n${effect.shows ? `${indent}return ${printReturn([{ key: undefined, name }])};\n` : ""}` });
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
export function lines(source: string, span: Span): Span {
  const lineEnd = source.indexOf("\n", span.end);
  return { start: source.lastIndexOf("\n", span.start - 1) + 1, end: lineEnd < 0 ? span.end : lineEnd + 1 };
}

/** Replaces an identifier; a shorthand property (`{ body }`) keeps its key (`{ body: fillet1 }`). */
export const replaceIdentifier = (span: Span, text: string, shorthand: string | undefined): Edit => ({ start: span.start, end: span.end, text: shorthand ? `${shorthand}: ${text}` : text });

/**
 * Deletes a feature statement. Features that used its body (`body:`, `target:`, `tools:`) and the
 * return use its input instead; references that named it (`notch.side.c`, `.piece(notch, 1)`) name
 * it through `ref.notch`, so that they report themselves as broken instead of throwing a
 * ReferenceError. Its sketch, and a combine's tools, show again if nothing else uses them.
 */
export function deleteFeature(source: string, analysis: Analysis, entry: FeatureEntry): Edit[] {
  const edits: Edit[] = [{ ...lines(source, entry.span), text: "" }];
  // A sketch's body is the one its plane lies on, not an input it passes on.
  const input = entry.type === "sketch" ? undefined : inputOf(source, entry.call);
  const returned = returnedOutputs(analysis);
  if (returned) {
    // Its input takes its place under its key; without one (a new extrude, a body(), a sketch), its results leave the result.
    let outs: Out[] = returned.outputs;
    for (const n of entry.names) outs = input ? rewire(outs, n, input) : without(outs, n);
    const sketch = prop(entry.call, "sketch")?.node;
    if (sketch?.type === "Identifier" && !has(outs, sketch.name) && !usesSketch(analysis, sketch.name, entry.call)) outs = withName(outs, sketch.name, bodyName(analysis, sketch.name));
    for (const e of arrayOf(entry.call, "tools")?.elements ?? []) if (e?.type === "Identifier" && !has(outs, e.name) && !consumedBy(analysis, e.name, entry.call)) outs = withName(outs, e.name, bodyName(analysis, e.name));
    edits.push(...setReturned(returned, outs));
  }
  walk(analysis.program as Program, (node, ancestors) => {
    if (node.type !== "Identifier" || !entry.names.includes(node.name) || node.start < entry.span.end) return;
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;
    const key = parent?.type === "Property" && parent.value === node && parent.key.type === "Identifier" ? parent.key.name : undefined;
    const shorthand = parent?.type === "Property" && parent.shorthand ? key : undefined;
    const property = ancestors[ancestors.length - 2];
    const asTool = parent?.type === "ArrayExpression" && property?.type === "Property" && property.value === parent && property.key.type === "Identifier" && property.key.name === "tools";
    const asValue = key === "body" || key === "target" || asTool;
    const inReturn = ancestors.some((a) => a.type === "ReturnStatement");
    if (inReturn && returned) return;
    // Users get its input; without one, `ref.<name>`, which fails the user alone instead of throwing a ReferenceError.
    if ((asValue || inReturn) && input) edits.push(replaceIdentifier(node, input, shorthand));
    else edits.push(replaceIdentifier(node, `ref.${node.name}`, shorthand));
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

/** Whether a feature call other than `except` uses the body `name` as its `body` or `target`, or as one of its `tools`. */
function consumedBy(analysis: Analysis, name: string, except: FeatureCall): boolean {
  const names = (p: Prop) => (p.key === "body" || p.key === "target" ? [p.node] : p.key === "tools" && p.node.type === "ArrayExpression" ? p.node.elements : []);
  return analysis.calls.some((c) => c.span.start !== except.span.start && (c.props ?? []).some((p) => names(p).some((n) => n?.type === "Identifier" && n.name === name)));
}

/** Whether a feature call other than `except` uses the sketch `name`. */
function usesSketch(analysis: Analysis, name: string, except: FeatureCall): boolean {
  return analysis.calls.some((c) => c.span.start !== except.span.start && (c.props ?? []).some((p) => p.key === "sketch" && p.node.type === "Identifier" && p.node.name === name));
}

/**
 * Keeps the return in step when a feature (`call`) switches its sketch from `previous` to `next`:
 * `next` no longer shows, and `previous`, if nothing else uses it, shows again.
 */
export function resketch(analysis: Analysis, call: FeatureCall, previous: string | undefined, next: string | undefined): Edit[] {
  const returned = returnedOutputs(analysis);
  if (!returned) return [];
  let outs = without(returned.outputs, next);
  if (previous && previous !== next && !has(outs, previous) && !usesSketch(analysis, previous, call)) outs = withName(outs, previous, bodyName(analysis, previous));
  return setReturned(returned, outs);
}

/**
 * Keeps the return in step when feature `name` (`call`) switches its `body` or `target` from
 * `previous` to `next`: it replaces `next` in the result, and `previous`, if nothing else uses it
 * any more, comes back into the result instead of being silently dropped.
 */
export function retarget(analysis: Analysis, call: FeatureCall, name: string, previous: string | undefined, next: string | undefined): Edit[] {
  const returned = returnedOutputs(analysis);
  if (!returned) return [];
  let outs: Out[] = returned.outputs;
  // It stands for `next` now; returned already, it keeps the first of the two keys.
  if (next && has(outs, next)) outs = rewire(outs, next, name);
  if (previous && previous !== next && !has(outs, previous) && !consumedBy(analysis, previous, call)) outs = withName(outs, previous, bodyName(analysis, previous));
  return setReturned(returned, outs);
}

/**
 * Keeps the return in step when a combine (`call`) gets tool `added` or loses tool `removed`: a
 * tool no longer shows on its own, and a removed one, if nothing else uses it, shows again.
 */
export function retool(analysis: Analysis, call: FeatureCall, added: string | undefined, removed: string | undefined): Edit[] {
  const returned = returnedOutputs(analysis);
  if (!returned) return [];
  let outs = without(returned.outputs, added);
  if (removed && !has(outs, removed) && !consumedBy(analysis, removed, call)) outs = withName(outs, removed, bodyName(analysis, removed));
  return setReturned(returned, outs);
}

/** Adds a feature's result to what `main` returns. */
export function addToReturn(source: string, analysis: Analysis, name: string): Edit[] {
  const returned = returnedOutputs(analysis);
  if (returned) return setReturned(returned, withName(returned.outputs, name, bodyName(analysis, name)));
  if (!analysis.main) return [];
  const statement = analysis.main.statements.at(-1);
  const indent = statement ? indentOf(source, statement.start) : "  ";
  const close = analysis.main.body.end - 1;
  return [{ start: close, end: close, text: `${indent}return ${printReturn([{ key: undefined, name }])};\n` }];
}

/** Removes a name from what `main` returns. */
export function removeFromReturn(analysis: Analysis, name: string): Edit[] {
  const returned = returnedOutputs(analysis);
  return returned ? setReturned(returned, without(returned.outputs, name)) : [];
}

/** Whether the editor can add to and remove from what `main` returns: it returns names, an object, one or a list of them, or nothing yet. */
export function returnEditable(analysis: Analysis): boolean {
  const last = analysis.main?.statements.at(-1);
  return returnedOutputs(analysis) !== undefined || last?.type !== "ReturnStatement";
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
  g.uses.flatMap((u, k) => (names[k] !== u.name && !(skip && u.span.start >= skip.start && u.span.end <= skip.end) ? [renameUse(u, names[k]!)] : []));

/** Replaces a use by `text`; an output whose key `text` is becomes shorthand, `{ plate }`. */
const renameUse = (u: Use, text: string): Edit => (u.output?.key === text ? { ...u.output.property, text } : replaceIdentifier(u.span, text, u.shorthand));

/**
 * Inserts `const name = code;` before entry `position` (research/07, "The timeline marker"). A
 * feature that consumes a body (`effect.consumes`) is inserted into its chain, as in Fusion: every
 * later feature and the return that used that version of the body use the new feature instead.
 * At the end, it is `insertFeature`.
 */
export function insertFeatureAt(source: string, analysis: Analysis, tl: Timeline, name: string, code: string, position: number, effect: InsertEffect): Edit[] {
  if (position >= tl.entries.length) return insertFeature(source, analysis, name, code, effect);
  const at = insertionPoint(source, analysis, tl, position);
  if (at === undefined) return [];
  const g = graph(analysis, tl);
  const edits: Edit[] = [...ensureImports(analysis, usedFunctions(code)), { start: at, end: at, text: `${indentOf(source, tl.entries[position]!.span.start)}const ${name} = ${code};\n` }];
  const returned = returnedOutputs(analysis);
  if (effect.consumes) {
    // A feature in a chain of bodies doesn't use a sketch, so there is none to hide.
    const names = g.uses.map((u) => (u.name === effect.consumes && u.role !== "hard" && u.owner >= position ? name : u.name));
    edits.push(...renames(g, names, undefined));
  } else if (returned) edits.push(...setReturned(returned, showing(analysis, returned.outputs, name, effect)));
  else if (effect.shows) edits.push(...addToReturn(source, analysis, name));
  return edits;
}

/**
 * Whether feature `index`, which works on an input body, carries that body's chain on (`join`: a
 * later feature works on its result) or branches off it (`branch`: a later feature works on its
 * input instead), research/15 "Inserting into a chain or branching". Undefined if it has no input, or
 * nothing after it continues either.
 */
export function chainMode(g: Graph, index: number): "join" | "branch" | undefined {
  const input = consumedInput(g, index);
  const own = g.declares[index]?.[0];
  if (!input || !own) return undefined;
  const continues = (name: string) => g.uses.some((u) => u.name === name && u.owner > index && u.owner < g.declares.length && (u.role === "consume" || u.role === "tool"));
  return continues(own) ? "join" : continues(input.name) ? "branch" : undefined;
}

/**
 * Makes feature `index` join its input's chain or branch off it. Joining, the later features that
 * worked on its input work on its result, which leaves the result; branching, they work on its
 * input again, and its result, a head now, comes into the result.
 */
export function setChainMode(source: string, analysis: Analysis, tl: Timeline, index: number, mode: "join" | "branch"): Edit[] {
  const g = graph(analysis, tl);
  const input = consumedInput(g, index);
  const own = g.declares[index]?.[0];
  if (!input || !own || chainMode(g, index) === mode || chainMode(g, index) === undefined) return [];
  const [from, to] = mode === "join" ? [input.name, own] : [own, input.name];
  const names = g.uses.map((u) => (u.name === from && u.owner > index && u.owner < g.declares.length && (u.role === "consume" || u.role === "tool") ? to : u.name));
  const edits = renames(g, names, undefined);
  const returned = returnedOutputs(analysis);
  if (returned) edits.push(...setReturned(returned, mode === "join" ? without(returned.outputs, own) : withName(returned.outputs, own, bodyName(analysis, own))));
  else if (mode === "branch") edits.push(...addToReturn(source, analysis, own));
  return edits;
}

/**
 * Moves feature `index` from the body it works on to `next`, as if it had been inserted on `next`
 * (research/15, "Availability"): the later features of its old chain that it joined work on its old
 * body again, which comes back into the result if nothing uses it any more; on `next`, it joins the
 * chain as an insertion does, so the later features and the return that used `next` use its result.
 * Whether it branched off its old chain doesn't carry over. Empty if its body isn't a variable it consumes.
 */
export function rebody(analysis: Analysis, tl: Timeline, index: number, next: string): Edit[] {
  const g = graph(analysis, tl);
  const n = tl.entries.length;
  const input = consumedInput(g, index);
  const own = g.declares[index]?.[0];
  if (!input || !own || input.name === next) return [];
  const previous = input.name;
  const branches = chainMode(g, index) === "branch";
  const later = (u: Use) => u.owner > index && u.owner < n && (u.role === "consume" || u.role === "tool");
  const names = g.uses.map((u) => {
    if (u === input) return next;
    if (u.name === own && later(u)) return previous;
    if (u.name === next && later(u)) return own;
    return u.name;
  });
  // The return is rewritten as a whole: a name may come into it.
  const edits = renames(g, names.map((name, k) => (g.uses[k]!.owner >= n ? g.uses[k]!.name : name)), undefined);
  const returned = returnedOutputs(analysis);
  if (!returned) return edits;
  // Its result stood in the return for its old body, unless it branched off it; it stands for `next` now.
  let result: Out[] = returned.outputs.map((o) => ({ ...o, name: o.name === own && !branches ? previous : o.name === next ? own : o.name })).filter((o, i, all) => all.findIndex((p) => p.name === o.name) === i);
  const usedLater = (name: string) => g.uses.some((u, k) => names[k] === name && u.owner < n && u.owner !== index && (u.role === "consume" || u.role === "tool"));
  if (!has(result, previous) && !usedLater(previous)) result = withName(result, previous, bodyName(analysis, previous));
  return [...edits, ...setReturned(returned, result)];
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
    // The bodies it reads or uses as tools: each becomes the version at the new place.
    const readUses = g.uses.flatMap((u, k) => (u.owner === index && (u.role === "read" || u.role === "tool") ? [k] : []));
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
    for (const k of readUses) {
      const version = versionHere(names[k]!);
      if (version === undefined) return [];
      names[k] = version;
    }
  }

  const range = lines(source, entry.span);
  const inside = renames(g, names, undefined).filter((e) => e.start >= range.start && e.end <= range.end);
  let moved = source.slice(range.start, range.end);
  for (const e of inside.sort((a, b) => b.start - a.start)) moved = moved.slice(0, e.start - range.start) + e.text + moved.slice(e.end - range.start);
  if (!moved.endsWith("\n")) moved += "\n";
  return [{ ...range, text: "" }, { start: at, end: at, text: moved }, ...renames(g, names, range)];
}
