import { parse, type ImportAttribute } from "acorn";

/**
 * What a document a model imports is, as the tool read it (research/02, "Verdict: imports in code";
 * research/21, "Files as modules"): JS code, data, a file's text or bytes, or why it can't be
 * imported. The tool reads the documents, the worker makes modules of them. Data imported
 * `with { type: "json" }` is a browser's JSON module, with only the default export. Bytes carry an
 * id that names their content (the document and its heads), by which the worker keeps their module.
 */
export type ImportedModule =
  | { kind: "js"; code: string }
  | { kind: "data"; value: unknown; json?: boolean }
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array; id: string }
  | { kind: "problem"; problem: string };

/** The documents a build imports, directly or through other imported documents, by `moduleKey`. */
export type Imports = Record<string, ImportedModule>;

/** The import attribute types documents can be imported with (research/21, "Files as modules"). */
export const IMPORT_TYPES = ["text", "bytes", "json"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/** One import of a document: its specifier, and the type of its `with { type }` attribute, if any. */
export interface DocumentImport {
  specifier: string;
  type: ImportType | undefined;
}

/** Whether an import names a document: `automerge:<id>`, with a path and heads if given. */
export const isDocumentSpecifier = (specifier: string) => specifier.startsWith("automerge:");

/** The key of a module: a document is a module of its own for every type it is imported with. */
export const moduleKey = (specifier: string, type: string | undefined) => (type ? `${specifier} with ${type}` : specifier);

/**
 * The type of an import's attributes, `undefined` without any; throws with why they can't be:
 * only `type` is an attribute, and only of `IMPORT_TYPES`.
 */
export function importType(attributes: readonly ImportAttribute[] | undefined): ImportType | undefined {
  const supported = `${IMPORT_TYPES.map((t) => `{ type: "${t}" }`).join(", ")}`;
  let type: ImportType | undefined;
  for (const a of attributes ?? []) {
    const key = a.key.type === "Identifier" ? a.key.name : String(a.key.value);
    const value = String(a.value.value);
    if (key !== "type") throw new Error(`the attribute ${key} isn't supported, only ${supported}`);
    if (!(IMPORT_TYPES as readonly string[]).includes(value)) throw new Error(`the type ${JSON.stringify(value)} isn't supported, only ${supported}`);
    type = value as ImportType;
  }
  return type;
}

/** The documents a module imports or re-exports from statically, with their type; none while it doesn't parse. An unsupported attribute is left to `prepare` to report. */
export function documentImports(code: string): DocumentImport[] {
  if (!code.includes("automerge:")) return [];
  let program;
  try {
    program = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return [];
  }
  const found = new Map<string, DocumentImport>();
  for (const node of program.body) {
    const from = node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" ? node.source : null;
    if (!from || !isDocumentSpecifier(String(from.value))) continue;
    let type: ImportType | undefined;
    try {
      type = importType((node as { attributes?: ImportAttribute[] }).attributes);
    } catch {
      continue;
    }
    const specifier = String(from.value);
    found.set(moduleKey(specifier, type), { specifier, type });
  }
  return [...found.values()];
}

/**
 * A data document as a module: the whole value as its default export, and each key of an object as
 * a named export, so that `import { hole_diameter } from "automerge:…"` reads one. Names that
 * aren't identifiers are exported as strings (`import { "hole-diameter" as d } from …`). Imported
 * `with { type: "json" }` (`json`), it has only the default export, as a browser's JSON module.
 */
export function dataModule(value: unknown, json = false): string {
  const lines = [`const data = ${JSON.stringify(value) ?? "undefined"};`, "export default data;"];
  if (!json && value && typeof value === "object" && !Array.isArray(value)) {
    Object.keys(value)
      .filter((key) => key !== "default")
      .forEach((key, i) => lines.push(`const v${i} = data[${JSON.stringify(key)}];`, `export { v${i} as ${JSON.stringify(key)} };`));
  }
  return lines.join("\n");
}

/** A file's text as a module: the string as its default export, as `with { type: "text" }` gives it. */
export const textModule = (text: string): string => `export default ${JSON.stringify(text)};`;
