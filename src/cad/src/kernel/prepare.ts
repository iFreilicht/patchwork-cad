import { analyze, FEATURES_MODULE } from "../model/analyze.ts";

/** Modules a model may import, and the global the worker provides each as. */
export const PROVIDED: Record<string, string> = {
  replicad: "replicad",
  "replicad/shape-functions": "replicadShapeFns",
  [FEATURES_MODULE]: "patchworkCadFeatures",
};

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
 * - Imports of the provided modules become destructured globals. Any other static import is
 *   rejected: the browser would fetch it (the module is evaluated from a blob URL), and every
 *   import must go through our loader (research/02, "Verdict: imports in code"). Dynamic import()
 *   and fetch() stay possible: model code is not sandboxed.
 * - Feature calls get a second argument with their name and line (research/03, "feature names come
 *   from the variable names"): `const extrude1 = extrude({…})` becomes
 *   `const extrude1 = extrude({…}, { name: "extrude1", line: 7, variable: true })`. The stored file stays plain.
 */
export function prepare(source: string): string {
  let analysis;
  try {
    analysis = analyze(source);
  } catch (error) {
    const loc = (error as { loc?: { line: number } }).loc;
    throw new PrepareError(String((error as Error).message), "syntax", loc?.line ?? 1);
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (const node of analysis.program.body) {
    const from =
      node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" ? node.source : null;
    if (!from) continue;
    const specifier = String(from.value);
    const global = PROVIDED[specifier];
    const line = node.loc?.start.line ?? 1;
    if (!global || node.type !== "ImportDeclaration") {
      throw new PrepareError(`Only ${Object.keys(PROVIDED).map((m) => JSON.stringify(m)).join(", ")} can be imported, not ${JSON.stringify(specifier)}`, "import", line);
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
  for (const call of analysis.calls) {
    // A destructured body() names its bodies by the variables (research/11).
    const names = call.destructured ? `, names: ${JSON.stringify(call.variables)}` : "";
    const meta = call.variable ? `{ name: ${JSON.stringify(call.variable)}, line: ${call.line}, variable: true${names} }` : `{ line: ${call.line} }`;
    const [first, second] = call.args;
    // An explicit second argument (e.g. a name in a loop) wins over the injected line.
    if (second) {
      edits.push({ start: second.start, end: second.start, text: `{ line: ${call.line}, ...(` });
      edits.push({ start: second.end, end: second.end, text: ")}" });
    } else if (first) edits.push({ start: first.end, end: first.end, text: `, ${meta}` });
    else edits.push({ start: call.span.end - 1, end: call.span.end - 1, text: `undefined, ${meta}` });
  }
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
