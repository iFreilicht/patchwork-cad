/**
 * Picking an extrusion's profiles (research/21, "Sketch from a drawing"): the regions of its sketch
 * as the last build has them, which of them its `regions` argument names, and what a click on one
 * writes. A click adds a region that isn't chosen and removes one that is: from a list, or from a
 * `sketch2.filled`, which then becomes a list of the others it named.
 *
 * What is chosen is read from the code as it is now wherever it can be, a region's own reference or
 * the sketch's `filled`, so that a click shows at once and never against a build that is behind it;
 * any other reference as the last build resolved it.
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

/** Each reference of the argument, as the code has it, and the regions it names: in a list, by its index there. */
function references(call: FeatureCall, source: string, refs: readonly RefDiagnostic[], regions: readonly SketchRegion[]): { index: number | undefined; code: string; names: number[] }[] {
  const node = regionsNode(call);
  if (!node) return [];
  const sketch = sketchVariable(call);
  const list = node.type === "ArrayExpression";
  const items = list ? elements(call, PARAM).map((s, index) => ({ index: index as number | undefined, code: source.slice(s.start, s.end) })) : [{ index: undefined, code: source.slice(node.start, node.end) }];
  const all = regions.map((_, i) => i);
  return items.map(({ index, code }) => {
    if (sketch && code === `${sketch}.filled`) return { index, code, names: all.filter((i) => regions[i]!.filled) };
    const own = regions.findIndex((r) => r.code === code);
    if (own >= 0) return { index, code, names: [own] };
    const resolved = refs.find((d) => d.param === PARAM && d.kind === "region" && d.index === index);
    return { index, code, names: resolved?.status === "ok" ? resolved.matches.filter((m) => m < regions.length) : [] };
  });
}

/** The regions an extrusion extrudes: those its `regions` names, or a sketch's only one without the argument. */
export function chosenRegions(call: FeatureCall, source: string, refs: readonly RefDiagnostic[], regions: readonly SketchRegion[]): Set<number> {
  if (!regionsNode(call)) return new Set(regions.length === 1 ? [0] : []);
  return new Set(references(call, source, refs, regions).flatMap((r) => r.names));
}

/** The edits a click on region `index` of `regions` makes to an extrusion's call, given what the last build resolved (`refs`). */
export function toggleRegion(call: FeatureCall, source: string, refs: readonly RefDiagnostic[], regions: readonly SketchRegion[], index: number): Edit[] {
  const node = regionsNode(call);
  const region = regions[index];
  if (!region) return [];
  // The sketch's only region, chosen without the argument: none is chosen then.
  if (!node) return regions.length === 1 ? setProp(call, PARAM, "[]") : appendElement(call, PARAM, region.code);
  const list = node.type === "ArrayExpression";
  const all = references(call, source, refs, regions);
  const naming = all.filter((r) => r.names.includes(index));
  if (!naming.length) return list ? appendElement(call, PARAM, region.code) : setProp(call, PARAM, `[${source.slice(node.start, node.end)}, ${region.code}]`);
  // Its own reference goes; one that names it with others, e.g. `filled`, becomes the others'.
  const first = naming.find((r) => r.names.length === 1) ?? naming[0]!;
  // Without those another reference names too.
  const elsewhere = new Set(all.filter((r) => r !== first).flatMap((r) => r.names));
  const others = first.names.filter((m) => m !== index && !elsewhere.has(m)).map((m) => regions[m]!.code);
  if (!list) return setProp(call, PARAM, `[${others.join(", ")}]`);
  return others.length ? replaceElement(call, PARAM, first.index!, others.join(", ")) : removeElement(call, PARAM, first.index!);
}
