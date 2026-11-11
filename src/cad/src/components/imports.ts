import { isImmutableString, isValidAutomergeUrl, parseAutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { documentImports, type ImportedModule, type Imports } from "../kernel/imports.ts";

/** The documents a model imports, read from the repo (research/02, "Verdict: imports in code"). */
export interface DocumentImports {
  /**
   * The documents `source` imports, directly or through imported JS, as they are now, and a key
   * that changes only when one of them does.
   */
  read(source: string): Promise<{ imports: Imports; key: string }>;
  dispose(): void;
}

/** MIME types of a file document that is imported as JS; others are data, if they are JSON. */
const JS_TYPES = new Set(["application/javascript", "text/javascript"]);

/**
 * What a document, or the value a URL with a path names, is as a module: a file document (`content`
 * and `mimeType`, as Patchwork's `file` datatype has them) of JS is code, one of JSON is its data,
 * and any other document is data as it is, as Patchwork's service worker serves it.
 */
export function moduleOf(value: unknown): ImportedModule {
  if (value === undefined) return { kind: "problem", problem: "it isn't there" };
  if (value && typeof value === "object" && "content" in value) {
    const file = value as { content: unknown; mimeType?: unknown; "@patchwork"?: { type?: unknown } };
    if (file["@patchwork"]?.type === "cad-model") return { kind: "problem", problem: "it is a CAD model, and models can't be imported yet" };
    const text = typeof file.content === "string" ? file.content : isImmutableString(file.content) ? String(file.content) : undefined;
    const type = typeof file.mimeType === "string" ? file.mimeType : "";
    if (text === undefined) return { kind: "problem", problem: "its content isn't text" };
    if (JS_TYPES.has(type)) return { kind: "js", code: text };
    if (type === "application/json") {
      try {
        return { kind: "data", value: JSON.parse(text) as unknown };
      } catch {
        return { kind: "problem", problem: "its content isn't valid JSON" };
      }
    }
    return { kind: "problem", problem: `it is a file of type ${JSON.stringify(type)}, not JavaScript or JSON` };
  }
  // What JSON keeps of it, e.g. text of an ImmutableString, which is also what can go to the worker.
  return { kind: "data", value: JSON.parse(JSON.stringify(value)) as unknown };
}

/**
 * Reads imported documents, each found once and turned into a module again only when its heads
 * changed, and calls `onChange` when one that follows its document changes. A URL with heads (`automerge:<id>#<heads>`) is pinned to that version and never
 * changes; one without follows the document.
 */
export function createImports(onChange: () => void): DocumentImports {
  const found = new Map<string, Promise<DocHandle<unknown> | string>>();
  /** Each document's module, at the heads it was made at. */
  const modules = new Map<string, { heads: string; module: ImportedModule }>();
  const stops: (() => void)[] = [];
  let disposed = false;

  const load = async (specifier: string): Promise<DocHandle<unknown> | string> => {
    const repo = globalThis.repo;
    if (!repo) return "documents can only be imported in Patchwork";
    if (!isValidAutomergeUrl(specifier)) return "it isn't a valid automerge URL";
    try {
      const handle = await repo.find<unknown>(specifier);
      if (!parseAutomergeUrl(specifier).heads && !disposed) {
        handle.on("change", onChange);
        stops.push(() => handle.off("change", onChange));
      }
      return handle;
    } catch (error) {
      // Tried again on the next read, e.g. once the document is available.
      found.delete(specifier);
      return `it can't be loaded: ${String((error as Error)?.message ?? error)}`;
    }
  };
  const find = (specifier: string) => {
    let handle = found.get(specifier);
    if (!handle) found.set(specifier, (handle = load(specifier)));
    return handle;
  };

  return {
    async read(source) {
      const imports: Imports = {};
      const versions: string[] = [];
      const queue = documentImports(source);
      for (let specifier = queue.shift(); specifier !== undefined; specifier = queue.shift()) {
        if (specifier in imports) continue;
        const handle = await find(specifier);
        let module: ImportedModule;
        if (typeof handle === "string") {
          module = { kind: "problem", problem: handle };
          versions.push(`${specifier} ${handle}`);
        } else {
          const heads = handle.heads().join("|");
          const cached = modules.get(specifier);
          module = cached?.heads === heads ? cached.module : moduleOf(handle.doc());
          modules.set(specifier, { heads, module });
          versions.push(`${specifier}#${heads}`);
        }
        imports[specifier] = module;
        if (module.kind === "js") queue.push(...documentImports(module.code));
      }
      return { imports, key: versions.join("\n") };
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
    },
  };
}
