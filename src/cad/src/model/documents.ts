/**
 * The documents a model imports, as its code has them (research/21, "The documents list"): each
 * import statement of a document, which entries use it, and the edits of the documents list and
 * dialog as text splices of the import (Pin, Follow, Update, As, replacing the document, removing
 * and renaming it), each one undo step; and the imports a drop or a picked value inserts
 * (research/21, "Dropping, pasting, inserting").
 */
import type { AnyNode, ExportAllDeclaration, ExportNamedDeclaration, ImportAttribute, ImportDeclaration, Program } from "acorn";
import { importType, isDocumentSpecifier, moduleKey, type ImportType } from "../kernel/imports.ts";
import type { Analysis, Span } from "./analyze.ts";
import { derivedStatements } from "./analyze.ts";
import { usesIn } from "./deps.ts";
import { declarable, namesIn, renameProperty, type Refactoring } from "./refactor.ts";
import { lines, type Edit } from "./splice.ts";
import type { Timeline } from "./timeline.ts";

/** A specifier without heads: one that follows its document. */
const withoutHeads = (specifier: string) => specifier.split("#", 1)[0]!;

/**
 * How the documents list and the selection name an imported module: its URL without heads, and the
 * type it is imported with, so that pinning or following it keeps it the same item.
 */
export const documentId = (specifier: string, type: string | undefined) => moduleKey(withoutHeads(specifier), type);

/** One import or re-export of a document in a module. */
export interface DocumentStatement {
  node: ImportDeclaration | ExportAllDeclaration | ExportNamedDeclaration;
  specifier: string;
  /** Its attribute's type; undefined without one, or with one that isn't supported. */
  type: ImportType | undefined;
  /** `documentId` of its module. */
  id: string;
  /** The specifier's string literal. */
  literal: Span;
  /** The attribute clause, `with { … }`, after the literal, if there is one. */
  clause: Span | undefined;
  /** The whole statement, and its first line. */
  span: Span;
  line: number;
  /** The names it declares in the module. */
  locals: string[];
  /** The local name of its only binding, if that is a default or namespace import: the one the dialog renames. */
  name: string | undefined;
  /** Its named imports, `{ imported as local }`, which are listed, not renamed. */
  named: { imported: string; local: string }[];
}

/** The statements of `program` (of `source`) that import or re-export a document. */
export function documentStatements(source: string, program: Program): DocumentStatement[] {
  const out: DocumentStatement[] = [];
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" && node.type !== "ExportAllDeclaration" && node.type !== "ExportNamedDeclaration") continue;
    const from = node.source;
    if (!from || !isDocumentSpecifier(String(from.value))) continue;
    const specifier = String(from.value);
    let type: ImportType | undefined;
    try {
      type = importType((node as { attributes?: ImportAttribute[] }).attributes);
    } catch {
      type = undefined;
    }
    const clause = /^\s*(?:with|assert)\s*\{[^}]*\}/.exec(source.slice(from.end, node.end))?.[0];
    const specifiers = node.type === "ImportDeclaration" ? node.specifiers : [];
    const named = specifiers.flatMap((s) => (s.type === "ImportSpecifier" ? [{ imported: s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value), local: s.local.name }] : []));
    const only = specifiers.length === 1 && specifiers[0]!.type !== "ImportSpecifier" ? specifiers[0]!.local.name : undefined;
    out.push({
      node,
      specifier,
      type,
      id: documentId(specifier, type),
      literal: { start: from.start, end: from.end },
      clause: clause ? { start: from.end, end: from.end + clause.length } : undefined,
      span: { start: node.start, end: node.end },
      line: source.slice(0, node.start).split("\n").length,
      locals: specifiers.map((s) => s.local.name),
      name: only,
      named,
    });
  }
  return out;
}

/** Sets the specifier of every statement of module `id` to `specifier`, in the literal's own quotes. */
export function setSpecifier(source: string, statements: readonly DocumentStatement[], id: string, specifier: string): Edit[] {
  return statements.filter((s) => s.id === id).map((s) => {
    const quote = source[s.literal.start] === "'" ? "'" : '"';
    return { ...s.literal, text: quote + specifier.replace(new RegExp(`[\\\\${quote}]`, "g"), (c) => `\\${c}`) + quote };
  });
}

/** Pins module `id` to `heads`: the version the model builds with, or the document's current one for Update. */
export const pin = (source: string, statements: readonly DocumentStatement[], id: string, heads: readonly string[]): Edit[] =>
  statements.filter((s) => s.id === id).flatMap((s) => setSpecifier(source, [s], id, `${withoutHeads(s.specifier)}#${[...heads].sort().join("|")}`));

