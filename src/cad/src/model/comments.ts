/**
 * Comment threads on the model (research/13-collaboration.md, "Comments"), without the DOM: where
 * each thread is in `source`, which timeline entry it belongs to, and where a thread whose text was
 * deleted goes again.
 */
import { getCursorPosition, type Doc } from "@automerge/automerge";
import { parseAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import type { CadAnchor, CadModelDoc, CommentThread } from "../types.ts";
import type { Span } from "./analyze.ts";
import type { Entry } from "./timeline.ts";

export const COMMENT_THREAD_TYPE = "comment-thread";

/** A thread, with where it is in `source` now. */
export interface PlacedThread {
  id: string;
  thread: CommentThread;
  /** Its range in `source`; undefined if the text was deleted (the range collapsed) or its ref doesn't resolve. */
  range: Span | undefined;
  anchor: CadAnchor | undefined;
}

/**
 * The range of `source` a ref names: a sub-handle URL of `docUrl` with the path `source` and a
 * cursor range, as `handle.sub("source", cursor(from, to)).url` makes it. Undefined for any other
 * ref, a cursor that doesn't resolve, or a collapsed range.
 */
export function sourceRange(doc: Doc<CadModelDoc>, docUrl: AutomergeUrl, ref: AutomergeUrl): Span | undefined {
  let parsed;
  try {
    parsed = parseAutomergeUrl(ref);
  } catch {
    return undefined;
  }
  if (parsed.documentId !== parseAutomergeUrl(docUrl).documentId || parsed.segments?.length !== 2) return undefined;
  const [key, range] = parsed.segments as unknown as [{ key?: string }, { start?: string; end?: string }];
  if (key.key !== "source" || typeof range.start !== "string" || typeof range.end !== "string") return undefined;
  try {
    const start = getCursorPosition(doc, ["source"], range.start);
    const end = getCursorPosition(doc, ["source"], range.end);
    return end > start ? { start, end } : undefined;
  } catch {
    return undefined;
  }
}

/** The open threads (resolved ones are left out, as in Patchwork's Comments panel) and where they are. */
export function placeThreads(doc: Doc<CadModelDoc>, docUrl: AutomergeUrl): PlacedThread[] {
  return (doc["@comments"]?.threads ?? []).flatMap((thread) => {
    if (thread.isResolved) return [];
    const ref = thread.refs[0];
    return [{ id: thread.id, thread, range: ref ? sourceRange(doc, docUrl, ref) : undefined, anchor: thread["@cad"] }];
  });
}

/** The index of the timeline entry a range starts in, if any. */
export const entryOf = (entries: readonly Entry[], range: Span): number | undefined => {
  const index = entries.findIndex((e) => e.span.start <= range.start && range.start < e.span.end);
  return index < 0 ? undefined : index;
};

/**
 * Where a thread whose text is gone goes again: the statement of the feature it was about, if the
 * timeline has a feature of that name again, e.g. after an undo or when it was retyped.
 */
export function reanchorTarget(thread: PlacedThread, entries: readonly Entry[]): Span | undefined {
  const name = thread.anchor?.feature;
  if (thread.range || !name) return undefined;
  const entry = entries.find((e) => e.kind === "feature" && e.names.includes(name));
  return entry && { ...entry.span };
}
