/**
 * A tiny feature runner over a flat feature list (mirroring the "model is code" design in
 * research/02-model-storage.md). Every step records lineage names for all faces of its result,
 * derived from OCCT's Generated/Modified/IsDeleted history. Strategies that don't use lineage
 * simply ignore the names.
 */
import { add, cross, describeEdge, describeFace, dot, scale, sub, unit, type Vec } from "./geom.ts";
import { listToArray, oc, progress, subShapes, type Shape } from "./oc.ts";

// ---------- feature definitions ----------

export type Profile =
  | { kind: "polygon"; points: [number, number][]; /** name of segment i (points[i] → points[i+1]) */ segments: string[] }
  | { kind: "circle"; center: [number, number]; radius: number; segment: string };

export interface Frame {
  origin: Vec;
  normal: Vec;
  xDir: Vec;
}

/** A plane given directly, or derived from a referenced planar face (sketch on face). */
export type PlaneSpec = Frame | { onFace: string };

export type Feature =
  | { id: string; type: "extrude"; plane: PlaneSpec; profile: Profile; distance: number; op: "new" | "fuse" | "cut"; through?: boolean }
  | { id: string; type: "revolve"; plane: PlaneSpec; profile: Profile; axis: { origin: [number, number]; dir: [number, number] }; op: "new" | "fuse" | "cut" }
  | { id: string; type: "pattern"; of: Extract<Feature, { type: "extrude" }>; count: number; step: Vec }
  | { id: string; type: "fillet"; edges: string; radius: number }
  | { id: string; type: "chamfer"; edges: string; distance: number }
  | { id: string; type: "shell"; faces: string; thickness: number };

// ---------- model state ----------

/** A face may carry several names after a merge (e.g. coplanar faces fused into one). */
export type NameSet = ReadonlySet<string>;

export interface State {
  /** Feature id that produced this state ("" for the empty start state). */
  after: string;
  shape: Shape | undefined;
  faces: Shape[];
  edges: Shape[];
  faceNames: NameSet[];
  /**
   * FreeCAD-style history names: the origin name plus one `/<op>#<k>` suffix per operation that
   * split the entity into several pieces (k = position in OCCT's Modified list). New edges are named
   * by the history names of their adjacent faces.
   */
  faceHist: NameSet[];
  edgeHist: NameSet[];
  /** For each edge, the indices of its adjacent faces (1 for seams, 2 normally). */
  edgeFaces: number[][];
  /** Faces whose name could not be derived from history (should stay empty). */
  unnamed: number;
}

export interface BuiltModel {
  features: Feature[];
  /** states[i] is the state *before* features[i]; states[features.length] is the final state. */
  states: State[];
  /** Features that were skipped: unresolvable reference (RefError) or kernel failure. */
  failures: { feature: string; error: string }[];
  before(featureId: string): State;
}

/** Resolves a reference slot of a feature against the state before that feature. */
export type Resolver = (slot: string, state: State, featureId: string) => Shape[];

const EMPTY: State = { after: "", shape: undefined, faces: [], edges: [], faceNames: [], faceHist: [], edgeHist: [], edgeFaces: [], unnamed: 0 };

export function build(features: Feature[], resolve: Resolver): BuiltModel {
  const states: State[] = [EMPTY];
  const failures: { feature: string; error: string }[] = [];
  let state = EMPTY;
  for (const f of features) {
    // A feature whose reference no longer resolves is skipped (like a failed feature in a CAD
    // timeline); the state passes through unchanged.
    try {
      state = applyFeature(state, f, resolve);
    } catch (e) {
      failures.push({ feature: f.id, error: e instanceof Error ? e.message : String(e) });
    }
    states.push(state);
  }
  return {
    features,
    states,
    failures,
    before(featureId) {
      const i = features.findIndex((f) => f.id === featureId);
      if (i < 0) throw new Error(`no feature ${featureId}`);
      return states[i]!;
    },
  };
}

// ---------- history propagation ----------

