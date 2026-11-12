import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";
import { getRegistry, isLoadedPlugin, type DatatypeDescription, type DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { fileKind, isFile } from "./imports.ts";
import type { Model } from "./createModel.ts";

/** What the editor shows of a document a model refers to (research/21, "Titles, not URLs"). */
export interface DocumentInfo {
  status: "loading" | "ready" | "unavailable";
  /** Its title, as its datatype gives it; its URL while nothing else is known. */
  title: string;
  /** A lucide icon name: its datatype's, or for a file one by what it is. */
  icon: string;
  /** Its datatype's name, e.g. for a tooltip. */
  datatype: string | undefined;
  /** Its current version. */
  heads: UrlHeads | undefined;
  /** The document as it is now. */
  value: unknown;
  problem?: string;
}

/** A file's icon by what it is: the `file` datatype has one icon for all. */
const FILE_ICONS = { js: "FileCode", json: "Braces", svg: "Image", image: "Image", other: "FileText" } as const;

/** The title a document gives itself without its datatype: `title`, a file's `name` and extension. */
function ownTitle(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { title?: unknown; name?: unknown; extension?: unknown };
  if (typeof v.title === "string" && v.title) return v.title;
  if (typeof v.name === "string" && v.name) return typeof v.extension === "string" && v.extension ? `${v.name}.${v.extension.replace(/^\./, "")}` : v.name;
  return undefined;
}

/**
 * The documents a model refers to, each loaded once and followed as it changes, with its title and
 * icon from Patchwork's datatype registry (`getTitle`, as the embed frame does). Disposed with the owner.
 */
export function createDocumentInfo(): (url: string) => DocumentInfo {
  const infos = new Map<string, Accessor<DocumentInfo>>();
  const stops: (() => void)[] = [];
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const stop of stops) stop();
  });
  const load = (url: string): Accessor<DocumentInfo> => {
    const [info, setInfo] = createSignal<DocumentInfo>({ status: "loading", title: url, icon: "File", datatype: undefined, heads: undefined, value: undefined });
    const repo = globalThis.repo;
    if (!repo) {
      setInfo((i) => ({ ...i, status: "unavailable", problem: "documents can only be read in Patchwork" }));
      return info;
    }
    let datatype: { description: DatatypeDescription; module: DatatypeImplementation<unknown> | undefined } | undefined;
    let read = () => {};
    const loadDatatype = (type: string | undefined) => {
      if (!type || datatype?.description.id === type) return;
      const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
      const description = registry.get(type);
      if (!description) return;
      datatype = { description, module: isLoadedPlugin(description) ? (description.module as DatatypeImplementation<unknown>) : undefined };
      if (!datatype.module)
        registry.load(type).then(
          (loaded) => {
            if (loaded && datatype?.description.id === type) datatype.module = loaded.module as DatatypeImplementation<unknown>;
            read();
          },
          () => undefined,
        );
    };
    repo.find<unknown>(url as AutomergeUrl).then(
      (handle) => {
        if (disposed) return;
        read = () => {
          const value = handle.doc();
          const type = (value as { "@patchwork"?: { type?: string } } | undefined)?.["@patchwork"]?.type;
          loadDatatype(type);
          let title: string | undefined;
          try {
            title = datatype?.module?.getTitle(value);
          } catch {
            // getTitle throws on documents it doesn't expect.
          }
          const icon = isFile(value) ? FILE_ICONS[fileKind(value)] : (datatype?.description.icon ?? "File");
          setInfo({ status: "ready", title: title || ownTitle(value) || url, icon, datatype: datatype?.description.name, heads: handle.heads(), value });
        };
        handle.on("change", read);
        stops.push(() => handle.off("change", read));
        read();
      },
      (error: unknown) => setInfo((i) => ({ ...i, status: "unavailable", problem: `it can't be loaded: ${String((error as Error)?.message ?? error)}` })),
    );
    return info;
  };
  return (url) => {
    let info = infos.get(url);
    if (!info) infos.set(url, (info = load(url)));
    return info();
  };
}

/** The status bar's line for each document the model is held back from (research/21, "Following and pinning"). */
export const heldProblems = (model: Model, info: (url: string) => DocumentInfo): string[] => model.held().map((h) => `${info(h.doc).title} is held back at the version the model last built with: ${h.errors.join("; ")}`);
