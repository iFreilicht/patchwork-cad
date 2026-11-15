/**
 * Patchwork documents in a drag, as Patchwork's own drop targets read them (and the CAD tool's
 * dnd.ts): the sidebar's `text/x-patchwork-dnd` payload, else the bare `text/x-patchwork-urls` list.
 */
import { isValidAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";

const PATCHWORK_DND = "text/x-patchwork-dnd";
const PATCHWORK_URLS = "text/x-patchwork-urls";

export interface DroppedDocument {
  url: AutomergeUrl;
  name?: string;
}

/** Whether a drag carries Patchwork documents, which only Patchwork's drags do. */
export const isPatchworkDrag = (types: readonly string[]) => types.includes(PATCHWORK_DND) || types.includes(PATCHWORK_URLS);

/** The documents a drop carries, each once. */
export function droppedDocuments(data: Pick<DataTransfer, "getData">): DroppedDocument[] {
  const parse = (type: string): unknown => {
    try {
      return JSON.parse(data.getData(type) || "null");
    } catch {
      return null;
    }
  };
  const payload = parse(PATCHWORK_DND) as { items?: unknown } | null;
  const items: DroppedDocument[] = (Array.isArray(payload?.items) ? (payload.items as { url?: unknown; name?: unknown }[]) : []).flatMap((item) =>
    isValidAutomergeUrl(item?.url) ? [{ url: item.url, ...(typeof item.name === "string" && item.name ? { name: item.name } : {}) }] : [],
  );
  const list = parse(PATCHWORK_URLS);
  if (!items.length && Array.isArray(list)) for (const url of list) if (isValidAutomergeUrl(url)) items.push({ url });
  return items.filter((item, i) => items.findIndex((x) => x.url === item.url) === i);
}
