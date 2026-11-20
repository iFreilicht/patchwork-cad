import { decodeHeads, isImmutableString, isValidAutomergeUrl, parseAutomergeUrl, stringifyAutomergeUrl, type AutomergeUrl, type DocHandle, type UrlHeads, type UrlOptions } from "@automerge/automerge-repo";
import { hasHeads } from "@automerge/automerge";
import { documentImports, moduleKey, type ImportedModule, type Imports, type ImportType } from "../kernel/imports.ts";
import type { NewImport } from "../model/documents.ts";

/** A document a model imports, directly or through an imported JS file, as one read found it. */
export interface ImportedDocument {
  /** Its module's key (`moduleKey`): a document is a module for each type it is imported with. */
  key: string;
  specifier: string;
  type: ImportType | undefined;
  /** The document's own URL, without a path or heads; undefined if the specifier isn't a valid URL. */
  doc: AutomergeUrl | undefined;
  /** The key of the imported JS file that imports it, if the model doesn't import it itself. */
  via: string | undefined;
  /** The version that was read: the URL's heads if it is pinned, else the one given or the document's current one. */
  heads: UrlHeads | undefined;
  module: ImportedModule;
}

/** What one read of a model's imports found. */
export interface ReadImports {
  imports: Imports;
  /** Changes only when one of the documents does. */
  key: string;
  documents: ImportedDocument[];
}

/** The documents a model imports, read from the repo (research/02, "Verdict: imports in code"). */
export interface DocumentImports {
  /**
   * The documents `source` imports, directly or through imported JS, as they are now, or at the
   * versions `at` gives for some documents (by `docOf`) that it follows: a lock (research/21,
   * "Following and pinning"). A pinned URL keeps its own version.
   */
  read(source: string, at?: Record<string, UrlHeads>): Promise<ReadImports>;
  /** Whether this copy of document `doc` has every one of `heads` in its history; false while it isn't loaded. */
  has(doc: string, heads: UrlHeads): boolean;
  dispose(): void;
}

