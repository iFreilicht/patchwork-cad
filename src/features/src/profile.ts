/**
 * Sketch profiles as paths of lines, Bézier curves and elliptical arcs, and the regions they enclose
 * (research/21, "Sketch from a drawing"). The regions are Fusion's profiles: every bounded face of the
 * sketch plane split by all of the sketch's curves, so that two overlapping rectangles enclose three,
 * and a curve that doesn't close encloses nothing unless other curves close it.
 */
import { cast } from "replicad";
import { add, cross, scale, type Vec } from "./geom.ts";
import { printFeatureName } from "./names.ts";
import { listToArray, oc, progress, ShapeIndex, subShapes, type Shape } from "./oc.ts";

export type Point = [number, number];

export type Curve =
  /** A straight line to `to`. */
  | { kind: "line"; to: Point }
  /** A quadratic (one control point) or cubic (two) Bézier curve to `to`. */
  | { kind: "bezier"; controls: Point[]; to: Point }
  /**
   * An elliptical arc, `center + u cos t + v sin t` for t from `from` to `to` (radians, `to` less than
   * `from` for the other direction): a circle where `u` and `v` are perpendicular and as long.
   */
  | { kind: "arc"; center: Point; u: Point; v: Point; from: number; to: number };

/** A curve with the id that the side face it sweeps is named by (`extrude1.side["leaf.3"]`). */
export interface Segment {
  id: string;
  curve: Curve;
}

/** Segments one after another from `start`. A closed path is a loop: it ends where it starts, and regions inside it are named by its id. */
export interface Path {
  id: string;
  start: Point;
  segments: Segment[];
  closed: boolean;
}

/** Closed paths that are filled together by a rule, as an SVG element's subpaths are; what a sketch's `filled` selects. */
export interface Fill {
  loops: string[];
  rule: "nonzero" | "evenodd";
}

export interface Frame {
  origin: Vec;
  normal: Vec;
  xDir: Vec;
}

export const endOf = (c: Curve): Point => (c.kind === "arc" ? arcAt(c, c.to) : c.to);

const arcAt = (c: Extract<Curve, { kind: "arc" }>, t: number): Point => [c.center[0] + c.u[0] * Math.cos(t) + c.v[0] * Math.sin(t), c.center[1] + c.u[1] * Math.cos(t) + c.v[1] * Math.sin(t)];

const len2 = (p: Point) => Math.hypot(p[0], p[1]);
const sub2 = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

function bezierAt(poles: Point[], t: number): Point {
  let pts = poles;
  while (pts.length > 1) pts = pts.slice(1).map((p, i) => [pts[i]![0] + (p[0] - pts[i]![0]) * t, pts[i]![1] + (p[1] - pts[i]![1]) * t]);
  return pts[0]!;
}

/** Points along a curve after `from`, its end last: enough that the polyline is within about `tolerance` of it. */
export function sampleCurve(from: Point, c: Curve, tolerance: number): Point[] {
  if (c.kind === "line") return [c.to];
  if (c.kind === "bezier") {
    const poles = [from, ...c.controls, c.to];
    const hull = poles.slice(1).reduce((s, p, i) => s + len2(sub2(p, poles[i]!)), 0);
    const n = Math.min(256, Math.max(4, Math.ceil(Math.sqrt(hull / Math.max(tolerance, 1e-9)))));
    return Array.from({ length: n }, (_, i) => bezierAt(poles, (i + 1) / n));
  }
  const r = Math.max(len2(c.u), len2(c.v));
  // A chord of angle a is within r (1 - cos(a/2)) of its arc.
  const step = r > tolerance ? 2 * Math.acos(Math.max(-1, 1 - tolerance / r)) : Math.PI / 2;
  const n = Math.min(512, Math.max(4, Math.ceil(Math.abs(c.to - c.from) / step)));
  return Array.from({ length: n }, (_, i) => arcAt(c, c.from + ((c.to - c.from) * (i + 1)) / n));
}

export function samplePath(p: Path, tolerance: number): Point[] {
  const out: Point[] = [p.start];
  let at = p.start;
  for (const s of p.segments) {
    out.push(...sampleCurve(at, s.curve, tolerance));
    at = endOf(s.curve);
  }
  return out;
}

/** The extent of paths' points, control points included, which contain their curves. */
export function extentOf(paths: readonly Path[]): { min: Point; max: Point } | undefined {
  const pts = paths.flatMap((p) => [p.start, ...p.segments.flatMap((s) => (s.curve.kind === "arc" ? sampleCurve(p.start, s.curve, Infinity) : s.curve.kind === "bezier" ? [...s.curve.controls, s.curve.to] : [s.curve.to]))]);
  if (!pts.length) return undefined;
  const min: Point = [Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity];
  for (const [x, y] of pts) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
  }
  return { min, max };
}

