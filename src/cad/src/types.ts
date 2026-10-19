import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { RefData } from "./kernel/protocol.ts";

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

/** What one view of a model shows collaborators (research/13-collaboration.md); all of it is optional. */
export interface ViewPresence {
  tool: "editor" | "viewer";
  /** The hovered and the selected face or edge, as references, which collaborators resolve against what they show. */
  hover?: RefData;
  selected?: RefData;
  /** Features hovered in the timeline or code, by name. */
  features?: string[];
  /** The point on the model under the pointer, in world coordinates. */
  pointer?: [number, number, number];
  /** The code pane's selection as automerge cursors into `source`, while it has focus. */
  code?: { anchor: string; head: string };
  /** The timeline marker; absent at the end. */
  marker?: TimelineMarker;
  /** The feature whose dialog is open. */
  open?: string;
}

export interface CadModelDoc {
  title: string;
  /** The model: a plain ES module that imports replicad or the feature library and default-exports a function returning shapes. */
  source: string;
  /** Patchwork's comment threads (research/13-collaboration.md, "Comments"). */
  "@comments"?: { threads: CommentThread[] };
}

/** A comment thread in Patchwork's format (patchwork-base codemirror-base/src/lib/extensions/comments.ts), with our anchor. */
export interface CommentThread {
  id: string;
  /** Sub-handle URLs of what it is about; ours are cursor ranges into `source`. */
  refs: AutomergeUrl[];
  isResolved: boolean;
  comments: Comment[];
  "@patchwork"?: { type: string; title?: string };
  "@cad"?: CadAnchor;
}

export interface Comment {
  id: string;
  content?: string;
  draftContent?: string;
  contactUrl: AutomergeUrl;
  timestamp: number;
}

/** What a thread on a feature, face or edge is about, beyond its range in `source`. */
export interface CadAnchor {
  /** The commented feature's variable, to anchor the thread again when its statement is deleted and comes back. */
  feature?: string;
  /** The statement when the thread was made, shown when it is gone. */
  statement?: string;
  /** A face or edge, as a pick names it. */
  entity?: RefData;
}

/** A view of a model: which model, seen with which camera (research/10-view-state.md). */
export interface CadModelViewDoc {
  title: string;
  model: AutomergeUrl;
  camera: CameraState;
}
