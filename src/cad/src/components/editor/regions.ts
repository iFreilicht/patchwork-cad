/**
 * Picking an extrusion's profiles (research/21, "Sketch from a drawing"): the regions of its sketch
 * as the last build has them, which of them its `regions` argument names, and what a click on one
 * writes. A click adds a region that isn't chosen and removes one that is: from a list, or from a
 * `sketch2.filled`, which then becomes a list of the others it named.
 */
import type { RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { FeatureCall } from "../../model/analyze.ts";
import { appendElement, elements, removeElement, replaceElement, setProp, type Edit } from "../../model/splice.ts";
import type { SketchRegion } from "../../kernel/protocol.ts";

const PARAM = "regions";

const regionsNode = (call: FeatureCall) => call.props?.find((p) => p.key === PARAM)?.node;

/** The variable of the sketch an extrusion's call extrudes, if it names one. */
export function sketchVariable(call: FeatureCall): string | undefined {
  const node = call.props?.find((p) => p.key === "sketch")?.node;
  return node?.type === "Identifier" ? node.name : undefined;
}

/** What the last build resolved each of the argument's references to, by its index in a list, or for the whole argument. */
const diagnostics = (refs: readonly RefDiagnostic[]) => refs.filter((d) => d.param === PARAM && d.kind === "region");

/** The regions an extrusion extrudes: those its `regions` named in the last build, or a sketch's only one without the argument. */
export function chosenRegions(call: FeatureCall, refs: readonly RefDiagnostic[], count: number): Set<number> {
  if (!regionsNode(call)) return new Set(count === 1 ? [0] : []);
  return new Set(diagnostics(refs).flatMap((d) => (d.status === "ok" ? d.matches : [])));
}

/** The edits a click on region `index` of `regions` makes to an extrusion's call, given what the last build resolved (`refs`). */
export function toggleRegion(call: FeatureCall, source: string, refs: readonly RefDiagnostic[], regions: readonly SketchRegion[], index: number): Edit[] {
  const node = regionsNode(call);
  const region = regions[index];
  if (!region) return [];
  // Its own reference, as the code has it now, which a click before the next build may have written.
  const items = node?.type === "ArrayExpression" ? elements(call, PARAM).map((e) => source.slice(e.start, e.end)) : node ? [source.slice(node.start, node.end)] : [];
  const own = items.indexOf(region.code);
  if (own >= 0) return node?.type === "ArrayExpression" ? removeElement(call, PARAM, own) : setProp(call, PARAM, "[]");
  const chosen = chosenRegions(call, refs, regions.length);
  if (!chosen.has(index)) {
    if (!node || node.type === "ArrayExpression") return appendElement(call, PARAM, region.code);
    return setProp(call, PARAM, `[${source.slice(node.start, node.end)}, ${region.code}]`);
  }
  // The sketch's only region, chosen without the argument: none is chosen then.
  if (!node) return setProp(call, PARAM, "[]");
  const list = node.type === "ArrayExpression";
  const naming = diagnostics(refs).find((d) => d.status === "ok" && d.matches.includes(index) && (list ? d.index !== undefined : d.index === undefined));
  if (!naming) return [];
  // A reference that named it with others, e.g. `filled`, becomes the others'.
  const others = naming.matches.filter((m) => m !== index).map((m) => regions[m]?.code).filter((c): c is string => !!c);
  if (!list) return setProp(call, PARAM, `[${others.join(", ")}]`);
  const at = naming.index!;
  if (at >= elements(call, PARAM).length) return [];
  return others.length ? replaceElement(call, PARAM, at, others.join(", ")) : removeElement(call, PARAM, at);
}