/** Winding number of a closed polyline around `p`. */
function winding(poly: readonly Point[], p: Point): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && side > 0) w++;
    } else if (b[1] <= p[1] && side < 0) w--;
  }
  return w;
}

// ---------- OCCT ----------

const yDirOf = (fr: Frame) => cross(fr.normal, fr.xDir);
const to3 = (fr: Frame, [x, y]: Point): Vec => add(fr.origin, add(scale(fr.xDir, x), scale(yDirOf(fr), y)));
const pnt = (v: Vec) => new (oc().gp_Pnt)(v[0], v[1], v[2]);
const dir = (v: Vec) => new (oc().gp_Dir)(v[0], v[1], v[2]);

/** Shorter curves are points (OCCT's Precision::Confusion()). */
const CONFUSION = 1e-7;

/** The curve as an edge on the frame, none if it has no length. */
function curveEdge(fr: Frame, from: Point, c: Curve): Shape | undefined {
  const o = oc();
  if (c.kind === "line") {
    if (len2(sub2(c.to, from)) < CONFUSION) return undefined;
    return new o.BRepBuilderAPI_MakeEdge(pnt(to3(fr, from)), pnt(to3(fr, c.to))).Edge();
  }
  if (c.kind === "bezier") {
    const poles = [from, ...c.controls, c.to];
    if (poles.every((p) => len2(sub2(p, from)) < CONFUSION)) return undefined;
    const array = new o.NCollection_Array1_gp_Pnt(1, poles.length);
    poles.forEach((p, i) => array.SetValue(i + 1, pnt(to3(fr, p))));
    return new o.BRepBuilderAPI_MakeEdge(new o.Geom_BezierCurve(array)).Edge();
  }
  // The principal axes of u cos t + v sin t: its longest radius is at t = θ, its shortest at θ + π/2.
  const uu = c.u[0] ** 2 + c.u[1] ** 2;
  const vv = c.v[0] ** 2 + c.v[1] ** 2;
  const uv = c.u[0] * c.v[0] + c.u[1] * c.v[1];
  const theta = 0.5 * Math.atan2(2 * uv, uu - vv);
  const at = (t: number): Point => [c.u[0] * Math.cos(t) + c.v[0] * Math.sin(t), c.u[1] * Math.cos(t) + c.v[1] * Math.sin(t)];
  const major = at(theta);
  const minor = at(theta + Math.PI / 2);
  const a = len2(major);
  const b = len2(minor);
  if (b < CONFUSION || Math.abs(c.to - c.from) * a < CONFUSION) return undefined;
  const xDir = scale(add(scale(fr.xDir, major[0]), scale(yDirOf(fr), major[1])), 1 / a);
  // The ellipse runs from its major to its minor axis: about the frame's normal if the minor axis is a quarter turn counterclockwise from the major one.
  const ccw = major[0] * minor[1] - major[1] * minor[0] > 0;
  const ax = new o.gp_Ax2(pnt(to3(fr, c.center)), dir(ccw ? fr.normal : scale(fr.normal, -1)), dir(xDir));
  const [t0, t1] = [c.from - theta, c.to - theta].sort((x, y) => x - y) as [number, number];
  const full = t1 - t0 >= 2 * Math.PI - 1e-12;
  if (Math.abs(a - b) <= 1e-9 * a) {
    const circ = new o.gp_Circ(ax, a);
    return (full ? new o.BRepBuilderAPI_MakeEdge(circ) : new o.BRepBuilderAPI_MakeEdge(circ, t0, t1)).Edge();
  }
  const elips = new o.gp_Elips(ax, a, b);
  return (full ? new o.BRepBuilderAPI_MakeEdge(elips) : new o.BRepBuilderAPI_MakeEdge(elips, t0, t1)).Edge();
}

const area = (s: Shape) => {
  const o = oc();
  const g = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(s, g, false, false);
  const m = g.Mass();
  g.delete();
  return m;
};

/** A region of a sketch: a bounded face of its plane split by its curves. */
export interface Region {
  /** The closed paths it lies inside, by id, sorted: what names it. */
  loops: string[];
  /** Whether a fill of the profile covers it. */
  filled: boolean;
  /** A point inside it, away from its boundary, in sketch coordinates. */
  point: Point;
  area: number;
  face: Shape;
  /** Its triangles in sketch coordinates: x and y of each corner, three corners each. */
  triangles: number[];
}

