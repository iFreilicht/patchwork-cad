/**
 * Canvases (research/21-embedding.md, "Canvas"): images on planes, drawn in the editor's view to
 * trace or compare. Their edits, where they are in a view, and their images, decoded once per
 * version of the image document.
 */
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape } from "../kernel/protocol.ts";
import { addCanvas, anchorElement, canvases as canvasesOf, defaultWidth, faceFrame, isFrame, newCanvas, originPlane, placementOf, planeCoordinates, removeCanvas, updateCanvas, type CanvasPatch, type ImageBox, type ImageElement, type Placement } from "../model/canvases.ts";
import { newId } from "../model/views.ts";
import type { CadAnchor, CadModelDoc, Canvas, PlaneFrame, StoredCanvas } from "../types.ts";
import type { Model } from "./createModel.ts";
import type { DocumentInfo } from "./documentInfo.ts";
import { fileBytes, fileKind, fileText, isFile } from "./imports.ts";
import { DEFAULT_DOCUMENT_ASPECT, DOCUMENT_PX } from "./documentCanvases.ts";
import { createLocated } from "./locate.ts";
import type { Entity } from "./Viewer.tsx";

export interface CanvasStore {
  list: Accessor<StoredCanvas[]>;
  /** Adds a canvas of `image`, whose extent is `box`, and returns its id. */
  add(image: AutomergeUrl, name: string, plane: PlaneFrame | CadAnchor, center: [number, number], width: number, box: ImageBox): string;
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
    add(image, name, plane, center, width, box) {
      const id = newId();
      handle.change((d) => addCanvas(d, newCanvas(id, image, name, plane, center, width, box)));
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

/** A canvas's plane on face `index` of a shown body, and the face's centre there; undefined if it isn't planar. */
export function onFace(shape: MeshedShape, index: number, anchor: CadAnchor): { plane: Canvas["plane"]; center: [number, number] } | undefined {
  const frame = frameOfFace(shape, index);
  return frame && { plane: anchor, center: planeCoordinates(frame, faceCentre(shape, index) ?? frame.origin) };
}

/** A canvas, with the plane it is on in the view now, and where its image lies there once it is drawn. */
export interface PlacedCanvas {
  canvas: StoredCanvas;
  /** Its plane: an origin plane's frame, or its face's; none while its face isn't shown or isn't planar. */
  frame: PlaneFrame | undefined;
  /** Why it isn't shown: its face is gone from the whole model, isn't shown here (e.g. past the timeline marker), or isn't planar. */
  problem: "gone" | "hidden" | "not planar" | undefined;
  /**
   * Its image, drawn, and where it lies on the plane: pinned by its anchor, or else as stored. A
   * document that isn't an image, shown live by its tool (research/22), has no drawing, and its box
   * is what it is laid out in.
   */
  image?: { image: HTMLCanvasElement | undefined; document: boolean; box: ImageBox; elements: ImageElement[] | undefined; placement: Placement; anchor: ImageElement | undefined } | undefined;
  /** It has an anchor that its image doesn't have. */
  anchorLost: boolean;
}

/**
 * Where the canvases are in a view: on an origin plane, or on a face, which the worker resolves
 * against the shown bodies, as it does an annotation's (research/21, "Annotation"), and whose frame
 * comes from its mesh, so that a canvas follows its face as the model changes.
 */
export function placeCanvases(options: { list: Accessor<StoredCanvas[]>; model: Model; shown: Accessor<MeshedShape[]>; complete: Accessor<boolean>; image(url: string): ImageState }): Accessor<PlacedCanvas[]> {
  const onFaces = createMemo(() => options.list().flatMap((c) => (!isFrame(c.plane) && c.plane.entity ? [{ key: c.id, ref: c.plane.entity }] : [])));
  const located = createLocated(options.model, options.shown, onFaces);
  const frameOf = (canvas: StoredCanvas): Pick<PlacedCanvas, "frame" | "problem"> => {
    if (isFrame(canvas.plane)) return { frame: canvas.plane, problem: undefined };
    const found = located().find((l) => l.item.key === canvas.id)?.found.find((p) => p.indices.length);
    const shape = found && options.shown().find((s) => s.body === found.body);
    if (!found || !shape) return { frame: undefined, problem: options.complete() && options.shown().length > 0 ? "gone" : "hidden" };
    const frame = frameOfFace(shape, found.indices[0]!);
    return { frame, problem: frame ? undefined : "not planar" };
  };
  return createMemo(() =>
    options.list().map((canvas): PlacedCanvas => {
      const state = options.image(canvas.image);
      if (state.status === "document") {
        const box = documentBox(canvas);
        return { canvas, ...frameOf(canvas), image: { image: undefined, document: true, box, elements: undefined, placement: placementOf(canvas, box).placement, anchor: undefined }, anchorLost: false };
      }
      if (state.status !== "ready") return { canvas, ...frameOf(canvas), anchorLost: false };
      const { placement, anchorLost } = placementOf(canvas, state.box, state.elements);
      const anchor = "anchor" in canvas && canvas.anchor && state.elements ? anchorElement(canvas.anchor, state.elements) : undefined;
      return { canvas, ...frameOf(canvas), image: { image: state.image, document: false, box: state.box, elements: state.elements, placement, anchor }, anchorLost };
    }),
  );
}

/** Experiment: the box a document that isn't an image is laid out in on a canvas, `DOCUMENT_PX` wide (research/22). */
export const documentBox = (canvas: Pick<StoredCanvas, "aspect">): ImageBox => ({ x: 0, y: 0, width: DOCUMENT_PX, height: DOCUMENT_PX * (canvas.aspect ?? DEFAULT_DOCUMENT_ASPECT) });

/** A canvas's image, drawn once: what the view makes its texture of, its extent in its own units, and an SVG's named elements, once measured. */
export interface CanvasImage {
  image: HTMLCanvasElement;
  box: ImageBox;
  elements: ImageElement[] | undefined;
}

/** The longest side an image is drawn with: WebGL takes textures of 4096 pixels everywhere, and an SVG is drawn at that size. */
const MAX_SIDE = 4096;

/** An SVG's root's `width`, `height` and `viewBox`, as far as they are numbers. */
function svgRoot(text: string): { width?: number | undefined; height?: number | undefined; viewBox?: ImageBox | undefined } | undefined {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!root) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const length = (value: string | undefined) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : undefined);
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const viewBox = box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { x: box[0]!, y: box[1]!, width: box[2]!, height: box[3]! } : undefined;
  return { width: length(attribute("width")), height: length(attribute("height")), viewBox };
}