interface History {
  Generated(s: Shape): { Size(): number; First(): Shape; RemoveFirst(): void };
  Modified(s: Shape): { Size(): number; First(): Shape; RemoveFirst(): void };
  IsDeleted(s: Shape): boolean;
}

/** Counters for kernel history inconsistencies encountered while naming (reported in the write-up). */
export const historyQuirks = { deletedButPresent: 0, byOp: {} as Record<string, number> };

interface Source {
  faces: Shape[];
  names: NameSet[];
  faceHist: NameSet[];
  edges: Shape[];
  edgeHist: NameSet[];
}

const sourceOf = (s: State): Source => ({ faces: s.faces, names: s.faceNames, faceHist: s.faceHist, edges: s.edges, edgeHist: s.edgeHist });

/**
 * Names the faces of `result`: faces of the inputs keep their names (through Modified, or
 * unchanged), faces generated from `generators` get the generator's name. A face reachable from
 * several sources (merge) gets the union of their names. History names (faceHist/edgeHist) follow the
 * same rules but get a split suffix when one input entity is modified into several pieces.
 */
function propagate(h: History, inputs: Source[], generators: { from: Shape; name: string }[], result: Shape, after: string, opId: string): State {
  const faces = subShapes(result, "face");
  const edges = subShapes(result, "edge");
  const names: Set<string>[] = faces.map(() => new Set());
  const faceHist: Set<string>[] = faces.map(() => new Set());
  const edgeHist: Set<string>[] = edges.map(() => new Set());
  const assignTo = (pool: Shape[], target: Set<string>[]) => (s: Shape, ns: Iterable<string>) => {
    const i = pool.findIndex((f) => f.IsSame(s));
    if (i >= 0) for (const n of ns) target[i]!.add(n);
  };
  const pool = [...faces, ...edges];
  const follow = (srcs: Shape[], srcNames: NameSet[], assign: (s: Shape, ns: Iterable<string>) => void, splitSuffix: boolean) =>
    srcs.forEach((f, i) => {
      if (h.IsDeleted(f)) {
        // OCCT's fillet reports some untouched edges as deleted although they are still in the
        // result (investigations/debug-notch2b.ts). Presence in the result wins.
        if (!pool.some((x) => x.IsSame(f))) return;
        historyQuirks.deletedButPresent++;
        const op = (h as unknown as { constructor: { name: string } }).constructor.name;
        const key = `${op}:${f.ShapeType()}`;
        historyQuirks.byOp[key] = (historyQuirks.byOp[key] ?? 0) + 1;
      }
      const mods = listToArray(h.Modified(f));
      if (mods.length === 0) assign(f, srcNames[i]!);
      else if (mods.length === 1 || !splitSuffix) for (const m of mods) assign(m, srcNames[i]!);
      else mods.forEach((m, k) => assign(m, [...srcNames[i]!].map((n) => `${n}/${opId}#${k + 1}`)));
    });

  for (const src of inputs) {
    follow(src.faces, src.names, assignTo(faces, names), false);
    follow(src.faces, src.faceHist, assignTo(faces, faceHist), true);
    follow(src.edges, src.edgeHist, assignTo(edges, edgeHist), true);
  }
  for (const g of generators)
    for (const s of listToArray(h.Generated(g.from))) {
      assignTo(faces, names)(s, [g.name]);
      assignTo(faces, faceHist)(s, [g.name]);
    }
  return withTopology(result, faces, names, after, faceHist, edgeHist, edges);
}