/** A piece of a curve, after the curves were split where they meet, and the ids of the segments it lies on. */
export interface Piece {
  edge: Shape;
  ids: string[];
}

export interface Arrangement {
  regions: Region[];
  pieces: Piece[];
}

/** The regions that `paths` enclose on `fr`, and the pieces their curves were split into. */
export function arrange(paths: readonly Path[], fills: readonly Fill[], fr: Frame): Arrangement {
  const o = oc();
  const sources: { edge: Shape; id: string }[] = [];
  for (const p of paths) {
    let at = p.start;
    for (const s of p.segments) {
      const edge = curveEdge(fr, at, s.curve);
      if (edge) sources.push({ edge, id: s.id });
      at = endOf(s.curve);
    }
  }
  const extent = extentOf(paths);
  if (!sources.length || !extent) return { regions: [], pieces: [] };
  const size = Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], 1);
  const tolerance = size * 1e-4;
  // A face of the plane well beyond the curves, which they split.
  const c = to3(fr, [(extent.min[0] + extent.max[0]) / 2, (extent.min[1] + extent.max[1]) / 2]);
  const plane = new o.gp_Pln(new o.gp_Ax3(pnt(c), dir(fr.normal), dir(fr.xDir)));
  const big = new o.BRepBuilderAPI_MakeFace(plane, -2 * size, 2 * size, -2 * size, 2 * size).Face();
  const splitter = new o.BRepAlgoAPI_Splitter();
  const args = new o.NCollection_List_TopoDS_Shape();
  args.Append(big);
  const tools = new o.NCollection_List_TopoDS_Shape();
  for (const s of sources) tools.Append(s.edge);
  splitter.SetArguments(args);
  splitter.SetTools(tools);
  splitter.Build(progress());
  if (!splitter.IsDone()) throw new Error("the sketch's curves could not be intersected");
  const result = splitter.Shape();
  const edges = subShapes(result, "edge");
  const edgeIndex = new ShapeIndex(edges);
  const ids: string[][] = edges.map(() => []);
  const piecesOf = (s: Shape) => {
    const modified = listToArray(splitter.Modified(s));
    return modified.length ? modified : [s];
  };
  for (const { edge, id } of sources)
    for (const piece of piecesOf(edge)) {
      const i = edgeIndex.indexOf(piece);
      if (i >= 0 && !ids[i]!.includes(id)) ids[i]!.push(id);
    }
  const outer = new Set(subShapes(big, "edge").flatMap(piecesOf).map((p) => edgeIndex.indexOf(p)));
  const loops = paths.filter((p) => p.closed).map((p) => ({ id: p.id, poly: samplePath(p, tolerance / 10) }));
  const yDir = yDirOf(fr);
  const toSketch = (x: number, y: number, z: number): Point => {
    const d: Vec = [x - fr.origin[0], y - fr.origin[1], z - fr.origin[2]];
    return [d[0] * fr.xDir[0] + d[1] * fr.xDir[1] + d[2] * fr.xDir[2], d[0] * yDir[0] + d[1] * yDir[1] + d[2] * yDir[2]];
  };
  const regions: Region[] = [];
  for (const face of subShapes(result, "face")) {
    const own = subShapes(face, "edge");
    if (own.some((e) => outer.has(edgeIndex.indexOf(e)))) continue;
    const mesh = cast(face).mesh({ tolerance, angularTolerance: 0.2 });
    const triangles = mesh.triangles.flatMap((v) => toSketch(mesh.vertices[3 * v]!, mesh.vertices[3 * v + 1]!, mesh.vertices[3 * v + 2]!));
    if (!triangles.length) continue;
    const point = interiorPoint(triangles);
    const inside = new Map(loops.map((l) => [l.id, winding(l.poly, point)]));
    const filled = fills.some((f) => {
      const w = f.loops.reduce((sum, id) => sum + (inside.get(id) ?? 0), 0);
      return f.rule === "evenodd" ? w % 2 !== 0 : w !== 0;
    });
    const names = [...new Set(loops.filter((l) => inside.get(l.id) !== 0).map((l) => l.id))].sort();
    regions.push({ loops: names, filled, point, area: area(face), face, triangles });
  }
  splitter.delete();
  return { regions, pieces: edges.map((edge, i) => ({ edge, ids: ids[i]! })).filter((p) => p.ids.length) };
}