/** Makes module `id` follow its document: its specifier without heads. */
export const follow = (source: string, statements: readonly DocumentStatement[], id: string): Edit[] => statements.filter((s) => s.id === id).flatMap((s) => setSpecifier(source, [s], id, withoutHeads(s.specifier)));

/** Replaces module `id`'s document by the one `url` names, as given, e.g. a pasted URL. */
export const replaceDocument = (source: string, statements: readonly DocumentStatement[], id: string, url: string): Edit[] => setSpecifier(source, statements, id, url);

/**
 * Imports module `id` as `type` (research/21, "The document dialog", As): rewrites only the
 * attribute, `undefined` removing it.
 */
export function setType(statements: readonly DocumentStatement[], id: string, type: ImportType | undefined): Edit[] {
  return statements
    .filter((s) => s.id === id)
    .map((s): Edit => {
      const text = type ? ` with { type: "${type}" }` : "";
      return s.clause ? { ...s.clause, text } : { start: s.literal.end, end: s.literal.end, text };
    });
}

/** Removes statement `statement` with its lines; whether anything uses it is the caller's to check (`usedAnywhere`). */
export const removeStatement = (source: string, statement: DocumentStatement): Edit[] => [{ ...lines(source, statement.span), text: "" }];

/** Identifiers that read the names `statement` declares, anywhere in the module but the statement. */
function usesOf(program: Program, statement: DocumentStatement, visit: (id: AnyNode & { name: string }, ancestors: AnyNode[]) => void): void {
  const names = new Set(statement.locals);
  if (!names.size) return;
  for (const node of program.body) if (node !== statement.node && node.type !== "ImportDeclaration") usesIn(node, names, visit);
}

/** Whether anything uses what `statement` imports; a re-export always is a use, of the module's importers. */
export function usedAnywhere(program: Program, statement: DocumentStatement): boolean {
  if (statement.node.type !== "ImportDeclaration") return true;
  let used = false;
  usesOf(program, statement, () => (used = true));
  return used;
}

/**
 * The timeline entries that use the names `statements` declare, and whether the parameters use them
 * (`defaultParams` or a derived value). A feature that uses a derived value of them uses them too.
 */
export function usersOf(analysis: Analysis, tl: Timeline, statements: readonly DocumentStatement[]): { entries: number[]; params: boolean } {
  const names = new Set(statements.flatMap((s) => s.locals));
  if (!names.size) return { entries: [], params: false };
  let params = false;
  for (const node of analysis.program.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : undefined;
    if (declaration?.type === "VariableDeclaration" && declaration.declarations.some((d) => d.id.type === "Identifier" && d.id.name === "defaultParams")) usesIn(declaration, names, () => (params = true));
  }
  for (const statement of derivedStatements(analysis)) {
    let reads = false;
    usesIn(statement, names, () => (reads = true));
    if (!reads) continue;
    params = true;
    const d = statement.type === "VariableDeclaration" ? statement.declarations[0] : undefined;
    if (d?.id.type === "Identifier") names.add(d.id.name);
  }
  const statementsOf = (span: Span) => (analysis.main?.statements ?? []).filter((s) => s.start >= span.start && s.end <= span.end);
  const entries = tl.entries.flatMap((entry, i) => {
    let reads = false;
    for (const statement of statementsOf(entry.span)) usesIn(statement, names, () => (reads = true));
    return reads ? [i] : [];
  });
  return { entries, params };
}

/**
 * Renames the only binding of `statement`, a default or namespace import, from `from` to `to`, and
 * its uses (research/21, "The document dialog", Name); shorthand properties keep their key, and an
 * `export { from }` keeps its exported name.
 */