/** The URL of the document a specifier names, without a path or heads. */
export const docOf = (specifier: string): AutomergeUrl | undefined => {
  const doc = specifier.split(/[/#]/, 1)[0]!;
  return isValidAutomergeUrl(doc) ? doc : undefined;
};
/** A specifier without heads: one that follows its document. */
export const withoutHeads = (specifier: string) => specifier.split("#", 1)[0]!;
/** The heads of a pinned specifier, if it has any. */
export const headsOf = (specifier: string): UrlHeads | undefined => {
  const heads = specifier.split("#")[1];
  return heads ? (heads.split("|") as UrlHeads) : undefined;
};
/** A specifier pinned to `heads`, sorted as automerge-repo writes them. */
export const withHeads = (specifier: string, heads: readonly string[]) => `${withoutHeads(specifier)}#${[...heads].sort().join("|")}`;
/** Whether two versions are the same, in whatever order their heads are. */
export const sameHeads = (a: readonly string[] | undefined, b: readonly string[] | undefined) => !!a && !!b && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** A value's place in a document: keys of maps, and indices of lists. */
export type ValuePath = readonly (string | number)[];

/** The path a URL names in its document; undefined if it has a segment other than a key or an index, e.g. a cursor range into text. */
export function valuePath(url: string): ValuePath | undefined {
  let segments;
  try {
    segments = parseAutomergeUrl(withoutHeads(url) as AutomergeUrl).segments ?? [];
  } catch {
    return undefined;
  }
  const path: (string | number)[] = [];
  for (const s of segments) {
    if (s.AUTOMERGE_REF_KIND === "key") path.push(s.key);
    else if (s.AUTOMERGE_REF_KIND === "index") path.push(s.index);
    else return undefined;
  }
  return path;
}

/**
 * The URL of the value at `path` of document `doc`, in automerge-repo's path syntax (`automerge:<id>/rows/@3/width`,
 * research/17, "Building blocks"): what a configuration links to, and what a model imports one value of a document by.
 */
export function valueUrl(doc: AutomergeUrl, path: ValuePath): AutomergeUrl {
  const segments: NonNullable<UrlOptions["segments"]> = path.map((p) => (typeof p === "number" ? { AUTOMERGE_REF_KIND: "index", index: p } : { AUTOMERGE_REF_KIND: "key", key: p }));
  return stringifyAutomergeUrl({ documentId: parseAutomergeUrl(doc).documentId, segments });
}

/** The value at `path` in `value`, if it is there. */
export function valueAt(value: unknown, path: ValuePath): unknown {
  let at = value;
  for (const p of path) {
    if (!at || typeof at !== "object" || !Object.hasOwn(at, p)) return undefined;
    at = (at as Record<string | number, unknown>)[p];
  }
  return at;
}

/**
 * Where the values that `fits` takes are in `value`, depth first in key order, for a picker: the
 * paths to the first `paths` of them, searching the first `keys` keys of each map or list and at
 * most `nodes` values, so that a large document stays cheap. `complete` is whether all of it was
 * searched: only then does finding none mean there is none.
 */
export function fittingValues(value: unknown, fits: (value: unknown) => boolean, limits: { keys: number; nodes: number; paths: number }): { paths: ValuePath[]; complete: boolean } {
  const paths: ValuePath[] = [];
  let nodes = 0;
  let complete = true;
  const visit = (at: unknown, path: (string | number)[]): boolean => {
    if (++nodes > limits.nodes) return (complete = false);
    if (fits(at)) {
      paths.push(path);
      if (paths.length >= limits.paths) return false;
    }
    if (!at || typeof at !== "object") return true;
    const entries = Object.entries(at);
    if (entries.length > limits.keys) complete = false;
    for (const [key, v] of entries.slice(0, limits.keys)) if (!visit(v, [...path, Array.isArray(at) ? Number(key) : key])) return false;
    return true;
  };
  visit(value, []);
  return { paths, complete: complete && paths.length < limits.paths };
}

/** MIME types of a file document that is JS, and of one that is JSON. */
const JS_TYPES = new Set(["application/javascript", "text/javascript", "application/x-javascript"]);
/** MIME types that don't say what a file is: the sidebar's for anything the browser doesn't know, and the file tool's default. */
const GENERIC_TYPES = new Set(["", "application/octet-stream", "text/plain"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

/** What a file is, for importing it (research/21, "The document dialog"). */
export type FileKind = "js" | "json" | "svg" | "image" | "other";

/** A file document: `content`, and its `mimeType`, `extension` and `name` as Patchwork's `file` datatype has them. */
export interface FileLike {
  content: unknown;
  mimeType?: unknown;
  extension?: unknown;
  name?: unknown;
}

/**
 * Whether a document is a file (research/21, "Files as modules"): of Patchwork's `file` datatype, a
 * CAD model, a document without a datatype that has a file's `content` (text or bytes) and
 * `mimeType`, as JS libraries made by scripts are, or a document of another datatype that has a
 * file's `content`, `mimeType` and `extension` too, as a draw.io diagram (src/drawio) is. Any other
 * document is data, also one with a `content` key.
 */
export function isFile(value: unknown): value is FileLike {
  if (!value || typeof value !== "object" || !("content" in value)) return false;
  const type = (value as { "@patchwork"?: { type?: unknown } })["@patchwork"]?.type;
  if (type === "file" || type === "cad-model") return true;
  const { content, mimeType, extension } = value as FileLike;
  const fileContent = typeof mimeType === "string" && (typeof content === "string" || content instanceof Uint8Array || isImmutableString(content));
  return fileContent && (type === undefined || typeof extension === "string");
}

/**
 * What a file is, from its `mimeType`, and from its `extension` where the MIME type is generic or
 * missing (research/21, "Files as modules"): the sidebar uploads every file with the browser's
 * type, `application/octet-stream` if it knows none.
 */
export function fileKind(file: FileLike): FileKind {
  const type = typeof file.mimeType === "string" ? file.mimeType.split(";")[0]!.trim().toLowerCase() : "";
  if (JS_TYPES.has(type)) return "js";
  if (type === "application/json") return "json";
  if (type === "image/svg+xml") return "svg";
  if (type.startsWith("image/")) return "image";
  if (!GENERIC_TYPES.has(type)) return "other";
  const extension = typeof file.extension === "string" ? file.extension.replace(/^\./, "").toLowerCase() : "";
  if (extension === "js" || extension === "mjs" || extension === "cjs") return "js";
  if (extension === "json") return "json";
  if (extension === "svg") return "svg";
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "other";
}

/** A file's content as text, decoding UTF-8 bytes; undefined if it isn't text. */
export function fileText(file: FileLike): string | undefined {
  const content = file.content;
  if (typeof content === "string") return content;
  if (isImmutableString(content)) return String(content);
  if (content instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A file's content as bytes: its bytes, or its text as UTF-8. */
export function fileBytes(file: FileLike): Uint8Array | undefined {
  const content = file.content;
  if (content instanceof Uint8Array) return content;
  const text = typeof content === "string" ? content : isImmutableString(content) ? String(content) : undefined;
  return text === undefined ? undefined : new TextEncoder().encode(text);
}

/** How a document can be imported: the attribute types (`undefined`: none, as data or code) it allows (research/21, "The document dialog"). */
export function importKinds(value: unknown): ("data" | "code" | "text" | "bytes")[] {
  if (!isFile(value)) return ["data"];
  if ((value as { "@patchwork"?: { type?: unknown } })["@patchwork"]?.type === "cad-model") return [];
  const kind = fileKind(value);
  const text = fileText(value) !== undefined;
  if (kind === "js") return ["code", ...(text ? (["text"] as const) : []), "bytes"];
  if (kind === "json") return ["data", ...(text ? (["text"] as const) : []), "bytes"];
  if (kind === "image") return ["bytes"];
  return [...(text ? (["text"] as const) : []), "bytes"];
}

/**
 * How Import imports a document (research/21, "Dropping, pasting, inserting"): in the first way
 * `importKinds` allows, which is the one that makes sense as a value (code for JS, data for JSON and
 * any other document, text for SVG and other text, bytes for images and other binary files), a value
 * that a URL's path names as data; code pinned to the document's current version `heads`, everything
 * else following (research/21, "Following and pinning"); a JS file as a namespace, which may have no
 * default export. Undefined if it can't be imported, e.g. a CAD model.
 */
export function defaultImport(url: AutomergeUrl, value: unknown, heads: readonly string[], local: string): NewImport | undefined {
  const as = withoutHeads(url) !== docOf(url) ? "data" : importKinds(value)[0];
  if (!as) return undefined;
  const specifier = as === "code" && !headsOf(url) ? withHeads(url, heads) : url;
  return { specifier, type: as === "text" || as === "bytes" ? as : undefined, binding: as === "code" ? { kind: "namespace", local } : { kind: "default", local } };
}

/** The supported ways of importing a document, for messages. */
const offer = (kinds: ReturnType<typeof importKinds>) => kinds.map((k) => (k === "text" || k === "bytes" ? `with { type: "${k}" }` : k === "code" ? "as code" : "as data")).join(" or ");

/**
 * What a document, or the value a URL with a path names, is as a module, imported with attribute
 * type `type` (research/21, "Files as modules"). Without one, a file document (`content` and
 * `mimeType`, as Patchwork's `file` datatype has them) of JS is code, one of JSON is its data, and
 * any other document is data as it is, as Patchwork's service worker serves it. `text` is a file's
 * text, `bytes` its bytes, `json` the data of a JSON file or any other document. `id` names the
 * version read, for bytes.
 */
export function moduleOf(value: unknown, type?: ImportType, id = ""): ImportedModule {
  if (value === undefined) return { kind: "problem", problem: "it isn't there" };
  if (isFile(value)) {
    if ((value as { "@patchwork"?: { type?: unknown } })["@patchwork"]?.type === "cad-model") return { kind: "problem", problem: "it is a CAD model, and models can't be imported yet" };
    const kind = fileKind(value);
    const kinds = importKinds(value);
    const mimeType = typeof value.mimeType === "string" && value.mimeType ? value.mimeType : `.${String(value.extension ?? "")}`;
    const refuse = (what: string) => ({ kind: "problem" as const, problem: `it is a file of type ${JSON.stringify(mimeType)}, which can't be imported ${what}; import it ${offer(kinds)}` });
    if (type === "bytes") {
      const bytes = fileBytes(value);
      return bytes ? { kind: "bytes", bytes, id } : { kind: "problem", problem: "its content isn't text or bytes" };
    }
    if (type === "text") {
      if (kind === "image") return refuse('with { type: "text" }');
      const text = fileText(value);
      return text === undefined ? { kind: "problem", problem: `its content isn't text; import it with { type: "bytes" }` } : { kind: "text", text };
    }
    if (kind !== "js" && kind !== "json") return refuse(type ? `with { type: "${type}" }` : "without an attribute");
    if (type === "json" && kind !== "json") return refuse('with { type: "json" }');
    const text = fileText(value);
    if (text === undefined) return { kind: "problem", problem: "its content isn't text" };
    if (kind === "js") return { kind: "js", code: text };
    try {
      return { kind: "data", value: JSON.parse(text) as unknown, ...(type === "json" ? { json: true } : {}) };
    } catch {
      return { kind: "problem", problem: "its content isn't valid JSON" };
    }
  }
  if (type === "text" || type === "bytes") return { kind: "problem", problem: `it isn't a file, so it can't be imported with { type: "${type}" }; import it as data` };
  // What JSON keeps of it, e.g. text of an ImmutableString, which is also what can go to the worker.
  return { kind: "data", value: JSON.parse(JSON.stringify(value)) as unknown, ...(type === "json" ? { json: true } : {}) };
}

/**
 * Reads imported documents from `repo` (Patchwork's by default), each found once and turned into a module again only when its heads
 * changed, and calls `onChange` when one that follows its document changes. A URL with heads
 * (`automerge:<id>#<heads>`) is pinned to that version and never changes; one without follows the
 * document, unless a read asks for a version of it.
 */
export function createImports(onChange: () => void, repo: typeof globalThis.repo = globalThis.repo): DocumentImports {
  const found = new Map<string, Promise<DocHandle<unknown> | string>>();
  /** The documents themselves, without a path or heads, by URL: their current heads and history. */
  const roots = new Map<string, DocHandle<unknown>>();
  /** Each module, at the heads it was made at. */
  const modules = new Map<string, { heads: string; module: ImportedModule }>();
  const stops: (() => void)[] = [];
  let disposed = false;

  /** Finds a URL; one without heads follows its document, and a change of it calls `onChange`. */
  const load = async (specifier: string): Promise<DocHandle<unknown> | string> => {
    if (!repo) return "documents can only be imported in Patchwork";
    if (!isValidAutomergeUrl(specifier)) return "it isn't a valid automerge URL";
    try {
      const handle = await repo.find<unknown>(specifier);
      if (!headsOf(specifier) && !disposed) {
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
  const root = async (doc: AutomergeUrl): Promise<DocHandle<unknown> | undefined> => {
    const handle = await find(doc);
    if (typeof handle === "string") return undefined;
    roots.set(doc, handle);
    return handle;
  };

  return {
    async read(source, at = {}) {
      const imports: Imports = {};
      const documents: ImportedDocument[] = [];
      const versions: string[] = [];
      const queue: { specifier: string; type: ImportType | undefined; via: string | undefined }[] = documentImports(source).map((d) => ({ ...d, via: undefined }));
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const { specifier, type, via } = next;
        const key = moduleKey(specifier, type);
        if (key in imports) continue;
        const doc = docOf(specifier);
        const pinned = headsOf(specifier);
        const locked = !pinned && doc ? at[doc] : undefined;
        const handle = await find(locked ? withHeads(specifier, locked) : specifier);
        // The document of a following URL, also of one with a path, whose version is the document's.
        const current = !pinned && doc ? await root(doc) : undefined;
        const heads: UrlHeads | undefined = pinned ?? locked ?? current?.heads();
        let module: ImportedModule;
        if (typeof handle === "string") {
          module = { kind: "problem", problem: handle };
          versions.push(`${key} ${handle}`);
        } else {
          const version = (heads ?? handle.heads()).join("|");
          const cached = modules.get(`${key}#${locked ? version : ""}`);
          module = cached?.heads === version ? cached.module : moduleOf(handle.doc(), type, `${withoutHeads(specifier)}#${version}`);
          modules.set(`${key}#${locked ? version : ""}`, { heads: version, module });
          versions.push(`${key}#${version}`);
        }
        imports[key] = module;
        documents.push({ key, specifier, type, doc, via, heads, module });
        if (module.kind === "js") queue.push(...documentImports(module.code).map((d) => ({ ...d, via: key })));
      }
      return { imports, key: versions.join("\n"), documents };
    },
    has(doc, heads) {
      const handle = roots.get(doc);
      const current = handle?.doc();
      if (!current) return false;
      try {
        return hasHeads(current as never, decodeHeads(heads));
      } catch {
        return false;
      }
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
    },
  };
}
