import { Color } from "three";
import type { MeshedShape, ShownSketch } from "../kernel/protocol.ts";
import { computeBounds, computeNormals, encodeGLB, MODE, type Bounds, type GlbMesh, type GlbNode } from "./glb.js";

/** Edges are drawn in this, unlit, so that they read on a body in the scene's theme colour, which an edge without a material would take too. */
export const EDGE_COLOR = "#1e1e1e";
/** Sketches main returns, as the editor draws them. */
export const SKETCH_COLOR = "#2f6fd6";
/** Edges and sketches are drawn this wide, in CSS pixels, as the editor draws them (the scene's README, "GLB conventions": wide lines). */
export const LINE_WIDTH = 1.5;
/** The layer of the sketches main returns. */
export const SKETCH_LAYER = "sketches";
/** A canvas's layer, by its id: each is shown and hidden on its own. */
export const canvasLayer = (id: string) => `canvas:${id}`;
/** How far a canvas lies off its plane, in model units, so that it shows over a face it lies on, as the editor's polygon offset does. */
export const CANVAS_LIFT = 0.01;

/** An image canvas as a build places it (canvasGlb.ts). */
export interface GlbCanvas {
  id: string;
  name: string;
  /** Its corners in the model's frame, counterclockwise from the image's bottom left. */
  corners: readonly (readonly number[])[];
  /** Its plane's normal, which it lies a hair off along. */
  normal: readonly number[];
  image: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  opacity: number;
  /** A drawing, drawn for a light background, which a scene recolours for a dark one; not a photo. */
  drawing: boolean;
}

/**
 * Points of the model (Z up, millimetres, replicad's convention) in a scene's frame (Y up, metres,
 * the scene's GLB convention): x stays, z goes up, y goes away from the viewer.
 */
export function toScene(points: ArrayLike<number>, scale = 0.001): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    out[i] = points[i]! * scale;
    out[i + 1] = points[i + 2]! * scale;
    out[i + 2] = -points[i + 1]! * scale;
  }
  return out;
}

/** A shape's colour as glTF's linear RGBA; undefined for none, so that the scene draws it in its theme colour. */
export function linearColor(css: string | undefined, opacity: number | undefined): [number, number, number, number] | undefined {
  const alpha = opacity ?? 1;
  if (!css && alpha >= 1) return undefined;
  // A shape with only an opacity is drawn in the viewer's body grey.
  const c = new Color().setStyle(css || "#9a9a9a");
  return [c.r, c.g, c.b, alpha];
}

/**
 * Each shape's layer id: its own name (main's return key, e.g. `plate`), else its body's, made unique in
 * their order. Not the body's name first: that is its last feature's (`fillet1`), which a new feature
 * changes, and with it whether the scene shows the layer.
 */
export function layerIds(shapes: readonly Pick<MeshedShape, "name" | "body">[]): string[] {
  const used = new Set<string>([SKETCH_LAYER]);
  return shapes.map((s) => {
    const base = s.name || s.body || "shape";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base} ${n}`;
    used.add(id);
    return id;
  });
}

/** A sketch's polylines as line segments: pairs of points. */
function segments(sketch: ShownSketch): number[] {
  const out: number[] = [];
  for (const { points, closed } of sketch.outline) {
    const last = closed ? points.length : points.length - 1;
    for (let i = 0; i < last; i++) out.push(...points[i]!, ...points[(i + 1) % points.length]!);
  }
  return out;
}

export interface ModelGlb {
  glb: Uint8Array;
  bounds: Bounds | undefined;
  triangles: number;
}

/**
 * A build's shapes and sketches as a GLB by the scene's conventions: a node per shape, named by it,
 * its faces in its colour (none: the theme's) and its edges dark; a layer per shape, so the scene can
 * show and hide bodies; the sketches main returns as lines on a layer of their own; each canvas a
 * picture on a layer of its own.
 */
export function modelGlb(shapes: readonly MeshedShape[], sketches: readonly ShownSketch[] = [], canvases: readonly GlbCanvas[] = []): ModelGlb {
  const meshes: GlbMesh[] = [];
  const nodes: GlbNode[] = [];
  const layers: { id: string; name: string }[] = [];
  let bounds: Bounds | undefined;
  const grow = (points: Float32Array) => {
    const b = computeBounds(points);
    if (b) bounds = bounds ? { min: [0, 1, 2].map((k) => Math.min(bounds!.min[k]!, b.min[k]!)) as Bounds["min"], max: [0, 1, 2].map((k) => Math.max(bounds!.max[k]!, b.max[k]!)) as Bounds["max"] } : b;
  };
  let triangles = 0;
  const ids = layerIds(shapes);
  shapes.forEach((shape, i) => {
    const id = ids[i]!;
    const positions = toScene(shape.faces.vertices);
    const indices = shape.faces.triangles;
    const normals = shape.faces.normals?.length === shape.faces.vertices.length ? toScene(shape.faces.normals, 1) : computeNormals(positions, indices);
    const color = linearColor(shape.color, shape.opacity);
    const faces = { positions, normals, indices, roughness: 0.45, metallic: 0.15, ...(color ? { color } : {}) };
    const edges = shape.edges?.lines.length ? [{ positions: toScene(shape.edges.lines), mode: MODE.LINES, color: EDGE_COLOR, unlit: true, materialExtras: { lineWidth: LINE_WIDTH } }] : [];
    meshes.push({ name: shape.name, primitives: [faces, ...edges] });
    nodes.push({ name: shape.name, mesh: meshes.length - 1, extras: { layer: id } });
    layers.push({ id, name: shape.name || id });
    grow(positions);
    triangles += indices.length / 3;
  });
  const lines = sketches.map(segments).filter((s) => s.length);
  if (lines.length) {
    meshes.push({ name: "Sketches", primitives: lines.map((l) => ({ positions: toScene(l), mode: MODE.LINES, color: SKETCH_COLOR, unlit: true, materialExtras: { lineWidth: LINE_WIDTH } })) });
    nodes.push({ name: "Sketches", mesh: meshes.length - 1, extras: { layer: SKETCH_LAYER } });
    layers.push({ id: SKETCH_LAYER, name: "Sketches" });
    for (const p of meshes.at(-1)!.primitives) grow(p.positions as Float32Array);
  }
  for (const c of canvases) {
    const lifted = c.corners.flatMap((p) => p.map((x, k) => x + (c.normal[k] ?? 0) * CANVAS_LIFT));
    const positions = toScene(lifted);
    // glTF's (0, 0) is the image's top left; the corners start at its bottom left.
    const uvs = [0, 1, 1, 1, 1, 0, 0, 0];
    const picture = { positions, uvs, indices: [0, 1, 2, 0, 2, 3], texture: { image: c.image, mimeType: c.mimeType }, color: [1, 1, 1, c.opacity] as [number, number, number, number], blend: true, unlit: true, doubleSided: true, ...(c.drawing ? { materialExtras: { colorScheme: "light" } } : {}) };
    meshes.push({ name: c.name, primitives: [picture] });
    nodes.push({ name: c.name, mesh: meshes.length - 1, extras: { layer: canvasLayer(c.id) } });
    layers.push({ id: canvasLayer(c.id), name: c.name });
    grow(positions);
  }
  const glb = encodeGLB({ meshes, nodes, extras: { layers }, generator: "patchwork-cad" });
  return { glb, bounds, triangles };
}