export function renameImport(analysis: Analysis, statement: DocumentStatement, to: string): Refactoring {
  const from = statement.name;
  if (from === undefined) return { error: "the import has no single name" };
  if (from === to) return { edits: [] };
  if (!declarable(to)) return { error: `${to} is not a valid name` };
  if (namesIn(analysis).has(to)) return { error: `${to} is already used in the model` };
  const node = statement.node;
  const binding = node.type === "ImportDeclaration" ? node.specifiers[0]?.local : undefined;
  if (!binding) return { error: "the import has no single name" };
  const edits: Edit[] = [{ start: binding.start, end: binding.end, text: to }];
  const seen = new Set<number>();
  usesOf(analysis.program, statement, (id, ancestors) => {
    // `export { a }` holds one node as both its local and its exported name: it is visited twice.
    if (seen.has(id.start)) return;
    seen.add(id.start);
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "Property" && parent.value === id) edits.push(renameProperty(parent, to));
    else if (parent?.type === "ExportSpecifier" && parent.local === id) {
      const exported = parent.exported.type === "Identifier" ? parent.exported.name : JSON.stringify(parent.exported.value);
      edits.push({ start: parent.start, end: parent.end, text: `${to} as ${exported}` });
    }
    else edits.push({ start: id.start, end: id.end, text: to });
  });
  return { edits };
}

/** How an inserted import binds its module: its default export, the module, or one named export. */
export type Binding = { kind: "default"; local: string } | { kind: "namespace"; local: string } | { kind: "named"; imported: string; local: string };

/** An import to insert: its specifier as written, its attribute's type, and its binding. */
export interface NewImport {
  specifier: string;
  type: ImportType | undefined;
  binding: Binding;
}

/** An identifier name, which `import { … }` and a member expression can use as is, reserved words included. */
const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * A name for an import of a document titled `title` that no name in the model has (`namesIn`):
 * its words in camelCase, without diacritics and other characters that aren't ASCII identifier
 * characters, after an underscore if it would start with a digit or be a reserved word, and numbered
 * from 2 if it is taken; "doc" if nothing is left.
 */
export function importName(title: string, taken: ReadonlySet<string>): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean);
  const camel = words
    .map((w, i) => (i > 0 ? w[0]!.toUpperCase() + w.slice(1) : w === w.toUpperCase() ? w.toLowerCase() : w[0]!.toLowerCase() + w.slice(1)))
    .join("");
  const base = !camel ? "doc" : /^[0-9]/.test(camel) || !declarable(camel) ? `_${camel}` : camel;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** A string literal in double quotes. */
const quoted = (text: string) => JSON.stringify(text);

/** An import statement of `i`, in the style of the model's other imports. */
export function importStatement(i: NewImport): string {
  const b = i.binding;
  const imported = b.kind === "named" ? (IDENTIFIER_NAME.test(b.imported) ? b.imported : quoted(b.imported)) : "";
  const clause = b.kind === "default" ? b.local : b.kind === "namespace" ? `* as ${b.local}` : `{ ${imported === b.local ? b.local : `${imported} as ${b.local}`} }`;
  return `import ${clause} from ${quoted(i.specifier)}${i.type ? ` with { type: "${i.type}" }` : ""};`;
}

/**
 * Inserts `imports` after the model's last import statement, or at its start if it has none, so
 * that imports stay at the top wherever a drop was: one statement each, or, for a named binding, a
 * specifier added to a statement of the same specifier and type that has named ones already.
 */
export function insertImports(source: string, program: Program, imports: readonly NewImport[]): Edit[] {
  const edits: Edit[] = [];
  const statements: string[] = [];
  const declarations = program.body.filter((n): n is ImportDeclaration => n.type === "ImportDeclaration");
  for (const i of imports) {
    const b = i.binding;
    const into =
      b.kind === "named"
        ? declarations.find((d) => {
            let type: ImportType | undefined;
            try {
              type = importType(d.attributes);
            } catch {
              return false;
            }
            return String(d.source.value) === i.specifier && type === i.type && d.specifiers.some((s) => s.type === "ImportSpecifier");
          })
        : undefined;
    const last = into?.specifiers.findLast((s) => s.type === "ImportSpecifier");
    if (b.kind === "named" && last) {
      const imported = IDENTIFIER_NAME.test(b.imported) ? b.imported : quoted(b.imported);
      edits.push({ start: last.end, end: last.end, text: `, ${imported === b.local ? b.local : `${imported} as ${b.local}`}` });
    } else statements.push(importStatement(i));
  }
  if (statements.length) {
    const last = declarations[declarations.length - 1];
    const at = last ? lines(source, last).end : 0;
    const newline = at > 0 && source[at - 1] !== "\n";
    edits.push({ start: at, end: at, text: newline ? `\n${statements.join("\n")}` : `${statements.join("\n")}\n` });
  }
  return edits;
}

/** `name` followed by the members that reach `path` in it: `.key` where the key is an identifier name, else `["key"]`, and `[3]`. */
export const memberExpression = (name: string, path: readonly (string | number)[]) =>
  name + path.map((p) => (typeof p === "number" ? `[${p}]` : IDENTIFIER_NAME.test(p) ? `.${p}` : `[${quoted(p)}]`)).join("");

