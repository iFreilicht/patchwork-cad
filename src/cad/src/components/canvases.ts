/**
 * Canvases (research/21-embedding.md, "Canvas"): images on planes, drawn in the editor's view to
 * trace or compare. Their edits, where they are in a view, and their images, decoded once per
 * version of the image document.
 */
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape } from "../kernel/protocol.ts";
import { addCanvas, canvases as canvasesOf, defaultWidth, faceFrame, isFrame, newCanvas, originPlane, planeCoordinates, removeCanvas, updateCanvas, type CanvasPatch } from "../model/canvases.ts";
import { newId } from "../model/views.ts";
import type { CadAnchor, CadModelDoc, Canvas, PlaneFrame } from "../types.ts";
import type { Model } from "./createModel.ts";
import type { DocumentInfo } from "./documentInfo.ts";
import { fileBytes, fileKind, fileText, isFile } from "./imports.ts";
import { createLocated } from "./locate.ts";
import type { Entity } from "./Viewer.tsx";

export interface CanvasStore {
  list: Accessor<Canvas[]>;
  /** Adds a canvas of `image` and returns its id. */
  add(image: AutomergeUrl, name: string, plane: PlaneFrame | CadAnchor, center: [number, number], width: number): string;
  remove(id: string): void;
  update(id: string, patch: CanvasPatch): void;
}

/** The canvases of a model, following its document. */
export function createCanvasStore(handle: DocHandle<CadModelDoc>): CanvasStore {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));
  // Edits of the code mustn't look like a change of the canvases.
  const list = createMemo(() => canvasesOf(doc()), [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  return {
    list,
    add(image, name, plane, center, width) {
      const id = newId();
      handle.change((d) => addCanvas(d, newCanvas(id, image, name, plane, center, width)));
      return id;
    },
    remove: (id) => handle.change((d) => removeCanvas(d, id)),
    update: (id, patch) => handle.change((d) => updateCanvas(d, id, patch)),
  };
}

/** The vertices of one face of a meshed body and their normals, as flat lists; computed per triangle where the mesh has no normals. */
function faceMesh(shape: MeshedShape, index: number): { vertices: number[]; normals: number[] } {
  const { vertices, triangles, normals, faceGroups } = shape.faces;
  const out = { vertices: [] as number[], normals: [] as number[] };
  (faceGroups ?? []).forEach((g, gi) => {
    if ((shape.faceIndex?.[gi] ?? -1) !== index) return;
    for (let t = g.start; t + 2 < g.start + g.count; t += 3) {
      const ids = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
      const p = ids.map((i) => [vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!]);
      const flat = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
      const other = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
      const n = [flat[1]! * other[2]! - flat[2]! * other[1]!, flat[2]! * other[0]! - flat[0]! * other[2]!, flat[0]! * other[1]! - flat[1]! * other[0]!];
      for (const [k, i] of ids.entries()) {
        out.vertices.push(...p[k]!);
        out.normals.push(...(normals ? [normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!] : n));
      }
    }
  });
  return out;
}

/** The frame of face `index` of a shown body, if it is planar. */
export const frameOfFace = (shape: MeshedShape, index: number): PlaneFrame | undefined => {
  const { vertices, normals } = faceMesh(shape, index);
  return faceFrame(vertices, normals);
};

/** The bounding box of points given as a flat list, or of those `indices` name; undefined without any. */
function box(vertices: ArrayLike<number>, indices?: Iterable<number>): { min: number[]; max: number[] } | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const add = (i: number) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, vertices[3 * i + k]!);
      max[k] = Math.max(max[k]!, vertices[3 * i + k]!);
    }
  };
  if (indices) for (const i of indices) add(i);
  else for (let i = 0; 3 * i + 2 < vertices.length; i++) add(i);
  return min[0]! <= max[0]! ? { min, max } : undefined;
}

const centreOf = (b: { min: number[]; max: number[] }) => b.min.map((m, k) => (m + b.max[k]!) / 2);

/** The centre of face `index`'s bounding box. */
function faceCentre(shape: MeshedShape, index: number): number[] | undefined {
  const { triangles, faceGroups } = shape.faces;
  const indices: number[] = [];
  (faceGroups ?? []).forEach((g, gi) => {
    if ((shape.faceIndex?.[gi] ?? -1) === index) indices.push(...triangles.slice(g.start, g.start + g.count));
  });
  const b = box(shape.faces.vertices, indices);
  return b && centreOf(b);
}

