import { parse, type ImportAttribute, type Program } from "acorn";
import { analyze, derivedStatements, FEATURES_MODULE } from "../model/analyze.ts";
import { importType, isDocumentSpecifier, type ImportType } from "./imports.ts";

/** Modules a model may import, and the global the worker provides each as. */
export const PROVIDED: Record<string, string> = {
  replicad: "replicad",
  "replicad/shape-functions": "replicadShapeFns",
  [FEATURES_MODULE]: "patchworkCadFeatures",
};

/** The global a model's derived parameters report their values to, when the worker provides it. */
export const DERIVED = "patchworkCadDerived";

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly kind: "syntax" | "import",
    readonly line: number,
  ) {
    super(message);
  }
}

/**
 * Turns model source into code that replicad-evaluator's browser evaluator runs unchanged, keeping
 * every line where it was, so that line numbers in stack traces stay correct:
 * - Imports of the provided modules become destructured globals, and imports of documents
 *   (`automerge:` URLs) import the module `resolve` made of each, for the type of their attribute,
 *   which is dropped (see `rewriteImports`). Any other
 *   static import is rejected: the browser would fetch it (the module is evaluated from a blob URL),
 *   and every import must go through our loader (research/02, "Verdict: imports in code").
 *   Dynamic import() and fetch() stay possible: model code is not sandboxed.
 * - Feature calls get a second argument with their name and line (research/03, "feature names come
 *   from the variable names"): `const extrude1 = extrude({…})` becomes
 *   `const extrude1 = extrude({…}, { name: "extrude1", line: 7, variable: true })`. The stored file stays plain.
 * - Derived parameters report their values (research/17, "Derived parameters"): `const r = w / 4;`
 *   is followed by `; globalThis.patchworkCadDerived?.("r", r);` on the same line.
 */
export function prepare(source: string, resolve: Resolve = noDocuments): string {
  let analysis;
  try {
    analysis = analyze(source);
  } catch (error) {
    const loc = (error as { loc?: { line: number } }).loc;
    throw new PrepareError(String((error as Error).message), "syntax", loc?.line ?? 1);
  }
  const edits = rewriteImports(source, analysis.program, resolve);
  for (const call of analysis.calls) {
    // A destructured body() names its bodies by the variables (research/11).
    const names = call.keys ? `, destructured: ${JSON.stringify(Object.fromEntries(call.keys.map((k, i) => [k, call.variables[i]])))}` : "";
    const meta = call.variable ? `{ name: ${JSON.stringify(call.variable)}, line: ${call.line}, variable: true${names} }` : `{ line: ${call.line} }`;
    const [first, second] = call.args;
    // An explicit second argument (e.g. a name in a loop) wins over the injected line.
    if (second) {
      edits.push({ start: second.start, end: second.start, text: `{ line: ${call.line}, ...(` });
      edits.push({ start: second.end, end: second.end, text: ")}" });
    } else if (first) edits.push({ start: first.end, end: first.end, text: `, ${meta}` });
    else edits.push({ start: call.span.end - 1, end: call.span.end - 1, text: `undefined, ${meta}` });
  }
  for (const statement of derivedStatements(analysis)) {
    const name = statement.type === "VariableDeclaration" && statement.declarations[0]?.id.type === "Identifier" ? statement.declarations[0].id.name : undefined;
    if (name) edits.push({ start: statement.end, end: statement.end, text: `; globalThis.${DERIVED}?.(${JSON.stringify(name)}, ${name});` });
  }
  return applyEdits(source, edits);
}

/** The module an imported document's specifier stands for, imported with attribute type `type`, as a URL; throws with why there is none. */
export type Resolve = (specifier: string, type: ImportType | undefined) => string;

const noDocuments: Resolve = () => {
  throw new Error("documents can only be imported in Patchwork");
};

type Edit = { start: number; end: number; text: string };

function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/**
 * The edits that make a module's imports loadable from a blob URL, keeping every line where it was:
 * provided modules become destructured globals, and a document's specifier becomes the URL of its
 * module, which `export … from` may re-export too. The URL is a module of what the attribute asked
 * for, so the attribute goes (research/21, "Files as modules"); its line breaks stay.
 */
function rewriteImports(source: string, program: Program, resolve: Resolve): Edit[] {
  const edits: Edit[] = [];
  for (const node of program.body) {
    const from =
      node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" ? node.source : null;
    if (!from) continue;
    const specifier = String(from.value);
    const line = node.loc?.start.line ?? 1;
    const attributes = (node as { attributes?: ImportAttribute[] }).attributes ?? [];
    if (isDocumentSpecifier(specifier)) {
      let url;
      try {
        url = resolve(specifier, importType(attributes));
      } catch (error) {
        throw new PrepareError(`${specifier} can't be imported: ${String((error as Error)?.message ?? error)}`, "import", line);
      }
      const clause = /^\s*(?:with|assert)\s*\{[^}]*\}/.exec(source.slice(from.end, node.end))?.[0] ?? "";
      edits.push({ start: from.start, end: from.end + clause.length, text: JSON.stringify(url) + "\n".repeat(clause.split("\n").length - 1) });
      continue;
    }
    const global = PROVIDED[specifier];
    if (attributes.length) throw new PrepareError(`Only documents (automerge: URLs) can be imported with attributes, not ${JSON.stringify(specifier)}`, "import", line);
    if (!global || node.type !== "ImportDeclaration") {
      throw new PrepareError(`Only ${Object.keys(PROVIDED).map((m) => JSON.stringify(m)).join(", ")} and documents (automerge: URLs) can be imported, not ${JSON.stringify(specifier)}`, "import", line);
    }
    const bindings = node.specifiers.map((s) => {
      if (s.type === "ImportSpecifier") {
        const imported = s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value);
        return `const ${s.local.name} = globalThis.${global}[${JSON.stringify(imported)}];`;
      }
      // Default and namespace imports both get the whole module.
      return `const ${s.local.name} = globalThis.${global};`;
    });
    const lines = source.slice(node.start, node.end).split("\n").length;
    edits.push({ start: node.start, end: node.end, text: bindings.join(" ") + "\n".repeat(lines - 1) });
  }
  return edits;
}

/** An imported JS document, made loadable like the model, but without naming its feature calls (research/02, "Verdict: imports in code"). */
export function prepareImported(source: string, resolve: Resolve): string {
  let program;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (error) {
    const loc = (error as { loc?: { line: number } }).loc;
    throw new PrepareError(String((error as Error).message), "syntax", loc?.line ?? 1);
  }
  return applyEdits(source, rewriteImports(source, program, resolve));
}