/** How the model reads one value of a document: an expression, the imports it needs, and the id of the module it reads. */
export interface ValueReference {
  expression: string;
  imports: NewImport[];
  id: string;
}

/**
 * How the model reads the value at `path` of document `doc` (research/21, "The document dialog"):
 * through an import of the document, of the value itself or of the key the path starts with that
 * there is already, as a member expression; else by a new import, a top-level key as a named import
 * (with `as` where its name is taken or isn't an identifier), a deeper value as a default import of
 * the URL with its path (`pathUrl`, absent for a file, whose content isn't addressed by paths), and
 * else of the whole document, named `base`. A JS file (`code`) has no default export to read a
 * deeper value from: its value is a member of the export the path starts with, imported by name.
 * A new import of a document that the model imports already uses the same specifier, so that it
 * stays one module, pinned or following as it is; else `doc`, with heads to pin it.
 */
export function valueReference(statements: readonly DocumentStatement[], taken: ReadonlySet<string>, doc: string, path: readonly (string | number)[], pathUrl: string | undefined, base: string, code = false): ValueReference {
  const imports = statements.filter((s) => s.node.type === "ImportDeclaration");
  const whole = documentId(doc, undefined);
  const ofDocument = imports.filter((s) => s.id === whole || s.id === documentId(doc, "json"));
  const defaultOf = (s: DocumentStatement) => {
    const d = (s.node as ImportDeclaration).specifiers.find((x) => x.type === "ImportDefaultSpecifier");
    return d?.local.name;
  };
  const namespaceOf = (s: DocumentStatement) => (s.node as ImportDeclaration).specifiers.find((x) => x.type === "ImportNamespaceSpecifier")?.local.name;
  // A JS file's default export is a value of its own, not the module: only its namespace has its exports as members.
  for (const s of ofDocument) {
    const name = code ? namespaceOf(s) : defaultOf(s);
    if (name) return { expression: memberExpression(name, path), imports: [], id: s.id };
    const ofDefault = code && path[0] === "default" && defaultOf(s);
    if (ofDefault) return { expression: memberExpression(ofDefault, path.slice(1)), imports: [], id: s.id };
    // A data module's namespace has its keys as members, but only its default is the whole value: a JSON module has no others, and a key "default" isn't one.
    const namespace = !code && namespaceOf(s);
    if (namespace) return { expression: memberExpression(namespace, s.type === "json" || path[0] === "default" || typeof path[0] !== "string" ? ["default", ...path] : path), imports: [], id: s.id };
  }
  if (pathUrl) {
    const id = documentId(pathUrl, undefined);
    const existing = imports.find((s) => s.id === id && defaultOf(s));
    if (existing) return { expression: defaultOf(existing)!, imports: [], id };
  }
  const key = path[0];
  if (typeof key === "string") {
    const named = ofDocument.flatMap((s) => (s.type === undefined ? s.named.filter((n) => n.imported === key).map((n) => ({ ...n, id: s.id })) : []))[0];
    if (named) return { expression: memberExpression(named.local, path.slice(1)), imports: [], id: named.id };
  }
  const specifier = ofDocument.find((s) => s.type === undefined)?.specifier ?? doc;
  if ((path.length === 1 || code) && typeof key === "string" && key !== "default") {
    const local = declarable(key) && !taken.has(key) ? key : importName(key, taken);
    return { expression: memberExpression(local, path.slice(1)), imports: [{ specifier, type: undefined, binding: { kind: "named", imported: key, local } }], id: documentId(specifier, undefined) };
  }
  if (code && key === "default") {
    const local = importName(base, taken);
    return { expression: memberExpression(local, path.slice(1)), imports: [{ specifier, type: undefined, binding: { kind: "default", local } }], id: documentId(specifier, undefined) };
  }
  if (pathUrl && path.length > 0) {
    const last = path.findLastIndex((p) => typeof p === "string");
    const label = last < 0 ? base : path.slice(last).join(" ");
    const local = importName(label, taken);
    return { expression: local, imports: [{ specifier: pathUrl, type: undefined, binding: { kind: "default", local } }], id: documentId(pathUrl, undefined) };
  }
  const local = importName(base, taken);
  return { expression: memberExpression(local, path), imports: [{ specifier, type: undefined, binding: { kind: "default", local } }], id: documentId(specifier, undefined) };
}
