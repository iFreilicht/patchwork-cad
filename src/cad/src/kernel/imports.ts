import { parse } from "acorn";

/**
 * What a document a model imports is, as the tool read it (research/02, "Verdict: imports in code"):
 * JS code, data, or why it can't be imported. The tool reads the documents, the worker makes modules
 * of them.
 */
export type ImportedModule = { kind: "js"; code: string } | { kind: "data"; value: unknown } | { kind: "problem"; problem: string };

/** The documents a build imports, directly or through other imported documents, by specifier. */
export type Imports = Record<string, ImportedModule>;

/** Whether an import names a document: `automerge:<id>`, with a path and heads if given. */
export const isDocumentSpecifier = (specifier: string) => specifier.startsWith("automerge:");

/** The documents a module imports or re-exports from statically; none while it doesn't parse. */
export function documentImports(code: string): string[] {
  if (!code.includes("automerge:")) return [];
  let program;
  try {
    program = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const node of program.body) {
    const from = node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" ? node.source : null;
    if (from && isDocumentSpecifier(String(from.value))) found.add(String(from.value));
  }
  return [...found];
}

/**
 * A data document as a module: the whole value as its default export, and each key of an object as
 * a named export, so that `import { hole_diameter } from "automerge:…"` reads one. Names that
 * aren't identifiers are exported as strings (`import { "hole-diameter" as d } from …`).
 */
export function dataModule(value: unknown): string {
  const lines = [`const data = ${JSON.stringify(value) ?? "undefined"};`, "export default data;"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.keys(value)
      .filter((key) => key !== "default")
      .forEach((key, i) => lines.push(`const v${i} = data[${JSON.stringify(key)}];`, `export { v${i} as ${JSON.stringify(key)} };`));
  }
  return lines.join("\n");
}