/** An SVG's size, from its root's `width` and `height`, else its `viewBox`: Firefox draws one without width and height at 0 × 0. */
function svgSize(text: string): { width: number; height: number } | undefined {
  const root = svgRoot(text);
  if (root?.width && root.height) return { width: root.width, height: root.height };
  return root?.viewBox && { width: root.viewBox.width, height: root.viewBox.height };
}

/** An SVG's extent in its user units: its `viewBox`, else its size from 0. */
export function svgBox(text: string): ImageBox | undefined {
  const root = svgRoot(text);
  if (root?.viewBox) return root.viewBox;
  return root?.width && root.height ? { x: 0, y: 0, width: root.width, height: root.height } : undefined;
}

/** The elements an anchor can name: by draw.io's `data-cell-id`, which stays from one export to the next while its `id`s don't, else by `id` (research/21, "Canvas"). */
const ANCHOR_ATTRIBUTES = ["data-cell-id", "id"];

/** An element's name as its editor keeps it besides its `id`: Illustrator's, Affinity's, Inkscape's, else its `<title>`, as Graphviz writes a node's. */
const NAME_ATTRIBUTES = ["data-name", "serif:id", "inkscape:label"];
const nameOf = (element: Element): string | undefined =>
  NAME_ATTRIBUTES.map((a) => element.getAttribute(a)).find((v): v is string => !!v) ?? ([...element.children].find((c) => c.localName === "title")?.textContent?.trim() || undefined);

