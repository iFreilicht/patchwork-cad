/**
 * body() in the editor (research/11): timeline entries of destructured bodies, the names prepare
 * passes, and the refactorings, each checked by running the result with the feature library.
 */
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import * as replicad from "replicad";
import { beforeAll, expect, test } from "vitest";
import * as features from "@patchwork-cad/features";
import { beginBuild, currentTrace } from "@patchwork-cad/features/runtime";
import { loadOC } from "../../features/test/oc.ts";
import { prepare } from "../src/kernel/prepare.ts";
import { analyze } from "../src/model/analyze.ts";
import { deleteScript, rename, unwrapBody, wrapInBody, type Refactoring } from "../src/model/refactor.ts";
import { apply, deleteFeature } from "../src/model/splice.ts";
import { timeline, type FeatureEntry } from "../src/model/timeline.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(loadOC);

const plate = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
import { drawRoundedRectangle, drawCircle } from "replicad";

export const defaultParams = { width: 100, depth: 40, height: 12, hole: 30 };

export default function main({ width, depth, height, hole }) {
  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
  const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 20, operation: "join", target: cut_plate });
  return [cut_plate, extrude1];
}
`;

const tlOf = (source: string) => timeline(source, analyze(source), []);
const names = (source: string) => tlOf(source).entries.map((e) => (e.kind === "feature" ? e.names.join(",") : "script"));

function applied(source: string, r: Refactoring): string {
  if ("error" in r) throw new Error(r.error);
  let doc = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  apply({ change: (fn: (d: CadModelDoc) => void) => (doc = A.change(doc, fn)) } as unknown as DocHandle<CadModelDoc>, r.edits);
  return doc.source;
}

/** Runs a model as the editor's lenient build would, with the names prepare injects; returns main's result and the trace. */
function run(source: string) {
  const code = prepare(source)
    .replace(/^export const defaultParams/m, "const defaultParams")
    .replace("export default function main", "function main");
  (globalThis as Record<string, unknown>)["patchworkCadFeatures"] = features;
  (globalThis as Record<string, unknown>)["replicad"] = replicad;
  beginBuild({ lenient: true });
  const result = new Function(`${code}\nreturn main(defaultParams);`)() as unknown;
  return { result, trace: currentTrace() };
}

test("a destructured body() is one timeline entry with all its names, which prepare passes on", () => {
  const source = plate.replace('const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));', "const [cut_plate] = body(() => [plate.cut(bore)]);").replace("extrude } from", "extrude, body } from");
  expect(names(source)).toEqual(["script", "cut_plate", "sketch1", "extrude1"]);
  expect(prepare(source)).toContain(`{ name: "cut_plate", line: 9, variable: true, names: ["cut_plate"] })`);
  const { trace } = run(source);
  expect(trace.map((t) => [t.name, t.status])).toEqual([["cut_plate", "ok"], ["sketch1", "ok"], ["extrude1", "ok"]]);
});

test("wrapping the script in body() lets the join use it", () => {
  // Without it, the join fails alone and says why.
  const before = run(plate).trace.find((t) => t.name === "extrude1")!;
  expect(before).toMatchObject({ status: "failed", message: "target: a replicad shape, not a feature body; wrap it with body(…)" });

  const wrapped = applied(plate, wrapInBody(plate, analyze(plate), tlOf(plate), 0));
  expect(wrapped).toContain(`  const cut_plate = body(() => {
    const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
    const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
    const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
    return cut_plate;
  });
  const sketch1`);
  expect(wrapped).toContain('import { sketch, plane, rect, extrude, body } from "@patchwork-cad/features";');
  expect(names(wrapped)).toEqual(["cut_plate", "sketch1", "extrude1"]);
  const { trace } = run(wrapped);
  expect(trace.map((t) => [t.name, t.status])).toEqual([["cut_plate", "ok"], ["sketch1", "ok"], ["extrude1", "ok"]]);

  // Unwrapping is refused while a feature uses it as a body …
  expect(unwrapBody(wrapped, analyze(wrapped), tlOf(wrapped), 0)).toEqual({ error: "extrude1 uses it as a body" });
  // … and gives the code back otherwise: unwrapping is the inverse of wrapping.
  const unused = wrapped.replace('operation: "join", target: cut_plate', 'operation: "new"');
  const unwrapped = applied(unused, unwrapBody(unused, analyze(unused), tlOf(unused), 0));
  expect(unwrapped).toBe(plate.replace('operation: "join", target: cut_plate', 'operation: "new"').replace("extrude } from", "extrude, body } from"));
});

test("unwrapping a closure that ends in an expression, and refusing clashing names", () => {
  const source = `import { body } from "@patchwork-cad/features";
