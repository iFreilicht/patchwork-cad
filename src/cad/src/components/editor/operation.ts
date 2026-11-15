/**
 * The operation of an extrusion of a sketch that lies on a body's face: it joins the body where it
 * leaves the face and cuts it where it goes into it, as Fusion's does. The distance runs along the
 * face's outward normal, so its sign tells which, as long as it is a number in the code.
 */
import type { Analysis, FeatureCall } from "../../model/analyze.ts";
import { setProp, type Edit } from "../../model/splice.ts";
import { stringValue } from "../../model/nodes.ts";

const variableOf = (call: FeatureCall | undefined, key: string) => {
  const node = call?.props?.find((p) => p.key === key)?.node;
  return node?.type === "Identifier" ? node.name : undefined;
};

/** The body whose face sketch `sketch` lies on, by its variable. */
export const sketchBody = (analysis: Analysis, sketch: string | undefined): string | undefined =>
  sketch === undefined ? undefined : variableOf(analysis.calls.find((c) => c.variable === sketch), "body");

/** Join for a distance away from the face, cut for one into it; undefined for one that isn't a number or is 0. */
export function operationFor(distance: string): "join" | "cut" | undefined {
  const n = Number(distance.trim());
  return Number.isFinite(distance.trim() === "" ? NaN : n) && n !== 0 ? (n > 0 ? "join" : "cut") : undefined;
}

/**
 * The edits that keep an extrusion's operation fitting its distance once that is `distance`: only for
 * one that joins or cuts the body its sketch lies on, by a distance, not through; a new body stays one.
 */
export function operationEdits(call: FeatureCall, analysis: Analysis, distance: string): Edit[] {
  const target = variableOf(call, "target");
  const operation = stringValue(call.props?.find((p) => p.key === "operation")?.node);
  const extent = stringValue(call.props?.find((p) => p.key === "extent")?.node);
  if ((operation !== "join" && operation !== "cut") || extent === "through" || !target || target !== sketchBody(analysis, variableOf(call, "sketch"))) return [];
  const next = operationFor(distance);
  return next && next !== operation ? setProp(call, "operation", JSON.stringify(next)) : [];
}