/**
 * A layer, which holds what is drawn rather than being something drawn, and whose box changes with
 * everything on it: Inkscape's, or draw.io's root cell and the cells right under it.
 */
function isLayer(element: Element): boolean {
  if (element.getAttribute("inkscape:groupmode") === "layer") return true;
  if (!element.hasAttribute("data-cell-id")) return false;
  const parent = element.parentElement?.closest("[data-cell-id]");
  return !parent || !parent.parentElement?.closest("[data-cell-id]");
}

/** What an SVG draws, of which an element's box is made. */
const SHAPES = "path, rect, circle, ellipse, line, polyline, polygon, text, image, use";

/**
 * The box of what an element draws, in the root's user units: its shapes', each through its own
 * transforms, without HTML in a `foreignObject`, whose box is what it is laid out in, e.g. draw.io's
 * labels' `width="100%" height="100%"`, the whole SVG; undefined if it draws nothing.
 */
function drawnBox(element: SVGGraphicsElement, toRoot: DOMMatrix): ImageBox | undefined {
  const shapes = element.matches(SHAPES) ? [element] : [...element.querySelectorAll<SVGGraphicsElement>(SHAPES)];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of shapes) {
    const own = shape.closest("foreignObject") || shape.closest(UNDRAWN) ? null : shape.getScreenCTM();
    if (!own) continue;
    const b = shape.getBBox();
    if (!(b.width > 0 || b.height > 0)) continue;
    const m = toRoot.multiply(own);
    for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]] as const) {
      xs.push(m.a * x + m.c * y + m.e);
      ys.push(m.b * x + m.d * y + m.f);
    }
  }
  if (!xs.length) return undefined;
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Elements whose boxes aren't drawn where they are: definitions, and what they are made of. */
const UNDRAWN = "defs, clipPath, mask, pattern, marker, symbol, linearGradient, radialGradient, filter";

/**
 * The named elements of an SVG and their bounding boxes in its user units (research/21, "Canvas"),
 * measured where the browser lays the SVG out: in a frame that runs no scripts, as it lacks
 * `allow-scripts`, and loads nothing, by its Content-Security-Policy, since the SVG is never shown
 * as markup (research/21, "Security").
 */
