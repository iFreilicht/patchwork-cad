/**
 * Modules without `import()` (research/08, "Evaluation without import()"): a module `prepare` made
 * runs as the body of an async function, and a document that is data, text or bytes is a namespace
 * made directly. Firefox resolves a worker's `import()` on the page's main thread, so a busy page
 * held up every build, and a module that `import()` evaluated stays in the worker for its life.
 * WebKit, whose stacks show no location for eval'd code, gets the functions from `data:` modules
 * instead (`compile`).
 */
import { MODULE_PARAMETERS } from "./prepare.ts";

/** A module's exports, by name. */
export type Namespace = Record<string, unknown>;

/** Names evaluations apart in stack traces. */
let evaluations = 0;

/**
 * Runs `code`, the body `prepare` or `prepareImported` made of a module, and resolves to its
 * namespace once its top level has run; `load` gives the namespace of a module it imports, by the
 * key `resolve` gave. The function is named `<name>-<n>.js` in stack traces by its `sourceURL`, and
 * its body starts on its first line, so that a frame's line is the source's (`lineFromStack`).
 */
export async function evaluate(code: string, name: "cad-model" | "cad-document", load: (key: string) => Namespace): Promise<Namespace> {
  const { namespace, done } = start(code, name, load);
  await done;
  return namespace;
}

/** Starts evaluating, as `evaluate` does: its namespace is complete once `done` resolves, or, where eval'd code has locations and without a top-level `await`, at once. */
export function start(code: string, name: "cad-model" | "cad-document", load: (key: string) => Namespace): { namespace: Namespace; done: Promise<void> } {
  const namespace: Namespace = Object.create(null) as Namespace;
  const exportAll = (getters: Record<string, () => unknown>, stars: Namespace[]) => {
    for (const star of stars) for (const key of Object.keys(star)) if (key !== "default") Object.defineProperty(namespace, key, { get: () => star[key], enumerable: true, configurable: true });
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(namespace, key, { get, enumerable: true });
  };
  const importOf = (key: string, member?: string): unknown => {
    const module = load(key);
    if (member === undefined) return module;
    // As linking a module would, before any of its code runs.
    if (!(member in module)) throw new SyntaxError(`The imported document has no export named ${JSON.stringify(member)}`);
    return module[member];
  };
  const run = compile(code, `${name}-${evaluations++}.js`);
  const done = typeof run === "function" ? run.call(undefined, importOf, exportAll) : run.then((f) => f.call(undefined, importOf, exportAll));
  return { namespace, done };
}

type ModuleFunction = (load: (key: string, member?: string) => unknown, exportAll: (getters: Record<string, () => unknown>, stars: Namespace[]) => void) => Promise<void>;

/** Whether stack frames of eval'd code have its `sourceURL` and lines; WebKit (27.2) gives them no location at all. */
const evalHasLocations = /cad-probe\.js:\d+/.test(((0, eval)("(() => String(new Error().stack))\n//# sourceURL=cad-probe.js") as () => string)());

/**
 * The module's function, named `file`. Without locations for eval'd code, it comes from a `data:`
 * module that only exports it, whose frames have its URL; WebKit keeps only the first 1000 or so
 * characters of it, so the name is a parameter of the URL's media type.
 */
function compile(code: string, file: string): ModuleFunction | Promise<ModuleFunction> {
  const source = `(async function (${MODULE_PARAMETERS.join(", ")}) {${code}\n})`;
  if (evalHasLocations) return (0, eval)(`${source}\n//# sourceURL=${file}`) as ModuleFunction;
  const url = `data:text/javascript;name=${file};charset=utf-8,${encodeURIComponent(`export default ${source}`)}`;
  return (import(/* @vite-ignore */ url) as Promise<{ default: ModuleFunction }>).then((module) => module.default);
}

/**
 * The model's line in a stack (see `evaluate`), which is the source line: a frame names it, and in a
 * `data:` module's frame its encoded code follows, which has no white space and no colon.
 */
export function lineFromStack(stack: unknown): number | undefined {
  if (typeof stack !== "string") return undefined;
  const match = /cad-model-\d+\.js\S*?:(\d+):\d+/.exec(stack);
  return match ? Number(match[1]) : undefined;
}

/**
 * A data document's namespace: the whole value as its default export, and each key of an object as
 * a named export, so that `import { hole_diameter } from "automerge:…"` reads one, and names that
 * aren't identifiers as strings (`import { "hole-diameter" as d } from …`). Imported
 * `with { type: "json" }` (`json`), it has only the default export, as a browser's JSON module.
 */
export function dataNamespace(value: unknown, json = false): Namespace {
  const text = JSON.stringify(value);
  const data: unknown = text === undefined ? undefined : JSON.parse(text);
  const namespace: Namespace = Object.create(null) as Namespace;
  namespace["default"] = data;
  if (!json && data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, v] of Object.entries(data)) if (key !== "default") namespace[key] = v;
  }
  return namespace;
}

/** A file's namespace, `with { type: "text" }` its text and `with { type: "bytes" }` its bytes as the default export. */
export function fileNamespace(content: string | Uint8Array): Namespace {
  const namespace: Namespace = Object.create(null) as Namespace;
  namespace["default"] = content;
  return namespace;
}