function withTopology(shape: Shape, faces: Shape[], faceNames: NameSet[], after: string, faceHist: NameSet[] = faceNames, edgeHistIn?: Set<string>[], edgesIn?: Shape[]): State {
  const edges = edgesIn ?? subShapes(shape, "edge");
  const edgeFaces = edges.map(() => [] as number[]);
  faces.forEach((f, fi) => {
    for (const e of subShapes(f, "edge")) {
      const ei = edges.findIndex((x) => x.IsSame(e));
      if (ei >= 0 && !edgeFaces[ei]!.includes(fi)) edgeFaces[ei]!.push(fi);
    }
  });
  // New edges (no history) are named by their adjacent faces' history names; duplicates within one
  // step get a `~k` suffix in exploration order.
  const edgeHist = edgeHistIn ?? edges.map(() => new Set<string>());
  const seen = new Map<string, number>();
  edges.forEach((_, i) => {
    if (edgeHist[i]!.size > 0) return;
    const adj = edgeFaces[i]!.map((fi) => [...faceHist[fi]!].sort().join("+") || "?").sort().join(" | ");
    const n = (seen.get(adj) ?? 0) + 1;
    seen.set(adj, n);
    edgeHist[i]!.add(n === 1 ? `edge(${adj})` : `edge(${adj})~${n}`);
  });
  return { after, shape, faces, edges, faceNames, faceHist, edgeHist, edgeFaces, unnamed: faceNames.filter((n) => n.size === 0).length };
}

// ---------- features ----------

function applyFeature(state: State, f: Feature, resolve: Resolver): State {
  switch (f.type) {
    case "extrude":
    case "revolve":
      return sweepAndCombine(state, f, f.id, resolve);
    case "pattern": {
      let s = state;
      for (let k = 0; k < f.count; k++) {
        const plane = f.of.plane;
        if ("onFace" in plane) throw new Error("pattern on face not supported");
        const inst = { ...f.of, plane: { ...plane, origin: add(plane.origin, scale(f.step, k)) } };
        s = sweepAndCombine(s, inst, `${f.id}[${k}]`, resolve, f.id);
      }
      return s;
    }
    case "fillet":
    case "chamfer": {
      if (!state.shape) throw new Error(`${f.id}: nothing to ${f.type}`);
      const edges = resolve(f.edges, state, f.id);
      if (edges.length === 0) throw new RefError(f.id, f.edges);
      const o = oc();
      const mk = f.type === "fillet" ? new o.BRepFilletAPI_MakeFillet(state.shape, o.ChFi3d_FilletShape.ChFi3d_Rational) : new o.BRepFilletAPI_MakeChamfer(state.shape);
      for (const e of edges) mk.Add(f.type === "fillet" ? f.radius : f.distance, o.TopoDS.Edge(e));
      mk.Build(progress());
      if (!mk.IsDone()) throw new Error(`${f.id}: ${f.type} failed`);
      const gens = edges.map((e) => ({ from: e, name: `${f.id}.${f.type}(${edgeName(state, e)})` }));
      for (const e of edges) for (const v of subShapes(e, "vertex")) gens.push({ from: v, name: `${f.id}.corner` });
      return propagate(mk as unknown as History, [sourceOf(state)], gens, mk.Shape(), f.id, f.id);
    }
    case "shell": {
      if (!state.shape) throw new Error(`${f.id}: nothing to shell`);
      const removed = resolve(f.faces, state, f.id);
      if (removed.length === 0) throw new RefError(f.id, f.faces);
      const o = oc();
      const list = new o.NCollection_List_TopoDS_Shape();
      for (const r of removed) list.Append(r);
      const mk = new o.BRepOffsetAPI_MakeThickSolid();
      mk.MakeThickSolidByJoin(state.shape, list, -f.thickness, 1e-3);
      mk.Build(progress());
      if (!mk.IsDone()) throw new Error(`${f.id}: shell failed`);
      // OCCT reports the offset (inner) faces as Generated from the outer faces, and the removed
      // face as Modified into the remaining rim (see investigations/debug-history.ts).
      const gens = state.faces.map((src, i) => ({ from: src, name: `${f.id}.inner(${[...state.faceNames[i]!].sort().join("+")})` }));
      return propagate(mk as unknown as History, [sourceOf(state)], gens, mk.Shape(), f.id, f.id);
    }
  }
}

export class RefError extends Error {
  constructor(readonly featureId: string, readonly slot: string) {
    super(`${featureId}: reference ${slot} did not resolve`);
  }
}