export async function measureSvg(text: string): Promise<ImageElement[]> {
  const parsed = new DOMParser().parseFromString(sizedSvg(text), "image/svg+xml").documentElement;
  if (parsed.localName !== "svg") return [];
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:100px;height:100px;border:0;visibility:hidden;pointer-events:none";
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="margin:0"></body>`;
  try {
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    document.body.append(frame);
    await loaded;
    const doc = frame.contentDocument;
    if (!doc) return [];
    const root = doc.importNode(parsed, true) as unknown as SVGSVGElement;
    doc.body.append(root);
    const toRoot = root.getScreenCTM()?.inverse();
    if (!toRoot) return [];
    const seen = new Set<string>();
    const elements: ImageElement[] = [];
    for (const element of root.querySelectorAll<SVGGraphicsElement>(ANCHOR_ATTRIBUTES.map((a) => `[${a}]`).join(","))) {
      if (typeof element.getBBox !== "function" || element.closest(UNDRAWN) || isLayer(element)) continue;
      const attribute = ANCHOR_ATTRIBUTES.find((a) => element.hasAttribute(a))!;
      const value = element.getAttribute(attribute)!;
      const key = `${attribute}=${value}`;
      if (seen.has(key)) continue;
      const box = drawnBox(element, toRoot);
      if (!box) continue;
      seen.add(key);
      const text = [...element.querySelectorAll("text")].filter((t) => !t.closest("foreignObject")).map((t) => t.textContent).join(" ").replace(/\s+/g, " ").trim();
      elements.push({ attribute, value, name: nameOf(element), box, label: text ? (text.length > 30 ? `${text.slice(0, 29)}…` : text) : undefined });
    }
    return elements;
  } finally {
    frame.remove();
  }
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

/**
 * An SVG without its `foreignObject`s, HTML in the SVG: Chromium and WebKit won't let a canvas
 * that drew HTML out of an SVG image become a texture ("tainted"). With `all` false, only those in
 * a `switch` with something else to draw, which it draws instead, as draw.io's labels have a `text`.
 */
export function withoutHtml(svg: string, all = true): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return svg;
  const html = [...doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", "foreignObject")];
  const fallback = (e: Element) => e.parentElement?.localName === "switch" && e.parentElement.children.length > 1;
  const removed = html.filter((e) => all || fallback(e));
  if (!removed.length) return svg;
  for (const element of removed) element.remove();
  return new XMLSerializer().serializeToString(doc);
}

/** Whether a canvas can be read, and so made a texture of. */
const readable = (context: CanvasRenderingContext2D) => {
  try {
    context.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
};

/**
 * Draws an image file's content, an SVG as an image, never as markup (research/21, "Security"): an
 * SVG with what its HTML falls back on, alike in every browser, and without its other HTML if the
 * browser won't let it be a texture otherwise. Rejects with why not.
 */
async function drawImage(bytes: Uint8Array, mimeType: string, svg: string | undefined): Promise<CanvasImage> {
  if (svg === undefined) return (await drawOnce(bytes, mimeType, svg)).image;
  const fallen = withoutHtml(svg, false);
  const drawn = await drawOnce(new TextEncoder().encode(sizedSvg(fallen)), mimeType, svg);
  // Only HTML without a fallback is left to taint it; reading a tainted canvas is an error in WebKit's console, so it is read only then.
  if (!/<foreignObject\b/.test(fallen) || readable(drawn.context)) return drawn.image;
  const again = await drawOnce(new TextEncoder().encode(sizedSvg(withoutHtml(svg))), mimeType, svg);
  if (!readable(again.context)) throw new Error("the browser won't draw it here");
  return again.image;
}

async function drawOnce(content: Uint8Array, mimeType: string, svg: string | undefined): Promise<{ image: CanvasImage; context: CanvasRenderingContext2D }> {
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
    const box = (svg !== undefined && svgBox(svg)) || { x: 0, y: 0, width, height };
    // A bitmap at most as large as it is, an SVG as large as a texture can be.
    const scale = svg !== undefined ? MAX_SIDE / Math.max(width, height) : Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("it can't be drawn");
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { image: { image: canvas, box, elements: undefined }, context };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** An image file's extent in its own units (research/21, "Canvas"): an SVG's from its root, a bitmap's pixels, decoded; undefined if it has none. */
export async function imageBox(value: unknown): Promise<ImageBox | undefined> {
  if (!isFile(value)) return undefined;
  if (fileKind(value) === "svg") return svgBox(fileText(value) ?? "");
  const bytes = fileBytes(value);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth && img.naturalHeight ? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight } : undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Whether a document is an image a canvas can show: a PNG, JPEG or other image file, or an SVG. */
export const isImage = (value: unknown): boolean => isFile(value) && (fileKind(value) === "image" || fileKind(value) === "svg");

/** A canvas's image as it is now: loading, drawn, or why it can't be shown. */
export type ImageState = { status: "loading" } | ({ status: "ready" } & CanvasImage) | { status: "unavailable"; problem: string } | { status: "document" };

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
      // Experiment: any other document is shown live by its tool.
      if (!isImage(value) || !isFile(value)) {
        set(url, heads, { status: "document" });
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
      // An SVG's elements with it, so that an anchored canvas doesn't lie by its fallback in between.
      Promise.all([drawImage(bytes, mimeType, svg), svg !== undefined ? measureSvg(svg).catch(() => []) : undefined]).then(
        ([drawn, elements]) => states.get(url)?.heads === heads && set(url, heads, { status: "ready", ...drawn, elements }),
        (error: unknown) => states.get(url)?.heads === heads && set(url, heads, { status: "unavailable", problem: String((error as Error)?.message ?? error) }),
      );
    }
  });
  return (url) => {
    version();
    return states.get(url)?.state ?? { status: "loading" };
  };
}
