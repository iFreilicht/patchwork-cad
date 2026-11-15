import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { CadAnchor, CadModelDoc, Canvas, CanvasAnchor, LegacyCanvas, PlaneFrame, StoredCanvas } from "../types.ts";

/**
 * Canvases (research/21-embedding.md, "Canvas"): images on planes, to trace or compare, kept in the
 * model's document next to the code, under `cad.canvases`, as annotations are. They change nothing a
 * build returns. The edits run inside a `change` of the model document.
 */

export const canvases = (doc: CadModelDoc | undefined): StoredCanvas[] => doc?.cad?.canvases ?? [];

type Vec = [number, number, number];

/** Rounded: Automerge 3.4.1 stores 0.9999999999999999 in a list as 0 (research/10-view-state.md). */
const round = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
const roundAll = <T extends number[]>(v: T): T => v.map(round) as T;

/** A copy that shares nothing with `value` and has no undefined fields, which Automerge rejects; numbers in lists rounded. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === "number" ? round(v) : v))) as T;

export function addCanvas(doc: CadModelDoc, canvas: Canvas): void {
  // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
  if (!doc.cad) doc.cad = {};
  if (!doc.cad.canvases) doc.cad.canvases = [];
  doc.cad.canvases.push(copy(canvas));
}

export function removeCanvas(doc: CadModelDoc, id: string): void {
  const list = doc.cad?.canvases;
  const at = list?.findIndex((c) => c.id === id) ?? -1;
  if (list && at >= 0) list.splice(at, 1);
}

/** JSON with every object's keys sorted, as Automerge returns a map's keys in its own order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/** What a canvas's dialog edits: any of its fields but its id; an anchor of `null` is removed. */
export type CanvasPatch = Partial<Omit<Canvas, "id" | "anchor">> & { anchor?: CanvasAnchor | null };

/**
 * Sets the given fields of a canvas; a field that is the same already is left alone, so that it makes
 * no change. A canvas stored with a centre and width loses them once it has a scale.
 */
export function updateCanvas(doc: CadModelDoc, id: string, patch: CanvasPatch): void {
  const c = doc.cad?.canvases?.find((x) => x.id === id) as Record<string, unknown> | undefined;
  if (!c) return;
  for (const [key, value] of Object.entries(copy(patch))) {
    if (value === null) {
      if (key in c) delete c[key];
    } else if (canonical(c[key]) !== canonical(value)) c[key] = value;
  }
  if ("scale" in c) for (const key of ["center", "width"]) if (key in c) delete c[key];
}

// ---------- planes ----------

/** The origin planes, as the feature library's `plane()` has them: XZ faces -Y, so its y axis is +Z. */
export const ORIGIN_PLANES = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
} as const satisfies Record<string, PlaneFrame>;
export type OriginPlane = keyof typeof ORIGIN_PLANES;

export const isFrame = (plane: Canvas["plane"]): plane is PlaneFrame => "normal" in plane && "xDir" in plane;

/** An origin plane moved by `offset` along its normal, as `plane(name, offset)`. */
export function originPlane(name: OriginPlane, offset = 0): PlaneFrame {
  const p = ORIGIN_PLANES[name];
  return { origin: roundAll(p.normal.map((n) => n * offset) as Vec), normal: [...p.normal], xDir: [...p.xDir] };
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): Vec => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const near = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-6);

/** Which origin plane a frame is, and how far along its normal; undefined for any other frame. */
export function originPlaneOf(frame: PlaneFrame): { name: OriginPlane; offset: number } | undefined {
  for (const name of Object.keys(ORIGIN_PLANES) as OriginPlane[]) {
    const p = ORIGIN_PLANES[name];
    if (!near(frame.normal, p.normal) || !near(frame.xDir, p.xDir)) continue;
    const offset = dot(frame.origin, p.normal);
    if (near(frame.origin, p.normal.map((n) => n * offset))) return { name, offset: round(offset) };
  }
  return undefined;
}

/** What a canvas is on, for people: `XY`, `XZ at 5`, `extrude1.end`. */
export function planeLabel(plane: Canvas["plane"]): string {
  if (!isFrame(plane)) return plane.entityName ?? plane.feature ?? "a face";
  const o = originPlaneOf(plane);
  return o ? (o.offset ? `${o.name} at ${o.offset}` : o.name) : "a plane";
}

/** How far a face's normals may differ from their mean for the face to count as planar. */
const PLANAR = 1e-3;

