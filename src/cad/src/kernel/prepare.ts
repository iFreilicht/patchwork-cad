import { parse, type Program } from "acorn";

/** Modules a model may import, and the global the evaluator provides each as. */
const PROVIDED: Record<string, string> = {
  replicad: "replicad",
  "replicad/shape-functions": "replicadShapeFns",
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
 * Turns model source into code that replicad-evaluator's browser evaluator
 * runs unchanged: replicad imports become destructured globals, padded to the
 * same number of lines, so that line numbers in stack traces stay correct.
 * Any other static import is rejected. The browser would otherwise fetch it
 * (the module is evaluated from a blob URL), and every import must go through
 * our loader (research/02, "Verdict: imports in code"). Dynamic import() and
 * fetch() stay possible: model code is not sandboxed in PoC 1.
 */
export function prepare(source: string): string {
  let program: Program;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (error) {
    const loc = (error as { loc?: { line: number } }).loc;
    throw new PrepareError(String((error as Error).message), "syntax", loc?.line ?? 1);
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (const node of program.body) {
    const from =
      node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" ? node.source : null;
    if (!from) continue;
    const specifier = String(from.value);
    const global = PROVIDED[specifier];
    const line = node.loc?.start.line ?? 1;
    if (!global || node.type !== "ImportDeclaration") {
      throw new PrepareError(`Only "replicad" can be imported, not ${JSON.stringify(specifier)}`, "import", line);
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
  let out = source;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