/** Where a canvas goes: its plane, its centre there, and its width; a notice if it isn't where it was dropped. */
export interface CanvasPlacement {
  plane: PlaneFrame | CadAnchor;
  center: [number, number];
  width: number;
  notice?: string | undefined;
}

/**
 * Where a new canvas goes (research/21, "Canvas"): on the face it was dropped on, anchored as
 * `anchor`, if that is planar, centred at `point` where it was dropped or else on the face; otherwise
 * on XY, under the model's centre. A round number about as wide as the model.
 */
export function placeNewCanvas(shown: MeshedShape[], face: Entity | undefined, anchor: CadAnchor | undefined, point: readonly number[] | undefined): CanvasPlacement {
  const boxes = shown.flatMap((s) => box(s.faces.vertices) ?? []);
  const all = boxes.length ? box(boxes.flatMap((b) => [...b.min, ...b.max])) : undefined;
  const width = defaultWidth(all && Math.max(...all.max.map((m, k) => m - all.min[k]!)));
  const shape = face && shown.find((s) => s.body === face.body);
  const frame = face && shape ? frameOfFace(shape, face.index) : undefined;
  if (face && shape && frame && anchor) return { plane: anchor, center: planeCoordinates(frame, point ?? faceCentre(shape, face.index) ?? frame.origin), width };
  const xy = originPlane("XY");
  return { plane: xy, center: planeCoordinates(xy, all ? centreOf(all) : [0, 0, 0]), width, notice: face ? "The face isn't planar: the canvas is on XY." : undefined };
}

/** A canvas's plane on face `index` of a shown body, centred on the face; undefined if it isn't planar. */
export function onFace(shape: MeshedShape, index: number, anchor: CadAnchor): Pick<Canvas, "plane" | "center"> | undefined {
  const frame = frameOfFace(shape, index);
  return frame && { plane: anchor, center: planeCoordinates(frame, faceCentre(shape, index) ?? frame.origin) };
}

/** A canvas, with the plane it is on in the view now. */
export interface PlacedCanvas {
  canvas: Canvas;
  /** Its plane: an origin plane's frame, or its face's; none while its face isn't shown or isn't planar. */
  frame: PlaneFrame | undefined;
  /** Why it isn't shown: its face is gone from the whole model, isn't shown here (e.g. past the timeline marker), or isn't planar. */
  problem: "gone" | "hidden" | "not planar" | undefined;
}

/**
 * Where the canvases are in a view: on an origin plane, or on a face, which the worker resolves
 * against the shown bodies, as it does an annotation's (research/21, "Annotation"), and whose frame
 * comes from its mesh, so that a canvas follows its face as the model changes.
 */
export function placeCanvases(options: { list: Accessor<Canvas[]>; model: Model; shown: Accessor<MeshedShape[]>; complete: Accessor<boolean> }): Accessor<PlacedCanvas[]> {
  const onFaces = createMemo(() => options.list().flatMap((c) => (!isFrame(c.plane) && c.plane.entity ? [{ key: c.id, ref: c.plane.entity }] : [])));
  const located = createLocated(options.model, options.shown, onFaces);
  return createMemo(() =>
    options.list().map((canvas): PlacedCanvas => {
      if (isFrame(canvas.plane)) return { canvas, frame: canvas.plane, problem: undefined };
      const found = located().find((l) => l.item.key === canvas.id)?.found.find((p) => p.indices.length);
      const shape = found && options.shown().find((s) => s.body === found.body);
      if (!found || !shape) return { canvas, frame: undefined, problem: options.complete() && options.shown().length > 0 ? "gone" : "hidden" };
      const frame = frameOfFace(shape, found.indices[0]!);
      return { canvas, frame, problem: frame ? undefined : "not planar" };
    }),
  );
}

/** A canvas's image, drawn once: what the view makes its texture of, and its height over its width. */
export interface CanvasImage {
  image: HTMLCanvasElement;
  aspect: number;
}

/** The longest side an image is drawn with: WebGL takes textures of 4096 pixels everywhere, and an SVG is drawn at that size. */
const MAX_SIDE = 4096;

