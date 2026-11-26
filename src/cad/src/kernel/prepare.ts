import { parse, type Declaration, type Identifier, type ImportAttribute, type Literal, type Node, type Pattern, type Program } from "acorn";
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
 * Turns model source into the body of a function that `evaluate` (modules.ts) runs as the module,
 * keeping every line where it was, so that line numbers in stack traces stay correct:
 * - Imports and exports become a header on the first line (see `rewriteModule`). Imports of the
 *   provided modules read globals, and imports of documents (`automerge:` URLs) read the module
 *   `resolve` made of each, for the type of their attribute. Any other static import is rejected:
 *   every import must go through our loader (research/02, "Verdict: imports in code"). Dynamic
 *   import() and fetch() stay possible: model code is not sandboxed.
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
  const { edits, header } = rewriteModule(source, analysis.program, resolve);
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
  return header + applyEdits(source, edits);
}

/** The module an imported document's specifier stands for, imported with attribute type `type`, as the key `evaluate`'s `load` takes; throws with why there is none. */
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

/** The parameters of the function a prepared module is the body of (see `evaluate` in modules.ts). */
export const MODULE_PARAMETERS = ["__cadImport", "__cadExport"] as const;
const [IMPORT, EXPORT] = MODULE_PARAMETERS;

/**
 * Imports and exports as plain statements, keeping every line where it was: each declaration
 * becomes as many line breaks as it spans, or loses its `export`, and a header for the first line
 * declares what they did. As in a module, imports are bound before the first statement runs, and
 * exports are read through getters, so that they show later assignments and a read before their
 * declaration throws. Unlike a module's, an imported binding is the value the other module
 * exported, not a live view of it. A document's module is the one of what its attribute asked for
 * (research/21, "Files as modules").
 */
function rewriteModule(source: string, program: Program, resolve: Resolve): { edits: Edit[]; header: string } {
  const edits: Edit[] = [];
  const bindings: string[] = [];
  /** Exported names and the expressions they read. */
  const exported: [string, string][] = [];
  /** Modules whose exports `export *` passes on. */
  const stars: string[] = [];
  /** Replaces a whole declaration with its line breaks. */
  const drop = (node: { start: number; end: number }) => edits.push({ start: node.start, end: node.end, text: "\n".repeat(source.slice(node.start, node.end).split("\n").length - 1) });
  /** The module of a document, as an expression; for a provided module, the global. */
  const moduleOf = (node: Node, from: Literal, reexport: boolean): string => {
    const specifier = String(from.value);
    const line = node.loc?.start.line ?? 1;
    const attributes = (node as { attributes?: ImportAttribute[] }).attributes ?? [];
    if (isDocumentSpecifier(specifier)) {
      let key;
      try {
        key = resolve(specifier, importType(attributes));
      } catch (error) {
        throw new PrepareError(`${specifier} can't be imported: ${String((error as Error)?.message ?? error)}`, "import", line);
      }
      return `${IMPORT}(${JSON.stringify(key)})`;
    }
    const global = PROVIDED[specifier];
    if (attributes.length) throw new PrepareError(`Only documents (automerge: URLs) can be imported with attributes, not ${JSON.stringify(specifier)}`, "import", line);
    if (!global || reexport) {
      throw new PrepareError(`Only ${Object.keys(PROVIDED).map((m) => JSON.stringify(m)).join(", ")} and documents (automerge: URLs) can be imported, not ${JSON.stringify(specifier)}`, "import", line);
    }
    return `globalThis.${global}`;
  };
  const nameOf = (n: Identifier | Literal) => (n.type === "Identifier" ? n.name : String(n.value));
  /** A named export of a module, which, as in a module, must be there. */
  const member = (module: string, name: string) => (module.startsWith(IMPORT) ? `${module.slice(0, -1)}, ${JSON.stringify(name)})` : `${module}[${JSON.stringify(name)}]`);

  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      const module = moduleOf(node, node.source, false);
      for (const s of node.specifiers) {
        // Default and namespace imports of a provided module both get the whole module.
        if (s.type === "ImportNamespaceSpecifier" || (s.type === "ImportDefaultSpecifier" && !module.startsWith(IMPORT))) bindings.push(`const ${s.local.name} = ${module};`);
        else bindings.push(`const ${s.local.name} = ${member(module, s.type === "ImportDefaultSpecifier" ? "default" : nameOf(s.imported))};`);
      }
      // An import of nothing still evaluates the document.
      if (!node.specifiers.length) bindings.push(`${module};`);
      drop(node);
    } else if (node.type === "ExportAllDeclaration") {
      const module = moduleOf(node, node.source, true);
      if (node.exported) exported.push([nameOf(node.exported), module]);
      else stars.push(module);
      drop(node);
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        for (const name of declaredNames(node.declaration)) exported.push([name, name]);
        edits.push({ start: node.start, end: node.declaration.start, text: "" });
      } else {
        const module = node.source ? moduleOf(node, node.source, true) : undefined;
        for (const s of node.specifiers) {
          const local = nameOf(s.local);
          exported.push([nameOf(s.exported), module ? (local === "default" && !module.startsWith(IMPORT) ? module : member(module, local)) : local]);
        }
        drop(node);
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const d = node.declaration;
      if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) {
        exported.push(["default", d.id.name]);
        edits.push({ start: node.start, end: d.start, text: "" });
      } else {
        exported.push(["default", DEFAULT]);
        edits.push({ start: node.start, end: d.start, text: `const ${DEFAULT} = ` });
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") edits.push({ start: d.end, end: d.end, text: ";" });
      }
    }
  }
  const getters = exported.map(([name, expression]) => `${JSON.stringify(name)}: () => ${expression}`).join(", ");
  const header = `"use strict"; ${EXPORT}({ ${getters} }, [${stars.join(", ")}]); ${bindings.join(" ")}`;
  return { edits, header };
}

/** The binding of an anonymous default export. */
const DEFAULT = "__cadDefault";

/** The names a declaration binds: its function's or class's, or every one of its variables' patterns. */
function declaredNames(declaration: Declaration): string[] {
  if (declaration.type !== "VariableDeclaration") return declaration.id ? [declaration.id.name] : [];
  const names: string[] = [];
  const visit = (p: Pattern | null): void => {
    if (!p) return;
    if (p.type === "Identifier") names.push(p.name);
    else if (p.type === "ObjectPattern") for (const prop of p.properties) visit(prop.type === "RestElement" ? prop.argument : prop.value);
    else if (p.type === "ArrayPattern") p.elements.forEach(visit);
    else if (p.type === "RestElement") visit(p.argument);
    else if (p.type === "AssignmentPattern") visit(p.left);
  };
  for (const d of declaration.declarations) visit(d.id);
  return names;
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
  const { edits, header } = rewriteModule(source, program, resolve);
  return header + applyEdits(source, edits);
}
