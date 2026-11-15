// Picking an extrusion's profiles (research/21, "Sketch from a drawing"): which regions its call
// names, what a click on one writes, an SVG profile's options, and what a dropped SVG becomes.
import { expect, test } from "vitest";
import type { RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { CallExpression } from "acorn";
import { chosenRegions, sketchVariable, toggleRegion } from "../src/components/editor/regions.ts";
import { hasAbsoluteSize, preselects, ROLES } from "../src/components/editor/inserts.ts";
import { analyze, type FeatureCall } from "../src/model/analyze.ts";
import { applyToText, setOption } from "../src/model/splice.ts";
import type { SketchRegion } from "../src/kernel/protocol.ts";

const model = (regions: string | undefined) => `import { sketch, plane, svg, extrude } from "@patchwork-cad/features";
export default function main() {
  const s = sketch({ plane: plane("XY"), profile: svg("<svg/>") });
  const e = extrude({ sketch: s${regions === undefined ? "" : `, regions: ${regions}`}, distance: 2 });
  return { e };
}
`;
const callOf = (source: string): FeatureCall => analyze(source).calls.find((c) => c.variable === "e")!;
const regions: SketchRegion[] = ['s.region("a")', 's.region("a", "b")', 's.region("b")', 's.region("r", { near: [1, 2] })'].map((code, i) => ({ code, filled: i !== 1, triangles: [] }));
/** What the last build resolved the argument to: each reference's regions, by its index in a list. */
const resolved = (matches: (number[] | "broken")[], list = true): RefDiagnostic[] =>
  matches.map((m, i) => ({ param: "regions", body: "s", kind: "region", matches: m === "broken" ? [] : m, ...(list ? { index: i } : {}), code: "", status: m === "broken" ? "missing" : "ok" }));

/** The `regions` argument after a click on region `index`. */
function click(argument: string | undefined, refs: RefDiagnostic[], index: number, count = regions.length): string | undefined {
  const source = model(argument);
  const after = applyToText(source, toggleRegion(callOf(source), source, refs, regions.slice(0, count), index));
  // A new argument comes after the others.
  return /regions: (.*?)(?:, distance: 2 \}|, distance| \}\);)/.exec(after)?.[1];
}

test("the regions an extrusion extrudes: what its argument resolved to, or a sketch's only one", () => {
  expect(sketchVariable(callOf(model(undefined)))).toBe("s");
  const chosen = (argument: string | undefined, refs: RefDiagnostic[], count = regions.length) => [...chosenRegions(callOf(model(argument)), model(argument), refs, regions.slice(0, count))].sort();
  expect(chosen(undefined, [], 1)).toEqual([0]);
  expect(chosen(undefined, [], 3)).toEqual([]);
  // From the code, whatever the last build resolved: a region's own reference, and the sketch's filled ones.
  expect(chosen('[s.region("a"), s.filled]', [])).toEqual([0, 2, 3]);
  expect(chosen('s.region("a", "b")', resolved([[3]], false))).toEqual([1]);
  // Any other reference, as the last build resolved it.
  expect(chosen('[s.region("a" )]', resolved([[0]]))).toEqual([0]);
  expect(chosen('[s.region("q")]', resolved(["broken"]))).toEqual([]);
});

test("a click adds a region that isn't chosen", () => {
  expect(click(undefined, [], 1)).toBe('[s.region("a", "b")]');
  expect(click('[s.region("a")]', resolved([[0]]), 3)).toBe('[s.region("a"), s.region("r", { near: [1, 2] })]');
  expect(click("[]", [], 2)).toBe('[s.region("b")]');
  // A single reference becomes a list.
  expect(click('s.region("a")', resolved([[0]], false), 2)).toBe('[s.region("a"), s.region("b")]');
  // A broken reference stays, for its suggestion.
  expect(click('[s.region("q")]', resolved(["broken"]), 0)).toBe('[s.region("q"), s.region("a")]');
});

