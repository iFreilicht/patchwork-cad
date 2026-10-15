/** What the editor needs beyond the model API: build control, the trace, picking and the feature schemas. */
export { beginBuild, currentTrace, liveBodies, pick, entityIndex, outline, FeatureError } from "./feature.ts";
export type { TraceEntry, RefDiagnostic, FeatureContext } from "./feature.ts";
export { resolve, capture } from "./refs.ts";
export type { Resolution } from "./refs.ts";
export type { Topo } from "./topo.ts";
export { describe } from "./geom.ts";
import { body, chamfer, extrude, fillet, sketch } from "./features.ts";
import { pick as pickRef, type Body, type TraceEntry } from "./feature.ts";
import { refForm, setFeaturePrinter } from "./names.ts";
import { oc, type Kind } from "./oc.ts";
import { entities } from "./topo.ts";

/** The built-in features by function name, for recognizing calls and rendering their forms. */
export const builtins = { sketch, extrude, fillet, chamfer, body } as const;

/** replicad's id of each face or edge of a body, as in its meshes' `faceGroups`/`edgeGroups` (`ReplicadShapeHasher.HashCode`). */
export function meshIds(b: Body, kind: Kind): number[] {
  const hasher = oc().ReplicadShapeHasher;
  return entities(b.topo, kind).map((e) => hasher.HashCode(e, 2147483647));
}

/** The code for picking entity `index` of `b`, with feature names printed as variables where `trace` (that build's) has them. */
export function pickCode(b: Body, kind: Kind, index: number, trace: readonly TraceEntry[]): string {
  const variables = new Set(trace.filter((t) => t.variable).flatMap((t) => t.names ?? [t.name]));
  setFeaturePrinter((feature) => (variables.has(feature) ? feature : refForm(feature)));
  return String(pickRef(b, kind, index));
}
