import type { AutomergeUrl } from "@automerge/automerge-repo";

/** How a 3D view looks at the model: from `direction` towards `target`, `distance` away. */
export interface CameraState {
  direction: [number, number, number];
  target: [number, number, number];
  distance: number;
  projection: "perspective" | "orthographic";
  /** The orthographic camera's zoom. */
  zoom: number;
}

/** One user's UI state for one model document. */
export interface DocUiState {
  codeOpen?: boolean;
  /** The last camera of each tool, by tool id. */
  views?: Record<string, CameraState>;
  /** The timeline marker, if it isn't at the end (research/07, "The timeline marker"). */
  marker?: TimelineMarker;
}

/** A timeline marker: before the entry whose first character `cursor` (an automerge cursor into `source`) is on. */
export interface TimelineMarker {
  cursor: string;
  /** The variable of that entry, for when the cursor is lost; "" for a Custom Script. */
  next: string;
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

/** A view of a model: which model, seen with which camera (research/10-view-state.md). */
export interface CadModelViewDoc {
  title: string;
  model: AutomergeUrl;
  camera: CameraState;
}