test("a click removes a region that is chosen, and splits a reference that names others with it", () => {
  expect(click('[s.region("a"), s.region("b")]', resolved([[0], [2]]), 0)).toBe('[s.region("b")]');
  expect(click('[s.region("a"), s.region("b")]', resolved([[0], [2]]), 2)).toBe('[s.region("a")]');
  expect(click('[s.region("a")]', resolved([[0]]), 0)).toBe("[]");
  expect(click("s.filled", resolved([[0, 2, 3]], false), 2)).toBe('[s.region("a"), s.region("r", { near: [1, 2] })]');
  expect(click('[s.region("b"), s.filled]', resolved([[2], [0, 3]]), 3)).toBe('[s.region("b"), s.region("a")]');
  // A click before the next build, which the last build doesn't know of yet, finds the region's own reference.
  expect(click('[s.region("b"), s.region("a", "b")]', resolved([[2]]), 1)).toBe('[s.region("b")]');
  expect(click('s.region("b")', [], 2)).toBe("[]");
  // A sketch's only region, chosen without the argument.
  expect(click(undefined, [], 0, 1)).toBe("[]");
});

test("an SVG profile's options: set, replaced, removed, and made where there are none", () => {
  const source = (profile: string) => `const s = sketch({ plane: plane("XY"), profile: ${profile} });`;
  const set = (profile: string, key: string, text: string | undefined) => {
    const text0 = source(profile);
    const call = analyze(`${text0}\nexport default function main() {}`).program.body[0] as unknown as { declarations: { init: { arguments: { properties: { key: { name: string }; value: CallExpression }[] }[] } }[] };
    const node = call.declarations[0]!.init.arguments[0]!.properties.find((p) => p.key.name === "profile")!.value;
    return applyToText(text0, setOption(node, key, text)).slice(text0.indexOf("svg"), -4);
  };
  expect(set("svg(logo)", "width", "40")).toBe("svg(logo, { width: 40 })");
  expect(set("svg(logo, {})", "width", "40")).toBe("svg(logo, { width: 40 })");
  expect(set("svg(logo, { width: 40 })", "width", "50")).toBe("svg(logo, { width: 50 })");
  expect(set("svg(logo, { width: 40 })", "center", "[1, 2]")).toBe("svg(logo, { width: 40, center: [1, 2] })");
  expect(set("svg(logo, { width: 40, center: [1, 2] })", "width", undefined)).toBe("svg(logo, { center: [1, 2] })");
  expect(set("svg(logo, { width: 40, center: [1, 2] })", "center", undefined)).toBe("svg(logo, { width: 40 })");
  expect(set("svg(logo, { width: 40 })", "width", undefined)).toBe("svg(logo)");
  expect(set("svg(logo)", "width", undefined)).toBe("svg(logo)");
});

test("an SVG is a sketch where it is dropped on a face, and can be one anywhere", () => {
  const svgFile = { "@patchwork": { type: "file" }, name: "logo", extension: "svg", mimeType: "image/svg+xml", content: "<svg/>" };
  const png = { ...svgFile, extension: "png", mimeType: "image/png", content: new Uint8Array([0x89, 0x50]) };
  expect(preselects({ kind: "face" }, svgFile)).toBe("sketch");
  expect(preselects({ kind: "face" }, png)).toBeUndefined();
  expect(preselects({ kind: "insert" }, svgFile)).toBeUndefined();
  const roles = (value: unknown) => ROLES.filter((r) => r.allows(value, false)).map((r) => r.id);
  expect(roles(svgFile)).toEqual(["sketch", "canvas", "import", "annotation"]);
  expect(roles(png)).toEqual(["canvas", "import", "annotation"]);
  expect(ROLES.find((r) => r.id === "sketch")!.allows(svgFile, true)).toBe(false);
  expect(hasAbsoluteSize('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm">')).toBe(true);
  expect(hasAbsoluteSize("<svg width='2in'>")).toBe(true);
  expect(hasAbsoluteSize('<svg width="200" height="100" viewBox="0 0 2 1">')).toBe(false);
  expect(hasAbsoluteSize('<svg width="200px"><rect width="10mm"/>')).toBe(false);
});