/** Lineage name of an edge in a state: the names of its adjacent faces. */
export function edgeName(state: State, e: Shape): string {
  const i = state.edges.findIndex((x) => x.IsSame(e));
  const adj = i < 0 ? [] : state.edgeFaces[i]!.map((fi) => [...state.faceNames[fi]!].sort().join("+") || "?");
  return `edge(${adj.sort().join(" | ")})`;
}

function sweepAndCombine(state: State, f: Extract<Feature, { type: "extrude" | "revolve" }>, nameId: string, resolve: Resolver, featureId = f.id): State {
  const o = oc();
  const frame = planeFrame(f.plane, state, featureId, resolve);
  const { face, segmentEdges } = profileFace(f.profile, frame);

  let tool: Shape;
  const gens: { from: Shape; name: string }[] = segmentEdges.map(({ edge, name }) => ({ from: edge, name: `${nameId}.side(${name})` }));
  let h: History;
  if (f.type === "extrude") {
    const dir = f.op === "cut" ? scale(frame.normal, -1) : frame.normal;
    const vec = scale(dir, f.through ? 1e3 : f.distance);
    const base = f.through ? moveFace(face, scale(dir, -1e3 / 2)) : face;
    const mk = new o.BRepPrimAPI_MakePrism(base, new o.gp_Vec(vec[0], vec[1], vec[2]), false, true);
    mk.Build(progress());
    tool = mk.Shape();
    h = mk as unknown as History;
    // Prism history is relative to the (possibly moved) base face's edges.
    const baseEdges = subShapes(base, "edge");
    gens.length = 0;
    segmentEdges.forEach(({ name }, k) => gens.push({ from: baseEdges[k]!, name: `${nameId}.side(${name})` }));
    gens.push({ from: mk.FirstShape(), name: `${nameId}.start` }, { from: mk.LastShape(), name: `${nameId}.end` });
  } else {
    const [ox, oy] = f.axis.origin;
    const [dx, dy] = f.axis.dir;
    const p = add(frame.origin, add(scale(frame.xDir, ox), scale(cross(frame.normal, frame.xDir), oy)));
    const d = add(scale(frame.xDir, dx), scale(cross(frame.normal, frame.xDir), dy));
    const ax = new o.gp_Ax1(new o.gp_Pnt(p[0], p[1], p[2]), new o.gp_Dir(d[0], d[1], d[2]));
    const mk = new o.BRepPrimAPI_MakeRevol(face, ax, false);
    mk.Build(progress());
    tool = mk.Shape();
    h = mk as unknown as History;
  }

  // Name the tool's own faces from the sweep history (start/end caps map onto themselves).
  const toolFaces = subShapes(tool, "face");
  const toolNames: Set<string>[] = toolFaces.map(() => new Set());
  for (const g of gens) {
    const targets = g.name.endsWith(".start") || g.name.endsWith(".end") ? [g.from] : listToArray(h.Generated(g.from));
    for (const t of targets) {
      const i = toolFaces.findIndex((x) => x.IsSame(t));
      if (i >= 0) toolNames[i]!.add(g.name);
    }
  }
  if (f.type === "revolve") nameAxisFaces(toolFaces, toolNames, segmentEdges, nameId);
  const toolState = withTopology(tool, toolFaces, toolNames, featureId);

  if (f.op === "new" || !state.shape) return toolState;

  const bop = f.op === "fuse" ? new o.BRepAlgoAPI_Fuse(state.shape, tool, progress()) : new o.BRepAlgoAPI_Cut(state.shape, tool, progress());
  if (!bop.IsDone()) throw new Error(`${featureId}: boolean failed`);
  // replicad (casting.js, fuseShapes/cutShape) unifies same-domain faces and edges after every
  // boolean; do the same so the topology matches what the real tool would produce.
  bop.SimplifyResult(true, true, 1e-3);
  return propagate(bop as unknown as History, [sourceOf(state), sourceOf(toolState)], [], bop.Shape(), featureId, nameId);
}

function moveFace(face: Shape, v: Vec): Shape {
  const o = oc();
  const t = new o.gp_Trsf();
  t.SetTranslation(new o.gp_Vec(v[0], v[1], v[2]));
  return new o.BRepBuilderAPI_Transform(face, t, true, false).Shape();
}

