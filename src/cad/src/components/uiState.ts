import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { CameraState, DocUiState, TimelineMarker, UiStorageDoc } from "../types.ts";

/** The tool-storage id both tools share, so that state can be read by either. */
const TOOL_STORAGE_ID = "patchwork-cad";

export interface UiState {
  codeOpen: Accessor<boolean>;
  setCodeOpen(open: boolean): void;
  /**
   * The camera a tool last showed the model with, as stored when the state loaded. It doesn't follow
   * later writes, so that two views of one model and tool don't move each other.
   */
  view(toolId: string): CameraState | undefined;
  setView(toolId: string, view: CameraState): void;
  /** The editor's timeline marker; undefined is at the end. */
  marker: Accessor<TimelineMarker | undefined>;
  setMarker(marker: TimelineMarker | undefined): void;
  browserOpen: Accessor<boolean>;
  setBrowserOpen(open: boolean): void;
  /** What this user shows or hides against the default, by key (`DocUiState.visibility`). */
  visibility: Accessor<Record<string, boolean>>;
  /** Sets or, with `undefined`, clears the override of one key; `rename` moves keys to new names. */
  setVisibility(key: string, visible: boolean | undefined): void;
  renameVisibility(renames: Record<string, string>): void;
}

/**
 * The current user's UI state for one model document, kept in the account's tool storage (see
 * research/10-view-state.md), so it syncs across the user's devices but not to collaborators.
 * Without a tool-storage provider, e.g. outside Patchwork, the state lives in memory only.
 */
export function createUiState(element: HTMLElement, docUrl: AutomergeUrl): UiState {
  const [state, setState] = createSignal<DocUiState>({});
  const [loadedViews, setLoadedViews] = createSignal<DocUiState["views"]>();
  /** Tools that set a camera before the state loaded, which then wins over the stored one. */
  const moved = new Set<string>();
  let handle: DocHandle<UiStorageDoc> | undefined;
  /** Writes made before the storage doc was found. */
  let pending: ((entry: DocUiState) => void)[] = [];

  const write = (edit: (entry: DocUiState) => void) => {
    if (!handle) {
      pending.push(edit);
      return;
    }
    handle.change((d) => {
      // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
      d.docs ??= {};
      d.docs[docUrl] ??= {};
      edit(d.docs[docUrl]);
    });
  };
  const read = () => setState({ ...handle?.doc()?.docs?.[docUrl] });
  const load = () => {
    const views = { ...handle?.doc()?.docs?.[docUrl]?.views };
    for (const toolId of moved) delete views[toolId];
    setLoadedViews(views);
  };

  let disposed = false;
  const unsubscribe = subscribe<AutomergeUrl>(element, { type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID }, (url) => {
    if (handle?.url === url) return;
    void globalThis.repo?.find<UiStorageDoc>(url).then((found) => {
      if (disposed) return;
      handle?.off("change", read);
      handle = found;
      handle.on("change", read);
      if (!loadedViews()) load();
      for (const edit of pending.splice(0)) write(edit);
      read();
    });
  });
  onCleanup(() => {
    disposed = true;
    unsubscribe();
    handle?.off("change", read);
  });

  // A write of any other state, e.g. the camera after an orbit, mustn't look like a change of visibility.
  const visibility = createMemo(() => state().visibility ?? {}, {}, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  return {
    codeOpen: () => state().codeOpen ?? false,
    setCodeOpen(open) {
      setState((s) => ({ ...s, codeOpen: open }));
      write((entry) => (entry.codeOpen = open));
    },
    marker: () => state().marker,
    setMarker(marker) {
      setState((s) => {
        const { marker: _, ...rest } = s;
        return marker ? { ...rest, marker } : rest;
      });
      write((entry) => {
        if (marker) entry.marker = { ...marker };
        else delete entry.marker;
      });
    },
    browserOpen: () => state().browserOpen ?? true,
    setBrowserOpen(open) {
      setState((s) => ({ ...s, browserOpen: open }));
      write((entry) => (entry.browserOpen = open));
    },
    visibility,
    setVisibility(key, visible) {
      setState((s) => {
        const { [key]: _, ...rest } = s.visibility ?? {};
        return { ...s, visibility: visible === undefined ? rest : { ...rest, [key]: visible } };
      });
      write((entry) => {
        entry.visibility ??= {};
        if (visible === undefined) delete entry.visibility[key];
        else entry.visibility[key] = visible;
      });
    },
    renameVisibility(renames) {
      const moved = (v: Record<string, boolean>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [renames[k] ?? k, value]));
      setState((s) => ({ ...s, visibility: moved(s.visibility ?? {}) }));
      write((entry) => {
        if (!entry.visibility) return;
        for (const [from, to] of Object.entries(renames)) {
          const value = entry.visibility[from];
          if (value === undefined) continue;
          delete entry.visibility[from];
          entry.visibility[to] = value;
        }
      });
    },
    view: (toolId) => loadedViews()?.[toolId],
    setView(toolId, view) {
      if (!loadedViews()) moved.add(toolId);
      write((entry) => {
        entry.views ??= {};
        entry.views[toolId] = view;
      });
    },
  };
}
