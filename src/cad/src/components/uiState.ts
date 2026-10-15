import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { DocUiState, UiStorageDoc } from "../types.ts";

/** The tool-storage id both tools share, so that state can be read by either. */
const TOOL_STORAGE_ID = "patchwork-cad";

export interface UiState {
  get<K extends keyof DocUiState>(key: K): DocUiState[K];
  set<K extends keyof DocUiState>(key: K, value: NonNullable<DocUiState[K]>): void;
  /** Whether the stored state has been read; before that, `get` returns nothing. */
  loaded: Accessor<boolean>;
}

/**
 * The current user's UI state for one model document, kept in the account's tool storage (see
 * research/10-view-state.md), so it syncs across the user's devices but not to collaborators.
 * Without a tool-storage provider, e.g. outside Patchwork, the state lives in memory only.
 */
export function createUiState(element: HTMLElement, docUrl: AutomergeUrl): UiState {
  const [state, setState] = createSignal<DocUiState>({});
  const [loaded, setLoaded] = createSignal(false);
  let handle: DocHandle<UiStorageDoc> | undefined;
  /** Writes made before the storage doc was found. */
  let pending: Partial<DocUiState> = {};

  const write = (patch: Partial<DocUiState>) =>
    handle?.change((d) => {
      // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
      d.docs ??= {};
      d.docs[docUrl] ??= {};
      Object.assign(d.docs[docUrl], patch);
    });
  const read = () => setState({ ...handle?.doc()?.docs?.[docUrl] });

  let disposed = false;
  const unsubscribe = subscribe<AutomergeUrl>(element, { type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID }, (url) => {
    if (handle?.url === url) return;
    void globalThis.repo?.find<UiStorageDoc>(url).then((found) => {
      if (disposed) return;
      handle?.off("change", read);
      handle = found;
      handle.on("change", read);
      if (Object.keys(pending).length) write(pending);
      pending = {};
      read();
      setLoaded(true);
    });
  });
  onCleanup(() => {
    disposed = true;
    unsubscribe();
    handle?.off("change", read);
  });

  return {
    get: (key) => state()[key],
    set(key, value) {
      setState((s) => ({ ...s, [key]: value }));
      if (handle) write({ [key]: value });
      else pending[key] = value;
    },
    loaded,
  };
}