/**
 * The frame of a planar face, as the feature library's `frameOnFace` makes it for a sketch on the
 * face: its outward normal, the world origin projected onto it, and world X projected onto it (world
 * Y where X is normal to it). From the face's mesh: its vertices and their normals, as flat lists.
 * Undefined if the face isn't planar.
 */
export function faceFrame(vertices: ArrayLike<number>, normals: ArrayLike<number>): PlaneFrame | undefined {
  const count = Math.min(vertices.length, normals.length) / 3;
  if (count < 1) return undefined;
  const sum: Vec = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) sum[k] = sum[k]! + normals[3 * i + k]!;
  const length = Math.hypot(...sum);
  if (length < 1e-9) return undefined;
  const n = sum.map((x) => x / length) as Vec;
  for (let i = 0; i < count; i++) {
    const v = [normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!];
    const l = Math.hypot(...v) || 1;
    if (1 - dot(v, n) / l > PLANAR) return undefined;
  }
  // All vertices on one plane, too: a face can have equal normals and steps, e.g. between two meshes.
  const d = dot([vertices[0]!, vertices[1]!, vertices[2]!], n);
  let size = 0;
  for (let i = 0; i < count; i++) size = Math.max(size, Math.abs(vertices[3 * i]! - vertices[0]!), Math.abs(vertices[3 * i + 1]! - vertices[1]!), Math.abs(vertices[3 * i + 2]! - vertices[2]!));
  for (let i = 0; i < count; i++) if (Math.abs(dot([vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!], n) - d) > PLANAR * Math.max(1, size)) return undefined;
  const wx: Vec = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const along = dot(wx, n);
  const x = wx.map((c, k) => c - along * n[k]!) as Vec;
  const xl = Math.hypot(...x);
  return { origin: roundAll(n.map((c) => c * d) as Vec), normal: roundAll(n), xDir: roundAll(x.map((c) => c / xl) as Vec) };
}

/** The y axis of a frame: normal × x, as a sketch's. */
export const yDirOf = (frame: PlaneFrame): Vec => cross(frame.normal, frame.xDir);

/** A point of a plane, by its coordinates in the plane, in world coordinates. */
export const onPlane = (frame: PlaneFrame, [x, y]: readonly [number, number]): Vec => {
  const yDir = yDirOf(frame);
  return [0, 1, 2].map((k) => frame.origin[k]! + frame.xDir[k]! * x + yDir[k]! * y) as Vec;
};

/** A point's coordinates in a plane, to a thousandth. */
export const planeCoordinates = (frame: PlaneFrame, p: readonly number[]): [number, number] => {
  const d = [0, 1, 2].map((k) => p[k]! - frame.origin[k]!);
  return [Math.round(dot(d, frame.xDir) * 1000) / 1000 + 0, Math.round(dot(d, yDirOf(frame)) * 1000) / 1000 + 0];
};

// ---------- the image on the plane ----------

/** An image's extent in its own units, y down: an SVG's `viewBox`, or its width and height from 0; a bitmap's pixels. */
export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element of an SVG that can be an anchor, and its bounding box in the SVG's user units. */
export interface ImageElement {
  attribute: string;
  value: string;
  /** Its name for people, as its editor keeps it, if it has one. */
  name?: string | undefined;
  box: ImageBox;
  /** Its text, shortened, for people. */
  label?: string | undefined;
}

/** Where an image lies on its plane: its point `at` at `position`, `scale` model units per unit of it, turned by `angle` about it. */
export type Placement = Pick<Canvas, "at" | "position" | "scale" | "angle">;

export const isLegacy = (canvas: StoredCanvas): canvas is LegacyCanvas => !("scale" in canvas);

const centreOf = (box: ImageBox): [number, number] => [box.x + box.width / 2, box.y + box.height / 2];

/**
 * The element an anchor names, if the image has it: by its attribute, else by its name, if one
 * element alone has it, as editors that number ids to keep them unique renumber them.
 */
