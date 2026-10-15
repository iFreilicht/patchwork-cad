/**
 * Refactorings of timeline entries as text edits: renaming an entry's variables, wrapping a Custom
 * Script in `body()` and unwrapping it again (research/11), and deleting a Custom Script.
 */
import { parse, type AnyNode, type Expression, type Statement } from "acorn";
import type { Analysis, Span } from "./analyze.ts";
import { bound, declared, graph, usesIn } from "./deps.ts";
import { ensureImports, indentOf, lines, replaceIdentifier, type Edit } from "./splice.ts";
import type { Timeline } from "./timeline.ts";

/** Edits, or why there are none. */
export type Refactoring = { edits: Edit[] } | { error: string };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Whether `name` can be declared with `const`: an identifier that is not a reserved word. */
function declarable(name: string): boolean {
  if (!IDENTIFIER.test(name)) return false;
  try {
    parse(`const ${name} = 0;`, { ecmaVersion: "latest", sourceType: "module" });
    return true;
  } catch {
    return false;
  }
}

/** The statements of `main` that an entry spans. */
const statementsOf = (analysis: Analysis, span: Span) => (analysis.main?.statements ?? []).filter((s) => s.start >= span.start && s.end <= span.end);

/**
 * Every name the model declares or refers to (imports, parameters, variables, globals such as
 * `Math`), but not property names. A new name must be none of them.
 */
function namesIn(analysis: Analysis): Set<string> {
  const out = new Set<string>();
  const visit = (node: AnyNode, parent: AnyNode | undefined) => {
    const key = (parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && parent.key === node && !parent.computed && !(parent.type === "Property" && parent.shorthand);
    const member = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
    if (node.type === "Identifier" && !key && !member) out.add(node.name);
    for (const value of Object.values(node)) for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === "object" && typeof (v as AnyNode).type === "string") visit(v as AnyNode, node);
  };
  visit(analysis.program, undefined);
  return out;
}

/**
 * Renames variable `from`, which the entry at `index` declares, to `to`: its declaration, its uses
 * in `main` (shorthand properties keep their key) and references through `ref.from`.
 */
export function rename(analysis: Analysis, tl: Timeline, index: number, from: string, to: string): Refactoring {
  if (from === to) return { edits: [] };
  if (!declarable(to)) return { error: `${to} is not a valid name` };
  if (namesIn(analysis).has(to)) return { error: `${to} is already used in the model` };
  const entry = tl.entries[index];
  if (!entry) return { error: "no such entry" };
  const edits: Edit[] = [];
  const names = new Set([from]);
  for (const statement of statementsOf(analysis, entry.span)) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const d of statement.declarations) for (const id of bound(d.id)) if ((id as { name: string }).name === from) edits.push({ start: id.start, end: id.end, text: to });
  }
  if (edits.length === 0) return { error: `${from} is not declared by this entry` };
  for (const statement of analysis.main?.statements ?? []) {
    usesIn(statement, names, (id, ancestors) => {
      const parent = ancestors[ancestors.length - 1];
      const shorthand = parent?.type === "Property" && parent.shorthand && parent.key.type === "Identifier" ? parent.key.name : undefined;
      edits.push(replaceIdentifier(id, to, shorthand));
    });
    // `ref.from`: references to the feature by name.
    const visit = (node: AnyNode) => {
      if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" && node.object.name === "ref" && node.property.type === "Identifier" && node.property.name === from) edits.push({ start: node.property.start, end: node.property.end, text: to });
      for (const value of Object.values(node)) for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === "object" && typeof (v as AnyNode).type === "string") visit(v as AnyNode);
    };
    visit(statement);
  }
  return { edits };
}

/** Indents every non-empty line of `text` by `by`, or removes up to that much indentation. */
function reindent(text: string, by: string, remove = false): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : remove ? (line.startsWith(by) ? line.slice(by.length) : line.trimStart()) : by + line))
    .join("\n");
}

/** Names that variables, functions and parameters declare anywhere in the model. */
function bindings(analysis: Analysis): Set<string> {
  const out = new Set<string>();
  const visit = (node: AnyNode) => {
    if (node.type === "VariableDeclarator") for (const id of bound(node.id)) out.add((id as { name: string }).name);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id) out.add(node.id.name);
      for (const p of node.params) for (const id of bound(p)) out.add((id as { name: string }).name);
    }
    for (const value of Object.values(node)) for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === "object" && typeof (v as AnyNode).type === "string") visit(v as AnyNode);
  };
  visit(analysis.program);
  return out;
}

/** `name` or `[a, b]` for the declaration and the return of a body(). */
const pattern = (names: string[]) => (names.length === 1 ? names[0]! : `[${names.join(", ")}]`);

/**
 * Wraps the Custom Script at `index` in `body()`: its code becomes a function, and the names that
 * later entries use are the bodies it makes, `const cut_plate = body(() => { …; return cut_plate; })`.
 * Whether those names hold shapes shows only when it runs: the editor tries the result first.
 */
