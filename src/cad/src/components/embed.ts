import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { CadModelDoc, CadModelEmbedDoc, Configuration, NamedView } from "../types.ts";

/**
 * Creates an embed of `model` seen from a named view, or with a configuration (research/18-named-views.md,
 * "Embeds"), titled after it; it opens in the viewer.
 */
export function createEmbed(model: DocHandle<CadModelDoc>, of: { view: NamedView } | { configuration: Configuration }): { url: AutomergeUrl; title: string } | undefined {
  const named = "view" in of ? of.view : of.configuration;
  const title = `${model.doc()?.title || "CAD Model"} – ${named.name}`;
  const doc: CadModelEmbedDoc & { "@patchwork": { type: string } } = { "@patchwork": { type: "cad-model-embed" }, title, model: model.url, ...("view" in of ? { view: of.view.id } : { configuration: of.configuration.id }) };
  const url = globalThis.repo?.create(doc).url;
  return url && { url, title };
}

/**
 * Drags document `url` with the payload Patchwork's drop targets read, as in the pandoc tool, and
 * `title` as the drag image, drawn in `container`.
 */
export function dragDocument(event: DragEvent, doc: { url: AutomergeUrl; title: string; type: string }, container: HTMLElement): void {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  // "all", as the sideboard's own drags: its list asks for "move", and a drop effect the drag doesn't allow cancels the drop.
  transfer.effectAllowed = "all";
  transfer.setData("text/x-patchwork-urls", JSON.stringify([doc.url]));
  transfer.setData("text/x-patchwork-dnd", JSON.stringify({ source: "patchwork-cad", items: [{ url: doc.url, name: doc.title, type: doc.type }] }));
  transfer.setData("text/plain", doc.url);
  const image = document.createElement("div");
  image.className = "cad-drag-image";
  image.textContent = doc.title;
  container.append(image);
  transfer.setDragImage(image, 0, 0);
  setTimeout(() => image.remove());
}
