import { readFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { apply, appendElement, deleteFeature, insertFeature, retarget, setProp, type Edit } from "../src/model/splice.ts";
import { timeline, type FeatureEntry } from "../src/model/timeline.ts";
import type { FeatureTrace } from "../src/kernel/protocol.ts";
import type { CadModelDoc } from "../src/types.ts";

const example = (name: string) => readFileSync(new URL(`../../features/examples/${name}.js`, import.meta.url), "utf8");

/** Just enough of a DocHandle for apply(). */
function fakeHandle(source: string) {
  let doc = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  const handle = { change: (fn: (d: CadModelDoc) => void) => (doc = A.change(doc, fn)), doc: () => doc };
  return { handle: handle as unknown as DocHandle<CadModelDoc>, source: () => doc.source };
}

const edit = (source: string, edits: (a: ReturnType<typeof analyze>) => Edit[]) => {
  const h = fakeHandle(source);
  apply(h.handle, edits(analyze(source)));
  return h.source();
};

const feature = (source: string, name: string) => timeline(source, analyze(source), []).entries.find((e): e is FeatureEntry => e.kind === "feature" && e.name === name)!;

test("M1's timeline is a list of features", () => {
  const source = example("m1");
  const tl = timeline(source, analyze(source), []);
  expect(tl.entries.map((e) => (e.kind === "feature" ? e.name : "script"))).toEqual(["sketch1", "extrude1", "sketch2", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"]);
  expect(source.slice(tl.returned!.start, tl.returned!.end)).toBe("return extrude2;");
});

test("M3's rib loop is a Custom Script entry with the features it ran", () => {
  const source = example("m3");
  const trace = [16, 16].map((line, i): FeatureTrace => ({ name: `rib${i}`, type: "extrude", line, variable: false, status: "ok", message: undefined, refs: [], before: [], result: `rib${i}`, outline: undefined, unused: false, ms: 0, namingMs: 0 }));
  const tl = timeline(source, analyze(source), trace);
  expect(tl.entries.map((e) => (e.kind === "feature" ? e.name : `script ${e.lines.join("-")}`))).toEqual(["sketch1", "base", "sketch2", "upright", "script 12-18", "fillet1", "chamfer1", "sketch3", "extrude1"]);
  const script = tl.entries[4]!;
  expect(script.kind === "script" && script.features.map((f) => f.name)).toEqual(["rib0", "rib1"]);
});

test("a form edit replaces only the argument's span", () => {
  const source = example("m1");
  const out = edit(source, () => setProp(feature(source, "extrude1").call, "distance", "h * 2"));
  expect(out).toBe(source.replace("extrude({ sketch: sketch1, distance: h })", "extrude({ sketch: sketch1, distance: h * 2 })"));
});

test("a picked edge is appended to the edge list", () => {
  const source = example("m1");
  const out = edit(source, () => appendElement(feature(source, "fillet1").call, "edges", "edge(extrude1.start, notch.side.c)"));
  expect(out).toContain("edges: [edge(extrude1.end, notch.side.c), edge(extrude1.start, notch.side.c)]");
});

test("a new feature goes before the return, which shows its result", () => {
  const source = example("m1");
  const out = edit(source, (a) => insertFeature(source, a, "fillet2", "fillet({ body: extrude2, edges: [], radius: 1 })", { consumes: "extrude2", body: true }));
  expect(out).toContain("  const fillet2 = fillet({ body: extrude2, edges: [], radius: 1 });\n  return fillet2;");
});

test("a new body is added to the return, and its functions are imported", () => {
  const source = example("m1");
  const out = edit(source, (a) => insertFeature(source, a, "extrude3", "extrude({ sketch: polygon({}), distance: 1 })", { body: true }));
  expect(out).toContain("return [extrude2, extrude3];");
  expect(out).toContain('chamfer, edge, polygon } from "@patchwork-cad/features"');
});

test("deleting a feature rewires its users and turns references to it into ref lookups", () => {
  const source = example("m1");
  const out = edit(source, (a) => deleteFeature(source, a, feature(source, "notch")));
  expect(out).not.toContain("const notch");
  expect(out).toContain("const fillet1 = fillet({ body: extrude1, edges: [edge(extrude1.end, ref.notch.side.c)], radius: 1.5 });");
  expect(out).toContain(".piece(ref.notch, 1, ");
  expect(out).toContain('edge, ref } from "@patchwork-cad/features"');
  expect(analyze(out).calls).toHaveLength(analyze(source).calls.length - 1);
});

/** A plate whose chamfer runs around a filleted edge, with an extrusion that is retargeted. */
const branching = (target: string, returned: string) => `import { sketch, plane, rect, circle, extrude, fillet, edge, chamfer } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance: 12 });
  const fillet1 = fillet({ body: plate, edges: [edge(plate.end, plate.side.front)], radius: 5 });
  const chamfer1 = chamfer({ body: fillet1, edges: [edge(plate.end, plate.side.left)], distance: 3 });
  const sketch2 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch2, distance: -10${target ? `, operation: "join", target: ${target}` : ""} });
  return ${returned};
}
`;

/** Sets extrude1's target the way the form does, and returns the new return statement. */
function retargetExtrude(source: string, next: string): string {
  const out = edit(source, (a) => {
    const call = a.calls.find((c) => c.variable === "extrude1")!;
    const current = call.props!.find((p) => p.key === "target");
    const previous = current ? source.slice(current.value.start, current.value.end) : undefined;
    return [...setProp(call, "target", next), ...retarget(a, call, "extrude1", previous, next)];
  });
  return /return [^;]*;/.exec(out)![0];
}

test("a feature that works on a returned body replaces it in the result", () => {
  expect(retargetExtrude(branching("", "[chamfer1, extrude1]"), "chamfer1")).toBe("return extrude1;");
});

test("a body that a retargeted feature no longer uses comes back into the result instead of being dropped", () => {
  expect(retargetExtrude(branching("chamfer1", "extrude1"), "fillet1")).toBe("return [extrude1, chamfer1];");
});

test("a body that another feature still uses doesn't come back", () => {
  // fillet1 stays used by chamfer1.
  expect(retargetExtrude(branching("fillet1", "[extrude1, chamfer1]"), "chamfer1")).toBe("return extrude1;");
});
