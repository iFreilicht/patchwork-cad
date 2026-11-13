import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { MODEL_MIME_TYPE } from "./datatype.ts";
import type { RefData } from "./kernel/protocol.ts";

/** Distances from a fitted rectangle to the visible one's edges, as fractions of its height (top, bottom) or width (right, left). */
export type Margins = [top: number, right: number, bottom: number, left: number];

/**
 * How a 3D view looks at the model (research/20-view-framing.md): from `direction` towards
 * `target`, showing at least the rectangle `extent` (width, height, in model units) around the
 * target, as SVG's `meet` fits a viewBox into any viewport.
 */
export interface CameraState {
  direction: [number, number, number];
  target: [number, number, number];
  extent: [number, number];
  projection: "perspective" | "orthographic";
  /**
   * How far the eye is from what the camera shows, in multiples of the distance at which the
   * rectangle it shows (the extent, or the fit with its margins) just fits a square 45° view; 1 if not
   * given. The eye stays there in any viewport, whose field of view widens or narrows instead.
   */
  eye?: number;
  /** The camera shows the whole model, with these margins around it; it fits them again when shown, and target and extent follow. */
  fit?: Margins;
  /** A close-up follows what it shows, if it was saved as a view (research/20, "Close-ups"). */
  subject?: CameraSubject;
}

/** What a close-up shows: faces and sketches, and its margins around them. */
export interface CameraSubject {
  faces: RefData[];
  sketches: string[];
  fit: Margins;
}

/** A camera as stored before research/20: `distance` from the target, and the orthographic camera's zoom. */
export interface LegacyCamera {
  direction: [number, number, number];
  target: [number, number, number];
  distance: number;
  projection: "perspective" | "orthographic";
  zoom: number;
}

/** A camera as a document may hold it; read it with `cameraOf` (`components/framing.ts`). */
export type StoredCamera = CameraState | LegacyCamera;

/** One user's UI state for one model document. */
export interface DocUiState {
  codeOpen?: boolean;
  /** The last camera of each tool, by tool id. */
  views?: Record<string, StoredCamera>;
  /** The timeline marker, if it isn't at the end (research/07, "The timeline marker"). */
  marker?: TimelineMarker;
  /** Whether the browser pane is open; it is by default. */
  browserOpen?: boolean;
  /** The configuration this user shows the model with (research/17, "Configurations"). */
  params?: { configuration?: string };
  /**
   * What this user shows or hides, against the default (research/15, "Visibility"): `body:<name>`
   * for a body by its name, `version:<name>` for a returned version that isn't a body's head.
   */
  visibility?: Record<string, boolean>;
}

/** A timeline marker: before the entry whose first character `cursor` (an automerge cursor into `content`) is on. */
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
  /** The code pane's selection as automerge cursors into `content`, while it has focus. */
  code?: { anchor: string; head: string };
  /** The timeline marker; absent at the end. */
  marker?: TimelineMarker;
  /**
   * The selected item (research/19-selection.md): a timeline entry by an automerge cursor at the
   * start of its code, a configuration or view by its id, a document by its URL without heads and
   * the type it is imported with; the parameters and the return by kind.
   */
  selection?: { kind: "feature" | "script" | "params" | "configuration" | "return" | "view" | "document"; id: string };
}

export interface CadModelDoc {
  title: string;
  /**
   * The model: a plain ES module that imports replicad or the feature library and default-exports a
   * function returning shapes. Kept in `content` with a `mimeType`, as Patchwork's file documents
   * are, so that its service worker serves the document as this module (research/17, "Building blocks").
   */
  content: string;
  mimeType: typeof MODEL_MIME_TYPE;
  /** Patchwork's comment threads (research/13-collaboration.md, "Comments"). */
  "@comments"?: { threads: CommentThread[] };
  /** What the tools keep about the model besides its code (research/18-named-views.md, "Storage"). */
  cad?: CadData;
}

/** The tools' data in a model document, next to its code. */
export interface CadData {
  views?: NamedView<StoredCamera>[];
  /** Where the Home view looks from, if the model's users changed it; else the ViewCube's Home framing (research/18, "Home"). */
  home?: StoredCamera;
  configurations?: Configuration[];
  /**
   * The version of each document the model follows that it last built with, by the document's URL
   * without a path or heads (research/21, "Following and pinning"); written by the editor only.
   */
  locks?: Record<string, string[]>;
  /** Documents shown at places on the model (research/21, "Annotation"). */
  annotations?: Annotation[];
  /** Images on planes, to trace or compare (research/21, "Canvas"). */
  canvases?: Canvas[];
}

/** A plane: its origin, its normal, and the direction of its x axis, as the feature library's `Frame`. */
export interface PlaneFrame {
  origin: [number, number, number];
  normal: [number, number, number];
  xDir: [number, number, number];
}

/** An image drawn on a plane or a planar face, in the editor's view only (research/21, "Canvas"). */
export interface Canvas {
  id: string;
  name: string;
  /** The image document; with heads, a version of it. */
  image: AutomergeUrl;
  /** An origin plane's frame, or a planar face, anchored as a comment is, whose frame a sketch on it has. */
  plane: PlaneFrame | CadAnchor;
  /** The image's centre in the plane's coordinates. */
  center: [number, number];
  /** Its rotation about the plane's normal, in degrees. */
  angle: number;
  /** Its width in model units; its height follows the image's aspect. */
  width: number;
  /** From 0, invisible, to 1. */
  opacity: number;
  /** Drawn over the model, as Fusion's "Display Through". */
  through: boolean;
  /** Experiment: a document that isn't an image is laid out this much higher than wide (default 0.75). */
  aspect?: number;
  /** Experiment: a document that isn't an image is shown by this tool, its default if not given. */
  tool?: string;
  /** Experiment: a document that isn't an image is shown editable, at its URL as stored, not at its current heads. */
  live?: boolean;
  /** Experiment: our stylesheet hides the tool's own chrome, for tools we know (tldraw). */
  bare?: boolean;
  /** Experiment: the part of a tldraw drawing it shows, as tldraw's camera for the document laid out 900 pixels wide; fitted to the drawing if not given. */
  view?: DocumentCamera;
}

/** tldraw's camera: a page point is at `(point + camera) * z` on the screen. */
export interface DocumentCamera {
  x: number;
  y: number;
  z: number;
}

/** A document shown as a pin on a face, edge or feature, or on the model as a whole (research/21, "Annotation"). */
export interface Annotation {
  id: string;
  /** The document; with heads, a version of it. */
  doc: AutomergeUrl;
  /** The tool the embed frame shows it with, as picked there; the document's default if not given. */
  tool?: string;
  /** Where it is pinned, as a comment is; on the model as a whole without one. */
  anchor?: CadAnchor;
  /** A named view's id, which opening it goes to. */
  view?: string;
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
export interface NamedView<Camera = CameraState> {
  id: string;
  name: string;
  camera: Camera;
}

/** A comment thread in Patchwork's format (patchwork-base codemirror-base/src/lib/extensions/comments.ts), with our anchor. */
export interface CommentThread {
  id: string;
  /** Sub-handle URLs of what it is about; ours are cursor ranges into `content`. */
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

/** What a thread on a feature, face or edge is about, beyond its range in `content`. */
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
