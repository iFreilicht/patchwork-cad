import { isValidAutomergeUrl, parseAutomergeUrl, stringifyAutomergeUrl, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import type { CadModelDoc, CadModelEmbedDoc, Configuration } from "../types.ts";

/** A document's `@patchwork` metadata, as patchwork-plugins' `createDocOfDatatype2` writes it. */
export interface PatchworkMetadata {
  type: string;
  suggestedImportUrl?: string;
  frozenImportUrl?: string;
}

/**
 * The metadata of a new document of datatype `type`, as `createDocOfDatatype2` gives it: the package
 * that registered the datatype, which Patchwork offers to load to someone who doesn't have it, without
 * heads, and with them as `frozenImportUrl` if it is pinned.
 */
export function patchworkMetadata(type: string, importUrl = getRegistry("patchwork:datatype").get(type)?.importUrl): PatchworkMetadata {
  if (!importUrl) return { type };
  if (!isValidAutomergeUrl(importUrl)) return { type, suggestedImportUrl: importUrl };
  const { documentId, heads } = parseAutomergeUrl(importUrl);
  return heads ? { type, suggestedImportUrl: stringifyAutomergeUrl({ documentId }), frozenImportUrl: importUrl } : { type, suggestedImportUrl: importUrl };
}

/**
 * Creates an embed of `model` seen from a named view, or with a configuration (research/18-named-views.md,
 * "Embeds"), titled after it; it opens in the viewer.
 */
export function createEmbed(model: DocHandle<CadModelDoc>, of: { view: { id: string; name: string } } | { configuration: Configuration | undefined }): { url: AutomergeUrl; title: string } | undefined {
  const name = "view" in of ? of.view.name : (of.configuration?.name ?? "Defaults");
  const title = `${model.doc()?.title || "CAD Model"} – ${name}`;
  const doc: CadModelEmbedDoc & { "@patchwork": PatchworkMetadata } = { "@patchwork": patchworkMetadata("cad-model-embed"), title, model: model.url, ...("view" in of ? { view: of.view.id } : of.configuration ? { configuration: of.configuration.id } : {}) };
  const url = globalThis.repo?.create(doc).url;
  return url && { url, title };
}

/**
 * Drags document `url` with the payload Patchwork's drop targets read, as in the pandoc tool, with its
 * datatype `type` if known, and `title` as the drag image, drawn in `container`.
 */
export function dragDocument(event: DragEvent, doc: { url: AutomergeUrl; title: string; type?: string }, container: HTMLElement): void {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  // "all", as the sideboard's own drags: its list asks for "move", and a drop effect the drag doesn't allow cancels the drop.
  transfer.effectAllowed = "all";
  transfer.setData("text/x-patchwork-urls", JSON.stringify([doc.url]));
  transfer.setData("text/x-patchwork-dnd", JSON.stringify({ source: "patchwork-cad", items: [{ url: doc.url, name: doc.title, ...(doc.type ? { type: doc.type } : {}) }] }));
  transfer.setData("text/plain", doc.url);
  const image = document.createElement("div");
  image.className = "cad-drag-image";
  image.textContent = doc.title;
  container.append(image);
  transfer.setDragImage(image, 0, 0);
  setTimeout(() => image.remove());
}