/** The centroid of the triangle farthest from the boundary of a triangulated region: inside it, and not at its edge. */
function interiorPoint(tri: number[]): Point {
  const key = (i: number) => `${tri[2 * i]},${tri[2 * i + 1]}`;
  const count = new Map<string, number>();
  const sides: [number, number][] = [];
  for (let t = 0; t < tri.length / 6; t++)
    for (let k = 0; k < 3; k++) {
      const a = 3 * t + k;
      const b = 3 * t + ((k + 1) % 3);
      const id = [key(a), key(b)].sort().join(";");
      count.set(id, (count.get(id) ?? 0) + 1);
      sides.push([a, b]);
    }
  const boundary = sides.filter(([a, b]) => count.get([key(a), key(b)].sort().join(";")) === 1);
  const distance = (p: Point) =>
    Math.min(
      ...boundary.map(([a, b]) => {
        const ax = tri[2 * a]!;
        const ay = tri[2 * a + 1]!;
        const dx = tri[2 * b]! - ax;
        const dy = tri[2 * b + 1]! - ay;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
      }),
    );
  let best: Point = [tri[0]!, tri[1]!];
  let far = -1;
  for (let t = 0; t < tri.length / 6; t++) {
    const p: Point = [(tri[6 * t]! + tri[6 * t + 2]! + tri[6 * t + 4]!) / 3, (tri[6 * t + 1]! + tri[6 * t + 3]! + tri[6 * t + 5]!) / 3];
    const d = distance(p);
    if (d > far) [best, far] = [p, d];
  }
  return best;
}

/** Whether `p` is in one of a region's triangles. */
export function contains(r: Region, p: Point): boolean {
  const t = r.triangles;
  for (let i = 0; i < t.length; i += 6) {
    const d1 = (p[0] - t[i + 2]!) * (t[i + 1]! - t[i + 3]!) - (t[i]! - t[i + 2]!) * (p[1] - t[i + 3]!);
    const d2 = (p[0] - t[i + 4]!) * (t[i + 3]! - t[i + 5]!) - (t[i + 2]! - t[i + 4]!) * (p[1] - t[i + 5]!);
    const d3 = (p[0] - t[i]!) * (t[i + 5]! - t[i + 1]!) - (t[i + 4]! - t[i]!) * (p[1] - t[i + 1]!);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
  }
  return false;
}

/** A compound of shapes. */
function compound(shapes: readonly Shape[]): Shape {
  const o = oc();
  const c = new o.TopoDS_Compound();
  const builder = new o.TopoDS_Builder();
  builder.MakeCompound(c);
  for (const s of shapes) builder.Add(c, s);
  builder.delete();
  return c;
}

/**
 * The base face of an extrusion of some of the regions, joined where they touch, and each of its
 * edges, in the face's own order, with the ids of the segments it lies on. Pieces of a segment that
 * the join puts together again are one edge.
 */
export function joinRegions(chosen: readonly Region[], pieces: readonly Piece[]): { face: Shape; edges: { edge: Shape; ids: string[] }[] } {
  const o = oc();
  const index = new ShapeIndex(pieces.map((p) => p.edge));
  const idsOf = (e: Shape) => pieces[index.indexOf(e)]?.ids ?? [];
  // Regions that share an edge are joined; the others stay as they are, which spares the join e.g. the letters of a text.
  const group = chosen.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
  const owner = new Map<number, number>();
  chosen.forEach((r, i) => {
    for (const e of subShapes(r.face, "edge")) {
      const k = index.indexOf(e);
      const other = owner.get(k);
      if (other === undefined) owner.set(k, i);
      else group[root(i)] = root(other);
    }
  });
  const groups = new Map<number, Region[]>();
  chosen.forEach((r, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), r]));
  const faces: Shape[] = [];
  const named = new ShapeIndex();
  const ids: string[][] = [];
  const name = (edge: Shape, of: string[]) => {
    let i = named.indexOf(edge);
    if (i < 0) ids[(i = named.push(edge))] = [];
    for (const id of of) if (!ids[i]!.includes(id)) ids[i]!.push(id);
  };
  for (const members of groups.values()) {
    if (members.length === 1) {
      faces.push(members[0]!.face);
      for (const e of subShapes(members[0]!.face, "edge")) name(e, idsOf(e));
      continue;
    }
    const join = new o.BRepAlgoAPI_BuilderAlgo();
    const args = new o.NCollection_List_TopoDS_Shape();
    for (const r of members) args.Append(r.face);
    join.SetArguments(args);
    join.Build(progress());
    if (!join.IsDone()) throw new Error("the profiles could not be joined");
    join.SimplifyResult(true, true, 1e-3);
    const joined = join.Shape();
    faces.push(...subShapes(joined, "face"));
    const result = new ShapeIndex(subShapes(joined, "edge"));
    for (const piece of subShapes(compound(members.map((r) => r.face)), "edge")) {
      const modified = listToArray(join.Modified(piece));
      for (const m of modified.length ? modified : [piece]) if (result.indexOf(m) >= 0) name(m, idsOf(piece));
    }
    join.delete();
  }
  const face = faces.length === 1 ? faces[0]! : compound(faces);
  return { face, edges: subShapes(face, "edge").map((edge) => ({ edge, ids: ids[named.indexOf(edge)] ?? [] })) };
}