/** An SVG's size, from its root's `width` and `height`, else its `viewBox`: Firefox draws one without width and height at 0 × 0. */
function svgSize(text: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!root) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const length = (value: string | undefined) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : undefined);
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const [width, height] = [length(attribute("width")), length(attribute("height"))];
  if (width && height) return { width, height };
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! };
  return undefined;
}

/** An SVG whose root has a `width` and `height`, from its `viewBox` if it had none: Firefox draws one without them onto a canvas at no size. */
export function sizedSvg(text: string): string {
  const size = svgSize(text);
  const root = /<svg\b[^>]*>/i.exec(text);
  const length = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*[\\d.]+\\s*(px)?\\s*["']`, "i").test(root?.[0] ?? "");
  if (!size || !root || (length("width") && length("height"))) return text;
  const bare = root[0].replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  const sized = bare.replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  return text.slice(0, root.index) + sized + text.slice(root.index + root[0].length);
}

/** Draws an image file's content, an SVG as an image, never as markup (research/21, "Security"); rejects with why not. */
async function drawImage(bytes: Uint8Array, mimeType: string, svg: string | undefined): Promise<CanvasImage> {
  const content = svg !== undefined ? new TextEncoder().encode(sizedSvg(svg)) : bytes;
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: mimeType }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("it can't be decoded as an image");
    });
    const size = svg !== undefined ? svgSize(svg) : undefined;
    const width = img.naturalWidth || size?.width || 0;
    const height = img.naturalHeight || size?.height || 0;
    if (!width || !height) throw new Error("it has no size");
    // A bitmap at most as large as it is, an SVG as large as a texture can be.
    const scale = svg !== undefined ? MAX_SIDE / Math.max(width, height) : Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("it can't be drawn");
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { image: canvas, aspect: height / width };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Whether a document is an image a canvas can show: a PNG, JPEG or other image file, or an SVG. */
export const isImage = (value: unknown): boolean => isFile(value) && (fileKind(value) === "image" || fileKind(value) === "svg");

/** A canvas's image as it is now: loading, drawn, or why it can't be shown. */
export type ImageState = { status: "loading" } | ({ status: "ready" } & CanvasImage) | { status: "unavailable"; problem: string };

/**
 * The images of canvases, by their documents' URLs (with heads for a version), each drawn once per
 * version of its document and again when it changes.
 */
export function createCanvasImages(info: (url: string) => DocumentInfo, urls: Accessor<string[]>): (url: string) => ImageState {
  const states = new Map<string, { heads: string; state: ImageState }>();
  const [version, setVersion] = createSignal(0);
  const set = (url: string, heads: string, state: ImageState) => {
    states.set(url, { heads, state });
    setVersion((n) => n + 1);
  };
  createEffect(() => {
    for (const url of urls()) {
      const i = info(url);
      const heads = JSON.stringify(i.heads ?? null);
      const current = states.get(url);
      if (i.status === "loading") {
        if (!current) set(url, heads, { status: "loading" });
        continue;
      }
      if (current && current.heads === heads) continue;
      if (i.status === "unavailable") {
        set(url, heads, { status: "unavailable", problem: i.problem ?? "it isn't available" });
        continue;
      }
      const value = i.value;
      if (!isImage(value) || !isFile(value)) {
        set(url, heads, { status: "unavailable", problem: "it isn't an image" });
        continue;
      }
      const bytes = fileBytes(value);
      if (!bytes) {
        set(url, heads, { status: "unavailable", problem: "it has no content" });
        continue;
      }
      const svg = fileKind(value) === "svg" ? (fileText(value) ?? "") : undefined;
      const mimeType = svg !== undefined ? "image/svg+xml" : typeof value.mimeType === "string" && value.mimeType.startsWith("image/") ? value.mimeType : "application/octet-stream";
      // The last drawing stays while the new version is drawn.
      set(url, heads, current?.state.status === "ready" ? current.state : { status: "loading" });
      drawImage(bytes, mimeType, svg).then(
        (drawn) => states.get(url)?.heads === heads && set(url, heads, { status: "ready", ...drawn }),
        (error: unknown) => states.get(url)?.heads === heads && set(url, heads, { status: "unavailable", problem: String((error as Error)?.message ?? error) }),
      );
    }
  });
  return (url) => {
    version();
    return states.get(url)?.state ?? { status: "loading" };
  };
}
