/** What the editor needs beyond the model API: build control, the trace, picking and the feature schemas. */
export { beginBuild, currentTrace, liveBodies, pick, entityIndex, outline, pickRegion, pathsOf, FeatureError, shapeOf } from "./feature.ts";
export { FeatureCache } from "./cache.ts";
export { extentOf, samplePath } from "./profile.ts";
export type { TraceEntry, RefDiagnostic, FeatureContext, BuildOptions } from "./feature.ts";
export { resolve, capture } from "./refs.ts";
export type { Resolution } from "./refs.ts";
export type { Topo } from "./topo.ts";
export { describe } from "./geom.ts";
import { body, chamfer, combine, extrude, fillet, move, sketch } from "./features.ts";
import { pick as pickRef, type Body, type TraceEntry } from "./feature.ts";
import { owningFeatures, refForm, withFeaturePrinter, type Name, type Vec } from "./names.ts";
import { Ref, resolve } from "./refs.ts";
import { cast, type AnyShape } from "replicad";
import { boolean, oc, subShapes, type Kind, type Shape } from "./oc.ts";
import { entities, opsOf } from "./topo.ts";

/** The built-in features by function name, for recognizing calls and rendering their forms. */
export const builtins = { sketch, extrude, fillet, chamfer, combine, move, body } as const;

/** A deep copy of a shape: new faces and edges with copies of their geometry, which share nothing with it. */
function copyShape(s: Shape): Shape {
  const o = oc();
  const copy = new o.BRepBuilderAPI_Transform(s, new o.gp_Trsf(), true, false);
  const shape = copy.Shape();
  copy.delete();
  return shape;
}

/** A shape's triangles and its edges' polylines, as replicad's `mesh` and `meshEdges` give them. */
interface Meshes {
  mesh(options?: object): { vertices: number[]; triangles: number[]; normals: number[]; faceGroups: { start: number; count: number; faceId: number }[] };
  meshEdges(options?: object): { lines: number[]; edgeGroups: { start: number; count: number; edgeId: number }[] };
}

/** What a body is meshed as, by its copy: replicad's id of each of the copy's faces and edges, as in its meshes' `faceGroups`/`edgeGroups`, by the body's face and edge index. */
export interface Meshable {
  /** The copy. */
  shape: AnyShape;
  /** Its meshes, as replicad gives them, made once for each set of options and then kept: what replicad-evaluator and the tool mesh, a shape to them. */
  meshes: Meshes;
  faceIds: number[];
  edgeIds: number[];
}

const meshables = new WeakMap<Body, Meshable>();

/**
 * A body to mesh, for the view: a copy of its shape, as meshing keeps triangulations in the shapes
 * it meshes, which later features would then see in a reused body (research/24, "Bodies don't
 * change"). Its meshes are kept with the body, so that a reused body isn't meshed again; they are
 * kept as typed arrays, which hold replicad's 32-bit floats and integers exactly.
 */
export function meshable(b: Body): Meshable {
  let m = meshables.get(b);
  if (m) return m;
  const copy = copyShape(b.topo.shape);
  const hasher = oc().ReplicadShapeHasher;
  const ids = (kind: Kind) => {
    const copied = subShapes(copy, kind);
    if (copied.length !== entities(b.topo, kind).length) throw new Error(`the copy of ${b.name} has ${copied.length} ${kind}s, not ${entities(b.topo, kind).length}`);
    return copied.map((e) => hasher.HashCode(e, 2147483647));
  };
  const shape = cast(copy);
  const meshes = shape as unknown as Meshes;
  const faces = new Map<string, { vertices: Float32Array; triangles: Uint32Array; normals: Float32Array; faceGroups: { start: number; count: number; faceId: number }[] }>();
  const edges = new Map<string, { lines: Float32Array; edgeGroups: { start: number; count: number; edgeId: number }[] }>();
  m = {
    shape,
    meshes: {
      mesh(options = {}) {
        const key = JSON.stringify(options);
        let f = faces.get(key);
        if (!f) {
          const made = meshes.mesh(options);
          faces.set(key, (f = { vertices: Float32Array.from(made.vertices), triangles: Uint32Array.from(made.triangles), normals: Float32Array.from(made.normals), faceGroups: made.faceGroups }));
        }
        return { vertices: Array.from(f.vertices), triangles: Array.from(f.triangles), normals: Array.from(f.normals), faceGroups: f.faceGroups.map((g) => ({ ...g })) };
      },
      meshEdges(options = {}) {
        const key = JSON.stringify(options);
        let e = edges.get(key);
        if (!e) {
          const made = meshes.meshEdges(options);
          edges.set(key, (e = { lines: Float32Array.from(made.lines), edgeGroups: made.edgeGroups }));
        }
        return { lines: Array.from(e.lines), edgeGroups: e.edgeGroups.map((g) => ({ ...g })) };
      },
    },
    faceIds: ids("face"),
    edgeIds: ids("edge"),
  };
  meshables.set(b, m);
  return m;
}