export function wrapInBody(source: string, analysis: Analysis, tl: Timeline, index: number): Refactoring {
  const entry = tl.entries[index];
  if (entry?.kind !== "script") return { error: "only a Custom Script can be wrapped" };
  const g = graph(analysis, tl);
  // A variable named body, like M3's, would hide the library's function.
  if (bindings(analysis).has("body") || (namesIn(analysis).has("body") && analysis.imports.get("body") !== "body")) return { error: "the model has its own variable named body" };
  const escaping = (g.declares[index] ?? []).filter((n) => g.uses.some((u) => u.name === n && u.owner > index));
  if (escaping.length === 0) return { error: "nothing it declares is used later" };
  const range = lines(source, entry.span);
  const indent = indentOf(source, entry.span.start);
  const code = source.slice(range.start, range.end).replace(/\n$/, "");
  const text = `${indent}const ${pattern(escaping)} = body(() => {\n${reindent(code, "  ")}\n${indent}  return ${pattern(escaping)};\n${indent}});\n`;
  return { edits: [{ ...range, text }, ...ensureImports(analysis, ["body"])] };
}

/**
 * Unwraps the `body()` entry at `index`: the function's code becomes code of `main` again, and its
 * result is declared as before, `const cut_plate = …`. Features can't use the result then, so it is
 * refused while features use it.
 */
export function unwrapBody(source: string, analysis: Analysis, tl: Timeline, index: number): Refactoring {
  const entry = tl.entries[index];
  if (entry?.kind !== "feature" || entry.type !== "body") return { error: "only a body() can be unwrapped" };
  const g = graph(analysis, tl);
  const users = g.uses.filter((u) => entry.names.includes(u.name) && u.owner < tl.entries.length && tl.entries[u.owner]?.kind === "feature").map((u) => tl.entries[u.owner]!);
  if (users.length > 0) return { error: `${[...new Set(users.map((u) => (u.kind === "feature" ? u.name : "")))].join(", ")} use${users.length === 1 ? "s" : ""} it as a body` };
  const statement = statementsOf(analysis, entry.span)[0];
  const declaration = statement?.type === "VariableDeclaration" ? statement.declarations[0] : undefined;
  if (!statement || !declaration) return { error: "not a declaration" };
  const indent = indentOf(source, entry.span.start);
  const arg = entry.call.args[0];
  const node = findNode(statement, arg) as Expression | undefined;
  const declare = (value: string) => `${indent}const ${source.slice(declaration.id.start, declaration.id.end)} = ${value};\n`;
  const range = lines(source, entry.span);
  if (!node || (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression")) return { edits: [{ ...range, text: declare(arg ? source.slice(arg.start, arg.end) : "undefined") }] };
  if (node.body.type !== "BlockStatement") return { edits: [{ ...range, text: declare(source.slice(node.body.start, node.body.end)) }] };
  const body = node.body.body;
  const last = body.at(-1);
  if (last?.type !== "ReturnStatement" || !last.argument) return { error: "its function doesn't end with a return" };
  const own = body.slice(0, -1).flatMap((s) => declared(s as Statement));
  // `return cut_plate` of its own `cut_plate` (or `[a, b]` of its own a and b), as wrapping writes
  // it: the function's code declares the names itself.
  const result = last.argument;
  const returnedIds = result.type === "Identifier" ? [result.name] : result.type === "ArrayExpression" && result.elements.every((e) => e?.type === "Identifier") ? result.elements.map((e) => (e as { name: string }).name) : undefined;
  const same = returnedIds !== undefined && returnedIds.join() === entry.names.join() && entry.call.destructured === (result.type === "ArrayExpression") && returnedIds.every((n) => own.includes(n));
  // The function's other names must not clash with the model's.
  const outer = new Set(g.declares.flat());
  const clash = own.filter((n) => outer.has(n) || (!same && entry.names.includes(n)));
  if (clash.length > 0 && !(same && clash.every((n) => entry.names.includes(n)))) return { error: `its ${clash.filter((n) => !same || !entry.names.includes(n)).join(", ")} would clash with the model's` };
  const inner = body.length > 1 ? reindent(source.slice(lines(source, body[0]!).start, lines(source, body.at(-2)!).end).replace(/\n$/, ""), "  ", true) + "\n" : "";
  return { edits: [{ ...range, text: same ? inner : inner + declare(source.slice(result.start, result.end)) }] };
}

/** The node of `root` with exactly `span`. */
function findNode(root: AnyNode, target: Span | undefined): AnyNode | undefined {
  if (!target) return undefined;
  if (root.start === target.start && root.end === target.end && root.type !== "ExpressionStatement") return root;
  for (const value of Object.values(root))
    for (const v of Array.isArray(value) ? value : [value])
      if (v && typeof v === "object" && typeof (v as AnyNode).type === "string" && (v as AnyNode).start <= target.start && (v as AnyNode).end >= target.end) {
        const found = findNode(v as AnyNode, target);
        if (found) return found;
      }
  return undefined;
}

/** Deletes the Custom Script at `index`, unless later entries use what it declares. */
export function deleteScript(source: string, analysis: Analysis, tl: Timeline, index: number): Refactoring {
  const entry = tl.entries[index];
  if (entry?.kind !== "script") return { error: "not a Custom Script" };
  const g = graph(analysis, tl);
  const used = (g.declares[index] ?? []).filter((n) => g.uses.some((u) => u.name === n && u.owner > index));
  if (used.length > 0) return { error: `later code uses its ${used.join(", ")}` };
  return { edits: [{ ...lines(source, entry.span), text: "" }] };
}