function planeFrame(p: PlaneSpec, state: State, featureId: string, resolve: Resolver): Frame {
  if (!("onFace" in p)) return p;
  const faces = resolve(p.onFace, state, featureId);
  if (faces.length !== 1) throw new RefError(featureId, p.onFace);
  return frameOnFace(faces[0]!);
}

/**
 * Sketch frame on a planar face: origin is the world origin projected onto the plane, x is world X
 * projected (world Y if X is normal to the face). Deliberately independent of the face's extent.
 */
export function frameOnFace(face: Shape): Frame {
  const o = oc();
  const ad = new o.BRepAdaptor_Surface(o.TopoDS.Face(face), true);
  if (ad.GetType() !== o.GeomAbs_SurfaceType.GeomAbs_Plane) throw new Error("sketch on non-planar face");
  const ax = ad.Plane().Axis();
  let n: Vec = [ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()];
  if (face.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED) n = scale(n, -1);
  const loc: Vec = [ax.Location().X(), ax.Location().Y(), ax.Location().Z()];
  const d = n[0] * loc[0] + n[1] * loc[1] + n[2] * loc[2];
  const origin = scale(n, d);
  const wx: Vec = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const xDir = unit(sub(wx, scale(n, wx[0] * n[0] + wx[1] * n[1] + wx[2] * n[2])));
  return { origin, normal: n, xDir };
}

function profileFace(p: Profile, fr: Frame): { face: Shape; segmentEdges: { edge: Shape; name: string }[] } {
  const o = oc();
  const yDir = cross(fr.normal, fr.xDir);
  const to3 = ([x, y]: [number, number]) => add(fr.origin, add(scale(fr.xDir, x), scale(yDir, y)));
  const P = (v: Vec) => new o.gp_Pnt(v[0], v[1], v[2]);
  const wire = new o.BRepBuilderAPI_MakeWire();
  const segs: { edge: Shape; name: string }[] = [];
  if (p.kind === "polygon") {
    p.points.forEach((pt, i) => {
      const next = p.points[(i + 1) % p.points.length]!;
      const e = new o.BRepBuilderAPI_MakeEdge(P(to3(pt)), P(to3(next))).Edge();
      wire.Add(e);
      segs.push({ edge: e, name: p.segments[i]! });
    });
  } else {
    const c = to3(p.center);
    const circ = new o.gp_Circ(new o.gp_Ax2(P(c), new o.gp_Dir(fr.normal[0], fr.normal[1], fr.normal[2]), new o.gp_Dir(fr.xDir[0], fr.xDir[1], fr.xDir[2])), p.radius);
    const e = new o.BRepBuilderAPI_MakeEdge(circ).Edge();
    wire.Add(e);
    segs.push({ edge: e, name: p.segment });
  }
  const face = new o.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face();
  // The face's wire edges are the ones the sweep's history refers to; map segment names onto them
  // in wire order (identical to insertion order for a single wire built edge by edge).
  const faceEdges = subShapes(face, "edge");
  return { face, segmentEdges: segs.map((s, k) => ({ edge: faceEdges[k]!, name: s.name })) };
}

/**
 * OCCT's MakeRevol reports no Generated face for profile edges touching the axis (the end disks;
 * see investigations/debug-history.ts). Fallback: a still-unnamed planar face is named after the profile
 * segment whose midpoint lies in it. This is geometric matching at naming time, documented as a
 * kernel limitation in the research write-up.
 */
function nameAxisFaces(faces: Shape[], names: Set<string>[], segs: { edge: Shape; name: string }[], nameId: string) {
  faces.forEach((face, i) => {
    if (names[i]!.size > 0) return;
    const info = describeFace(face);
    if (info.type !== "plane") return;
    for (const { edge, name } of segs) {
      const mid = describeEdge(edge).centroid;
      if (Math.abs(dot(info.dir!, mid) - info.offset!) < 1e-6) names[i]!.add(`${nameId}.side(${name})`);
    }
  });
}
