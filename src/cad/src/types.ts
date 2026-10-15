import type { AutomergeUrl } from "@automerge/automerge-repo";

/** One user's UI state for one model document. */
export interface DocUiState {
  codeOpen?: boolean;
}

/** The account's tool-storage doc of patchwork-cad (see src/components/uiState.ts). */
export interface UiStorageDoc {
  docs?: Record<AutomergeUrl, DocUiState>;
}

export interface CadModelDoc {
  title: string;
  /** The model: a plain ES module that imports replicad or the feature library and default-exports a function returning shapes. */
  source: string;
}
