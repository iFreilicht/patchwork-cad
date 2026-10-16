/** What the editor needs beyond the model API: build control, the trace, picking and the feature schemas. */
export { beginBuild, currentTrace, liveBodies, pick, entityIndex, outline, FeatureError } from "./feature.ts";
export type { TraceEntry, RefDiagnostic, FeatureContext } from "./feature.ts";
export { resolve, capture } from "./refs.ts";
export type { Resolution } from "./refs.ts";
export type { Topo } from "./topo.ts";
export { describe } from "./geom.ts";
import { body, chamfer, extrude, fillet, sketch } from "./features.ts";
import { pick as pickRef, type Body, type TraceEntry } from "./feature.ts";
import { owningFeatures, refForm, setFeaturePrinter, type Name, type Vec } from "./names.ts";
import { Ref, resolve } from "./refs.ts";
import { oc, type Kind } from "./oc.ts";
import { entities } from "./topo.ts";

/** The built-in features by function name, for recognizing calls and rendering their forms. */
export const builtins = { sketch, extrude, fillet, chamfer, body } as const;

/** replicad's id of each face or edge of a body, as in its meshes' `faceGroups`/`edgeGroups` (`ReplicadShapeHasher.HashCode`). */
export function meshIds(b: Body, kind: Kind): number[] {
  const hasher = oc().ReplicadShapeHasher;
  return entities(b.topo, kind).map((e) => hasher.HashCode(e, 2147483647));
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

/** The code for picking entity `index` of `b`, with feature names printed as variables where `trace` (that build's) has them. */
export function pickCode(b: Body, kind: Kind, index: number, trace: readonly TraceEntry[]): string {
  const variables = new Set(trace.filter((t) => t.variable).flatMap((t) => t.names ?? [t.name]));
  setFeaturePrinter((feature) => (variables.has(feature) ? feature : refForm(feature)));
  return String(pickRef(b, kind, index));
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
