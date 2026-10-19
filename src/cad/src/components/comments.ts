import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { cursor, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { COMMENT_THREAD_TYPE, placeThreads, sourceRange, type PlacedThread } from "../model/comments.ts";
import type { Span } from "../model/analyze.ts";
import type { CadAnchor, CadModelDoc, Comment, CommentThread } from "../types.ts";

/** Patchwork's shared focus document (patchwork-base providers/src/FocusProvider.ts). */
interface FocusDoc {
  /** The active range, written by the view the user works in. */
  selection: Record<AutomergeUrl, true>;
  /** Emphasis any view may add, e.g. the Comments panel's focused thread. */
  highlight: Record<AutomergeUrl, true>;
}

/** The comment threads of one model, for one mounted view (research/13-collaboration.md, "Comments"). */
export interface CommentStore {
  /** Comments need Patchwork: a contact to write as and the focus provider. */
  enabled: Accessor<boolean>;
  threads: Accessor<PlacedThread[]>;
  /** The threads whose refs are in Patchwork's focus (selection or highlight), by id. */
  focused: Accessor<Set<string>>;
  /** The thread's sub-handle URL, which the `comment-thread` tool renders. */
  urlOf(id: string): AutomergeUrl;
  /** Starts a thread on a range of `source`, with one empty comment for its author to fill in; undefined without a contact. */
  create(range: Span, anchor?: CadAnchor): AutomergeUrl | undefined;
  /** Calls `close` once the author's draft is submitted or cancelled, or the thread is gone. */
  watchClose(threadUrl: AutomergeUrl, close: () => void): () => void;
  /** Removes the author's comment that was never filled in, and the thread if that leaves it empty. */
  discardEmptyDraft(threadUrl: AutomergeUrl): void;
  /** Writes the range the user works on to Patchwork's focus selection, so the Comments panel brings up its threads. */
  select(range: Span | undefined): void;
  /** Anchors a thread to a range again, e.g. when the feature it was about came back. */
  reanchor(id: string, range: Span): void;
}

/** CBOR and Automerge have no `undefined`; drop such fields. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createComments(element: HTMLElement, handle: DocHandle<CadModelDoc>): CommentStore {
  const [version, setVersion] = createSignal(0);
  const onChange = () => setVersion((v) => v + 1);
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));

  const [contact, setContact] = createSignal<AutomergeUrl>();
  const [focusHandle, setFocusHandle] = createSignal<DocHandle<FocusDoc>>();
  const [focusDoc, setFocusDoc] = createSignal<FocusDoc>();
  const offContact = subscribe<AutomergeUrl>(element, { type: "patchwork:contact" }, (url) => setContact(url ?? undefined));
  let stopFocus: (() => void) | undefined;
  const offFocus = subscribe<AutomergeUrl>(element, { type: "patchwork:focus" }, (url) => {
    stopFocus?.();
    stopFocus = undefined;
    setFocusHandle(undefined);
    if (!url) return;
    void globalThis.repo?.find<FocusDoc>(url).then((focus) => {
      const update = () => setFocusDoc(focus.doc());
      focus.on("change", update);
      stopFocus = () => focus.off("change", update);
      setFocusHandle(focus);
      update();
    });
  });
  onCleanup(() => {
    offContact();
    offFocus();
    stopFocus?.();
  });

  const threads = createMemo(() => {
    version();
    const doc = handle.doc();
    return doc ? placeThreads(doc, handle.url) : [];
  });
  const focused = createMemo(() => {
    const doc = focusDoc();
    const urls = new Set([...Object.keys(doc?.selection ?? {}), ...Object.keys(doc?.highlight ?? {})]);
    return new Set(threads().flatMap((t) => (t.thread.refs.some((ref) => urls.has(ref)) ? [t.id] : [])));
  });

  const threadOf = (url: AutomergeUrl): CommentThread | undefined => handle.doc()?.["@comments"]?.threads.find((t) => urlOf(t.id) === url);
  const urlOf = (id: string) => handle.sub("@comments", "threads", { id }).url;
  const ownDraft = (c: Comment) => c.contactUrl === contact() && (c.draftContent !== undefined || c.content === undefined);
  const emptyOwnDraft = (c: Comment) => c.contactUrl === contact() && c.content === undefined && !c.draftContent?.trim();

  let selected: AutomergeUrl | undefined;
  return {
    enabled: () => !!contact() && !!focusHandle(),
    threads,
    focused,
    urlOf,
    create(range, anchor) {
      const author = contact();
      if (!author) return undefined;
      const ref = handle.sub("source", cursor(range.start, range.end)).url;
      const id = crypto.randomUUID();
      handle.change((doc) => {
        doc["@comments"] ??= { threads: [] };
        doc["@comments"].threads.push(
          plain({
            id,
            refs: [ref],
            isResolved: false,
            comments: [{ id: crypto.randomUUID(), contactUrl: author, timestamp: Date.now() }],
            "@patchwork": { type: COMMENT_THREAD_TYPE },
            ...(anchor ? { "@cad": anchor } : {}),
          }),
        );
      });
      return urlOf(id);
    },
    watchClose(threadUrl, close) {
      const seed = threadOf(threadUrl);
      let sawDraft = !!seed?.comments.some(ownDraft);
      const check = () => {
        const thread = threadOf(threadUrl);
        if (!thread) return close();
        if (thread.comments.some(ownDraft)) sawDraft = true;
        else if (sawDraft) close();
      };
      handle.on("change", check);
      return () => handle.off("change", check);
    },
    discardEmptyDraft(threadUrl) {
      const thread = threadOf(threadUrl);
      if (!thread?.comments.some(emptyOwnDraft)) return;
      const id = thread.id;
      handle.change((doc) => {
        const list = doc["@comments"]?.threads;
        const index = list?.findIndex((t) => t.id === id) ?? -1;
        if (!list || index < 0) return;
        const target = list[index]!;
        for (let i = target.comments.length - 1; i >= 0; i--) if (emptyOwnDraft(target.comments[i]!)) target.comments.splice(i, 1);
        if (target.comments.length === 0) list.splice(index, 1);
      });
    },
    select(range) {
      const focus = focusHandle();
      if (!focus) return;
      const url = range ? handle.sub("source", cursor(range.start, range.end)).url : undefined;
      if (url === selected) return;
      selected = url;
      focus.change((doc) => {
        doc.selection = url ? { [url]: true } : {};
      });
    },
    reanchor(id, range) {
      const ref = handle.sub("source", cursor(range.start, range.end)).url;
      handle.change((doc) => {
        const thread = doc["@comments"]?.threads.find((t) => t.id === id);
        const current = thread?.refs[0];
        // Another user may have anchored it meanwhile.
        if (!thread || (current && sourceRange(doc, handle.url, current))) return;
        thread.refs.splice(0, thread.refs.length, ref);
      });
    },
  };
}
