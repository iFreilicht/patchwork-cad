/**
 * Experiment (research/21, "Canvas"): documents that aren't images on canvases, shown by their own
 * tools. What part of a tldraw drawing a canvas shows is tldraw's camera, which the tool reads from
 * `localStorage` when it mounts and writes there as it moves (tldraw5's `TldrawInner`); so the canvas
 * keeps one, sets it before a tool mounts, and reads back where it was left after editing in place.
 */
import type { DocumentCamera } from "../types.ts";

/** The width in CSS pixels a document is laid out at on a canvas, before it is scaled to the canvas's width. */
export const DOCUMENT_PX = 900;

/** A document that isn't an image is laid out this much higher than wide, unless its canvas says otherwise. */
export const DEFAULT_DOCUMENT_ASPECT = 0.75;

/** Whether a document is a tldraw drawing, of tldraw5's datatype or an earlier one's. */
export const isTldraw = (value: unknown): boolean => {
  const type = (value as { "@patchwork"?: { type?: unknown } } | undefined)?.["@patchwork"]?.type;
  return typeof type === "string" && type.startsWith("tldraw");
};

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Where a tldraw drawing's shapes are on its page: the boxes of the shapes on the page itself, not
 * in a frame or group, from their position and size, or the points of an arrow, line or freehand
 * stroke. Rotation is ignored. Undefined for a drawing without shapes.
 */
export function tldrawBounds(value: unknown): Box | undefined {
  const store = (value as { store?: Record<string, unknown> } | undefined)?.store;
  if (!store) return undefined;
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  for (const record of Object.values(store)) {
    const r = record as { typeName?: string; parentId?: string; x?: number; y?: number; props?: Record<string, unknown> };
    if (r.typeName !== "shape" || !r.parentId?.startsWith("page:") || typeof r.x !== "number" || typeof r.y !== "number") continue;
    const p = r.props ?? {};
    const scale = typeof p["scale"] === "number" ? p["scale"] : 1;
    const point = (q: unknown) => {
      const v = q as { x?: unknown; y?: unknown } | undefined;
      if (typeof v?.x === "number" && typeof v.y === "number") add(r.x! + v.x * scale, r.y! + v.y * scale);
    };
    if (typeof p["w"] === "number" && typeof p["h"] === "number") {
      add(r.x, r.y);
      add(r.x + p["w"] * scale, r.y + (p["h"] + (typeof p["growY"] === "number" ? p["growY"] : 0)) * scale);
    } else if (p["start"] || p["end"]) {
      point(p["start"]);
      point(p["end"]);
    } else if (p["points"] && typeof p["points"] === "object") {
      for (const q of Object.values(p["points"] as object)) point(q);
    } else if (Array.isArray(p["segments"])) {
      for (const s of p["segments"] as { points?: unknown[] }[]) for (const q of s.points ?? []) point(q);
    } else {
      // A note, text or anything else without a size: about a note's.
      add(r.x, r.y);
      add(r.x + 200 * scale, r.y + 200 * scale);
    }
  }
  return box.minX <= box.maxX ? box : undefined;
}

/**
 * The tldraw camera that shows `box` in the middle of a view `width` × `height` pixels large, with a
 * margin of `margin` of the view on each side. tldraw maps a page point to the screen as
 * `(point + camera) * camera.z`.
 */
export function fitCamera(box: Box, width: number, height: number, margin = 0.05): DocumentCamera {
  const w = Math.max(box.maxX - box.minX, 1);
  const h = Math.max(box.maxY - box.minY, 1);
  const z = Math.min(width / w, height / h) * (1 - 2 * margin);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return { x: round(width / (2 * z) - (box.minX + box.maxX) / 2), y: round(height / (2 * z) - (box.minY + box.maxY) / 2), z: round(z) };
}

/**
 * The same part of the page in a view `to` pixels wide instead of `from`: the zoom scales, and the
 * page point at the view's top left stays.
 */
export const scaleCamera = (camera: DocumentCamera, from: number, to: number): DocumentCamera => ({ ...camera, z: (camera.z * to) / from });

/** Where tldraw5 keeps a tool's camera for document `url`, as the tool is given it. */
const cameraKey = (url: string) => `${url}-camera`;

/** Sets the camera the tldraw tool mounts with for document `url`. */
export function presetCamera(url: string, camera: DocumentCamera): void {
  try {
    localStorage.setItem(cameraKey(url), JSON.stringify(camera));
  } catch {
    // Without storage, the tool shows its own default.
  }
}

/** The camera the tldraw tool last left for document `url`, if any. */
export function storedCamera(url: string): DocumentCamera | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(cameraKey(url)) ?? "null") as Partial<DocumentCamera> | null;
    return value && typeof value.x === "number" && typeof value.y === "number" && typeof value.z === "number" ? { x: value.x, y: value.y, z: value.z } : undefined;
  } catch {
    return undefined;
  }
}

/** The class of a document's frame on a canvas, laid out at `DOCUMENT_PX` and placed in 3D. */
export const DOCUMENT_FRAME = "cad-model__document-canvas";

let measuring = false;
/**
 * Makes elements inside a document's frame measure as laid out, before the 3D transform: their box
 * relative to the frame at the frame's own size. A tool sizes and culls by its container's box on the
 * screen, which the projection distorts, in Firefox to tens of thousands of pixels for a face-on frame,
 * which makes tldraw's overlay canvas larger than allowed and crashes it. Elements elsewhere measure as
 * they always do. Installed once per page.
 */
export function measureFramesAsLaidOut(): void {
  if (measuring) return;
  measuring = true;
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const frame = this instanceof HTMLElement ? this.closest(`.${DOCUMENT_FRAME}`) : null;
    if (!frame || !(this instanceof HTMLElement)) return original.call(this);
    let x = 0;
    let y = 0;
    for (let at: HTMLElement | null = this; at && at !== frame; at = at.offsetParent as HTMLElement | null) {
      x += at.offsetLeft;
      y += at.offsetTop;
      if (!frame.contains(at.offsetParent)) break;
    }
    return new DOMRect(x, y, this.offsetWidth, this.offsetHeight);
  };
}