export function anchorElement(anchor: CanvasAnchor, elements: readonly ImageElement[]): ImageElement | undefined {
  const exact = elements.find((e) => e.attribute === anchor.attribute && e.value === anchor.value);
  if (exact || anchor.name === undefined) return exact;
  const named = elements.filter((e) => e.name === anchor.name);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * Where a canvas's image lies, for the image as it is now: pinned by its anchor's centre if the image
 * has the anchor, else by `at`; a canvas stored with a centre and width by its image's centre.
 * `anchorLost` if it has an anchor that the image's elements, once known, don't have.
 */
export function placementOf(canvas: StoredCanvas, box: ImageBox, elements?: readonly ImageElement[]): { placement: Placement; anchorLost: boolean } {
  if (isLegacy(canvas)) return { placement: { at: centreOf(box), position: canvas.center, scale: canvas.width / box.width, angle: canvas.angle }, anchorLost: false };
  const element = canvas.anchor && elements && anchorElement(canvas.anchor, elements);
  const placement = { at: element ? centreOf(element.box) : canvas.at, position: canvas.position, scale: canvas.scale, angle: canvas.angle };
  return { placement, anchorLost: !!canvas.anchor && !!elements && !element };
}

/** A placement's fields as stored, rounded: what an edit of a canvas stored with a centre and width writes with it. */
export const storedPlacement = (p: Placement): Placement => ({ at: roundAll([...p.at]), position: roundAll([...p.position]), scale: round(p.scale), angle: round(p.angle) });

/** A point of the image, in its units, in the plane's coordinates. */
export function toPlane(p: Placement, [x, y]: readonly [number, number]): [number, number] {
  const a = (p.angle * Math.PI) / 180;
  const dx = (x - p.at[0]) * p.scale;
  const dy = -(y - p.at[1]) * p.scale;
  return [p.position[0] + dx * Math.cos(a) - dy * Math.sin(a), p.position[1] + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** A point of the image by its fractions of the box from its bottom left (`[0.5, 0.5]` is the centre), in the image's units. */
export const fromFractions = (box: ImageBox, [u, v]: readonly [number, number]): [number, number] => [box.x + u * box.width, box.y + (1 - v) * box.height];

/** A point of a canvas's image, by its fractions of the image from its bottom left, in the plane's coordinates. */
export const imagePoint = (p: Placement, box: ImageBox, uv: readonly [number, number]): [number, number] => toPlane(p, fromFractions(box, uv));

/** A box of the image, the whole image or its anchor's, as its corners in world coordinates, counterclockwise from its bottom left. */
export const canvasCorners = (p: Placement, frame: PlaneFrame, box: ImageBox): Vec[] =>
  ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map((uv) => onPlane(frame, imagePoint(p, box, uv)));

/** The placement that pins the image by `at` instead, leaving it where it is. */
export const repinned = (p: Placement, at: readonly [number, number]): Placement => ({ ...p, at: [at[0], at[1]], position: toPlane(p, at) });

/** The placement that puts the image's centre at `point` of the plane. */
export function centredAt(p: Placement, box: ImageBox, point: readonly [number, number]): Placement {
  const now = toPlane(p, centreOf(box));
  return { ...p, position: [p.position[0] + point[0] - now[0], p.position[1] + point[1] - now[1]] };
}

/** The named element of the image whose box has the point, the smallest of them; undefined if none has. */
export function elementAt(elements: readonly ImageElement[], [x, y]: readonly [number, number]): ImageElement | undefined {
  const inside = elements.filter(({ box: b }) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
  return inside.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
}

/**
 * Calibrate (research/21, "Canvas"), as Fusion's: two points of the image, as fractions of it, are
 * `distance` apart; the scale that makes them so. Undefined if the points are the same or the
 * distance isn't positive.
 */
export function calibratedScale(box: ImageBox, points: readonly [readonly [number, number], readonly [number, number]], distance: number): number | undefined {
  const [[u0, v0], [u1, v1]] = points;
  // Their distance in the image's units.
  const unit = Math.hypot((u1 - u0) * box.width, (v1 - v0) * box.height);
  if (!(unit > 1e-9) || !(distance > 0)) return undefined;
  return round(distance / unit);
}

/** How far apart two points of the image are on the canvas, in model units. */
export const imageDistance = (p: Pick<Placement, "scale">, box: ImageBox, [[u0, v0], [u1, v1]]: readonly [readonly [number, number], readonly [number, number]]) =>
  Math.hypot((u1 - u0) * box.width, (v1 - v0) * box.height) * p.scale;

/** A new canvas of image `image`, named `name`, on `plane`: its image's centre at `center`, `width` wide, half see-through. */
export const newCanvas = (id: string, image: AutomergeUrl, name: string, plane: PlaneFrame | CadAnchor, center: [number, number], width: number, box: ImageBox): Canvas => ({
  id,
  name,
  image,
  plane,
  ...storedPlacement({ at: centreOf(box), position: center, scale: width / box.width, angle: 0 }),
  opacity: 0.5,
  through: false,
});

/** A default width: a round number near `size`, the model's largest extent, or 100 without a model. */
export function defaultWidth(size: number | undefined): number {
  if (!size || !Number.isFinite(size) || size <= 0) return 100;
  const step = 10 ** Math.floor(Math.log10(size));
  return round(Math.max(step, Math.round(size / step) * step));
}