/** Indices of a body's faces and edges, by the feature that owns them. */
export type Owned = Record<string, { faces: number[]; edges: number[] }>;

/** The faces each feature created or split in `b` (`owningFeatures`), and the edges along them, e.g. to highlight a feature (research/12). */
export function owners(b: Body): Owned {
  const { faceHist, edgeFaces } = b.topo;
  const out: Owned = {};
  faceHist.forEach((hist, face) => {
    for (const feature of new Set([...hist.values()].flatMap(owningFeatures))) (out[feature] ??= { faces: [], edges: [] }).faces.push(face);
  });
  for (const owned of Object.values(out)) {
    const faces = new Set(owned.faces);
    edgeFaces.forEach((adjacent, edge) => adjacent.some((f) => faces.has(f)) && owned.edges.push(edge));
  }
  return out;
}

/**
 * Indices of a body's faces by every feature that created or changed them, also by only modifying
 * them (`Topo.faceOps`): a face shows as it will until all of them have run again (research/23).
 */
export function shapers(b: Body): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  b.topo.faces.forEach((_, face) => {
    for (const feature of opsOf(b.topo, face)) (out[feature] ??= []).push(face);
  });
  return out;
}

/** The code for picking entity `index` of `b`, with feature names printed as variables where `trace` (that build's) has them. */
export function pickCode(b: Body, kind: Kind, index: number, trace: readonly TraceEntry[]): string {
  const variables = new Set(trace.filter((t) => t.variable).flatMap((t) => t.names ?? [t.name]));
  // The build's own printer stays, as a build may be waiting to run while a pick is answered.
  return withFeaturePrinter((feature) => (variables.has(feature) ? feature : refForm(feature)), () => String(pickRef(b, kind, index)));
}

/** A reference as plain data, e.g. to send to a collaborator, who resolves it against their own build (`locate`). */
export interface RefData {
  kind: Kind;
  names: Name[];
  near?: Vec;
}

/** The reference a pick of entity `index` of `b` writes, as data. */
export function pickData(b: Body, kind: Kind, index: number): RefData {
  const ref = pickRef(b, kind, index);
  return { kind: ref.kind, names: [...ref.names], ...(ref.near ? { near: ref.near } : {}) };
}

/**
 * The volume a feature added to or removed from the body it works on, its first input: what its
 * results have and that body doesn't, and the other way round, i.e. a join's added and a cut's
 * removed material; a combine's tools are not what it works on. A feature without inputs made all
 * of its results. For features whose schema says `hover: "difference"`. The shapes are copies, which
 * share nothing with the bodies, as meshing changes the shapes it meshes (`meshable`).
 */
export function changedVolume(entry: TraceEntry): AnyShape[] {
  if (!entry.inputs.length) return entry.results.map((b) => meshable(b).shape);
  const parts: AnyShape[] = [];
  const input = entry.inputs[0]!;
  for (const result of entry.results)
    for (const [from, minus] of [
      [result, input],
      [input, result],
    ] as const) {
      const cut = boolean("cut", from.topo.shape, minus.topo.shape);
      if (!cut.IsDone()) continue;
      const shape = cut.Shape();
      // A copy: the difference shares faces with the bodies, and it is meshed.
      if (subShapes(shape, "face").length) parts.push(cast(copyShape(shape)));
    }
  return parts;
}

/**
 * The indices of the entities of `b` that a reference names, as a feature resolves it: all
 * descendants of its names, or else the entities its geometric hint suggests. Data that isn't a
 * reference, e.g. from a newer version of the library, names nothing.
 */
export function locate(b: Body, data: RefData): number[] {
  try {
    const r = resolve(b.topo, new Ref(data.kind, data.names, data.near), true);
    const found = "ok" in r ? r.ok : "ambiguous" in r ? r.ambiguous : (r.suggestion ?? []);
    const pool = entities(b.topo, data.kind);
    return found.map((e) => pool.findIndex((x) => x.IsSame(e))).filter((i) => i >= 0);
  } catch {
    return [];
  }
}
