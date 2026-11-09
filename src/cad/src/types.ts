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
  /** Whether the browser pane is open; it is by default. */
  browserOpen?: boolean;
  /** The configuration this user shows the model with, and values they try over it (research/17, "Trying values"). */
  params?: { configuration?: string; values?: Record<string, ParamValue | LinkedValue> };
  /**
   * What this user shows or hides, against the default (research/15, "Visibility"): `body:<name>`
   * for a body by its name, `version:<name>` for a returned version that isn't a body's head.
   */
  visibility?: Record<string, boolean>;
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
  /** What the tools keep about the model besides its code (research/18-named-views.md, "Storage"). */
  cad?: CadData;
}

/** The tools' data in a model document, next to its code. */
export interface CadData {
  views?: NamedView[];
  configurations?: Configuration[];
}

/** A value of a parameter, as JSON. */
export type ParamValue = number | boolean | string | null | ParamValue[] | { [key: string]: ParamValue };

/** A value taken from another document: any automerge URL that resolves to a number (research/17, "Values from other documents"). */
export interface LinkedValue {
  link: AutomergeUrl;
}

/** A named set of values of the model's parameters, over its defaults (research/17-parameters.md, "Configurations"). */
export interface Configuration {
  id: string;
  name: string;
  params: Record<string, ParamValue | LinkedValue>;
}

/** A camera that belongs to the model, by name (research/18-named-views.md). */
export interface NamedView {
  id: string;
  name: string;
  camera: CameraState;
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
  /** That face or edge as code, e.g. `extrude1.side.front`, shown when it is gone. */
  entityName?: string;
}

/** An embed of a model, seen from one of its named views (research/18-named-views.md, "Embeds"). */
export interface CadModelEmbedDoc {
  title: string;
  model: AutomergeUrl;
  /** A named view's id; without one, the viewer frames the model. */
  view?: string;
  /** A configuration's id; without one, the model's defaults. */
  configuration?: string;
}