// ---------- references to regions ----------

const printPoint = (p: Point) => `[${p.map((x) => +x.toFixed(3)).join(", ")}]`;

/**
 * A reference to regions of a sketch, as written in code: `sketch2.region("a", "b")` is the region
 * inside loops a and b and no other, `sketch2.region("a", { near: [3, 4] })` the one of several such
 * regions at or nearest to that point, and `sketch2.filled` every region a fill covers.
 */
export class RegionRef {
  constructor(
    readonly sketch: string,
    readonly loops: readonly string[] | "filled",
    readonly near?: Point,
  ) {}

  toString(): string {
    const s = printFeatureName(this.sketch);
    if (this.loops === "filled") return `${s}.filled`;
    const args = [...this.loops.map((l) => JSON.stringify(l)), ...(this.near ? [`{ near: ${printPoint(this.near)} }`] : [])];
    return `${s}.region(${args.join(", ")})`;
  }
}

/** The arguments of `region(…)`: loop ids, and optionally `{ near }` last. */
export function regionRef(sketch: string, args: unknown[]): RegionRef {
  const last = args.at(-1);
  const hint = typeof last === "object" && last !== null && !Array.isArray(last) ? (last as { near?: unknown }) : undefined;
  const loops = hint ? args.slice(0, -1) : args;
  const bad = loops.find((l) => typeof l !== "string");
  if (bad !== undefined) throw new Error(`region(): expected the ids of loops, got ${JSON.stringify(bad)}`);
  const near = hint?.near;
  if (near !== undefined && !(Array.isArray(near) && near.length === 2 && near.every((x) => typeof x === "number"))) throw new Error(`region(): near must be a point [x, y], got ${JSON.stringify(near)}`);
  return new RegionRef(sketch, [...new Set(loops as string[])].sort(), near as Point | undefined);
}

const sameLoops = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The code that names region `index` of `regions`, with a point only where its loops name several. */
export function regionCode(sketch: string, regions: readonly Region[], index: number): RegionRef {
  const r = regions[index]!;
  const twins = regions.filter((x) => sameLoops(x.loops, r.loops)).length;
  return new RegionRef(sketch, r.loops, twins > 1 ? [+r.point[0].toFixed(3), +r.point[1].toFixed(3)] : undefined);
}

export type RegionResolution = { ok: number[] } | { missing: string; suggestion?: number[] } | { ambiguous: number[]; why: string; suggestion: number[] };

const distance2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** The regions a reference names. */
export function resolveRegion(regions: readonly Region[], ref: RegionRef): RegionResolution {
  const all = regions.map((_, i) => i);
  if (ref.loops === "filled") {
    const filled = all.filter((i) => regions[i]!.filled);
    return filled.length ? { ok: filled } : { missing: `${ref}: nothing in the sketch is filled` };
  }
  const loops = ref.loops;
  const candidates = all.filter((i) => sameLoops(regions[i]!.loops, loops));
  const nearest = (pool: number[], p: Point) => pool.find((i) => contains(regions[i]!, p)) ?? [...pool].sort((a, b) => distance2(regions[a]!.point, p) - distance2(regions[b]!.point, p))[0];
  if (!candidates.length) {
    const what = loops.length ? `inside ${loops.map((l) => JSON.stringify(l)).join(" and ")} alone` : "outside every loop";
    const suggestion = ref.near ? nearest(all, ref.near) : undefined;
    return { missing: `${ref}: no profile lies ${what}`, ...(suggestion !== undefined ? { suggestion: [suggestion] } : {}) };
  }
  if (candidates.length === 1) return { ok: candidates };
  if (ref.near) return { ok: [nearest(candidates, ref.near)!] };
  return { ambiguous: candidates, why: `${ref}: ${candidates.length} profiles lie there; a point tells them apart`, suggestion: candidates };
}
