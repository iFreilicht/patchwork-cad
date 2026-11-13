/**
 * Reading Patchwork documents from a drag or a paste (research/21, "Dropping, pasting, inserting"),
 * as Patchwork's own drop targets do: the sideboard's `text/x-patchwork-dnd` payload, the bare
 * `text/x-patchwork-urls` list, and `text/uri-list` or `text/plain` with automerge URLs or Patchwork
 * web links (`#doc=<id>`), in that order of preference.
 */
import { isValidAutomergeUrl, parseAutomergeUrl, stringifyAutomergeUrl, type AutomergeUrl, type DocumentId } from "@automerge/automerge-repo";

export const PATCHWORK_DND = "text/x-patchwork-dnd";
export const PATCHWORK_URLS = "text/x-patchwork-urls";

/** A dragged or pasted document; `name` and `type` (its datatype) where the payload has them. */
export interface DroppedDocument {
  url: AutomergeUrl;
  name?: string;
  type?: string;
}

/** Whether a drag carries Patchwork's own document types, which only Patchwork's drags have. */
export const isPatchworkDrag = (types: readonly string[]) => types.includes(PATCHWORK_DND) || types.includes(PATCHWORK_URLS);

/** Whether a drag may carry documents as text, which is only known once it is dropped. */
export const mayCarryDocuments = (types: readonly string[]) => !types.includes("Files") && (types.includes("text/uri-list") || types.includes("text/plain"));

/** An automerge URL, also with a path or heads, or the document of a Patchwork web link (`…#doc=<id>`), in one line of text. */
function urlIn(line: string): AutomergeUrl | undefined {
  const text = line.trim();
  if (!text || text.startsWith("#")) return undefined;
  if (isValidAutomergeUrl(text)) return text;
  const raw = /[#?&]doc=([^&\s]+)/.exec(text)?.[1];
  if (!raw) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (isValidAutomergeUrl(id)) return id;
  try {
    const url = stringifyAutomergeUrl({ documentId: id as DocumentId });
    // Round-trips only a valid id.
    parseAutomergeUrl(url);
    return isValidAutomergeUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The documents a text names, a URL or web link per line, e.g. a paste. */
export const documentsInText = (text: string): AutomergeUrl[] => [...new Set(text.split(/\r?\n/).flatMap((line) => urlIn(line) ?? []))];

/** The documents a drop or a drag's start carries, each once, from the richest type it has. */
export function droppedDocuments(data: Pick<DataTransfer, "getData">): DroppedDocument[] {
  const unique = (items: DroppedDocument[]) => items.filter((item, i) => items.findIndex((x) => x.url === item.url) === i);
  try {
    const parsed = JSON.parse(data.getData(PATCHWORK_DND) || "null") as { items?: unknown } | null;
    const items = (Array.isArray(parsed?.items) ? (parsed.items as unknown[]) : []).flatMap((item): DroppedDocument[] => {
      const { url, name, type } = (item ?? {}) as { url?: unknown; name?: unknown; type?: unknown };
      if (!isValidAutomergeUrl(url)) return [];
      return [{ url, ...(typeof name === "string" && name ? { name } : {}), ...(typeof type === "string" && type ? { type } : {}) }];
    });
    if (items.length) return unique(items);
  } catch {
    // The other types follow.
  }
  try {
    const parsed = JSON.parse(data.getData(PATCHWORK_URLS) || "null") as unknown;
    const items = (Array.isArray(parsed) ? parsed : []).flatMap((url): DroppedDocument[] => (isValidAutomergeUrl(url) ? [{ url }] : []));
    if (items.length) return unique(items);
  } catch {
    // The other types follow.
  }
  return documentsInText(data.getData("text/uri-list") || data.getData("text/plain")).map((url) => ({ url }));
}

/**
 * The drop effect to accept a drag with: one the drag allows, or the drop is cancelled. Patchwork's
 * drags allow all (the sideboard's list asks for "move"), others may allow only one.
 */
export function dropEffect(allowed: DataTransfer["effectAllowed"]): DataTransfer["dropEffect"] {
  if (allowed === "none") return "none";
  if (allowed === "move") return "move";
  if (allowed === "link" || allowed === "linkMove") return "link";
  return "copy";
}