import { drawCircle } from "replicad";
export default function main() {
  const [a, b] = body(() => {
    const disc = drawCircle(5).sketchOnPlane().extrude(1);
    return [disc, disc.translate(20, 0, 0)];
  });
  return [a, b];
}
`;
  const tl = tlOf(source);
  expect(names(source)).toEqual(["a,b"]);
  const unwrapped = applied(source, unwrapBody(source, analyze(source), tl, 0));
  expect(unwrapped).toContain(`  const disc = drawCircle(5).sketchOnPlane().extrude(1);
  const [a, b] = [disc, disc.translate(20, 0, 0)];
  return [a, b];`);
  const clashing = source.replace("return [a, b];\n}", "const disc = 1;\n  return [a, b];\n}");
  expect(unwrapBody(clashing, analyze(clashing), tlOf(clashing), 0)).toEqual({ error: "its disc would clash with the model's" });
});

test("wrapping is refused where body would be hidden or nothing escapes", () => {
  const m3 = plate.replace("const plate =", "let body = 1;\n  const plate =");
  expect(wrapInBody(m3, analyze(m3), tlOf(m3), 0)).toEqual({ error: "the model has its own variable named body" });
  const unusedScript = plate.replace("target: cut_plate", "target: undefined").replace("return [cut_plate, extrude1];", "return extrude1;");
  expect(wrapInBody(unusedScript, analyze(unusedScript), tlOf(unusedScript), 0)).toEqual({ error: "nothing it declares is used later" });
  // A property named body (fillet({ body })) doesn't count as a variable.
  const withProp = plate.replace("return [cut_plate, extrude1];", "const x = { body: 1 };\n  return [cut_plate, extrude1];");
  expect("edits" in wrapInBody(withProp, analyze(withProp), tlOf(withProp), 0)).toBe(true);
});

test("renaming a body updates its uses, shorthand properties and ref lookups", () => {
  const wrapped = applied(plate, wrapInBody(plate, analyze(plate), tlOf(plate), 0));
  const renamed = applied(wrapped, rename(analyze(wrapped), tlOf(wrapped), 0, "cut_plate", "base"));
  expect(renamed).toContain("const base = body(() => {");
  // The closure's own cut_plate is another variable and keeps its name.
  expect(renamed).toContain("const cut_plate = plate.cut(bore)");
  expect(renamed).toContain("return cut_plate;\n  });");
  expect(renamed).toContain('target: base });');
  expect(renamed).toContain("return [base, extrude1];");
  run(renamed);
  const tl = tlOf(renamed);
  expect(rename(analyze(renamed), tl, 0, "base", "sketch1")).toEqual({ error: "sketch1 is already used in the model" });
  expect(rename(analyze(renamed), tl, 0, "base", "drawCircle")).toEqual({ error: "drawCircle is already used in the model" });
  expect(rename(analyze(renamed), tl, 0, "base", "class")).toEqual({ error: "class is not a valid name" });
  expect(rename(analyze(renamed), tl, 0, "base", "body")).toEqual({ error: "body is already used in the model" });
  const shorthand = `import { fillet, body } from "@patchwork-cad/features";\nexport default function main() {\n  const b = body(1);\n  const f = fillet({ body: b, edges: [ref.b.faceAt([0, 0, 0])], radius: 1 });\n  const g = { b };\n  return f;\n}\n`;
  const r = applied(shorthand, rename(analyze(shorthand), tlOf(shorthand), 0, "b", "plate"));
  expect(r).toContain("const plate = body(1);");
  expect(r).toContain("fillet({ body: plate, edges: [ref.plate.faceAt([0, 0, 0])]");
  expect(r).toContain("const g = { b: plate };");
});

test("deleting a body() takes it out of the result; a script is deleted only if nothing uses it", () => {
  const source = `import { body } from "@patchwork-cad/features";
import { drawCircle } from "replicad";
export default function main() {
  const r = 5;
  const [a, b] = body(() => [drawCircle(r).sketchOnPlane().extrude(1), drawCircle(r).sketchOnPlane().extrude(2)]);
  const c = body(drawCircle(1).sketchOnPlane().extrude(3));
  return [a, c, b];
}
`;
  const tl = tlOf(source);
  const entry = tl.entries[1] as FeatureEntry;
  const out = applied(source, { edits: deleteFeature(source, analyze(source), entry) });
  expect(out).toContain("return c;");
  expect(out).not.toContain("const [a, b]");
  expect(deleteScript(source, analyze(source), tl, 0)).toEqual({ error: "later code uses its r" });
  // A feature that uses a deleted body without an input gets a ref lookup, which fails it alone.
  const used = source.replace("return [a, c, b];", "const f = fillet({ body: c, edges: [], radius: 1 });\n  return [a, f, b];");
  const withoutC = applied(used, { edits: deleteFeature(used, analyze(used), tlOf(used).entries[2] as FeatureEntry) });
  expect(withoutC).toContain("fillet({ body: ref.c, edges: [], radius: 1 })");
  const unused = source.replace("drawCircle(r)", "drawCircle(5)").replace("drawCircle(r)", "drawCircle(5)");
  expect(applied(unused, deleteScript(unused, analyze(unused), tlOf(unused), 0))).not.toContain("const r = 5;");
});
