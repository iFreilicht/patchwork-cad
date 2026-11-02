/**
 * Editing bodies as lineages (research/15): a combine's tools in the dependency graph, joining a
 * chain or branching off it, and editing what main returns.
 */
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { allowedRange, graph } from "../src/model/deps.ts";
import { addToReturn, apply, chainMode, deleteFeature, insertFeatureAt, moveEntry, rebody, removeFromReturn, returnEditable, setChainMode, type Edit } from "../src/model/splice.ts";
import { timeline, type FeatureEntry } from "../src/model/timeline.ts";
import type { CadModelDoc } from "../src/types.ts";

const model = (body: string) => `import { sketch, plane, rect, extrude, fillet, chamfer, combine, move } from "@patchwork-cad/features";

export default function main() {
${body
  .trim()
  .split("\n")
  .map((l) => `  ${l.trim()}`)
  .join("\n")}
}
`;

function edit(source: string, edits: (a: ReturnType<typeof analyze>) => Edit[]): string {
  let doc = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  const handle = { change: (fn: (d: CadModelDoc) => void) => (doc = A.change(doc, fn)) } as unknown as DocHandle<CadModelDoc>;
  apply(handle, edits(analyze(source)));
  return doc.source;
}
const tlOf = (source: string) => timeline(source, analyze(source), []);
const indexOf = (source: string, name: string) => tlOf(source).entries.findIndex((e) => e.kind === "feature" && e.name === name);
const statement = (source: string, name: string) => new RegExp(`const ${name} = .*;`).exec(source)?.[0];
const returned = (source: string) => /return (.*);/.exec(source)?.[1];

const SKETCH = `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`;
const base = `
const sketch1 = ${SKETCH};
const plate = extrude({ sketch: sketch1, distance: 5 });
const boss = move({ body: plate, x: 5 });
const fillet1 = fillet({ body: boss, edges: [], radius: 1 });
const combine1 = combine({ target: plate, tools: [fillet1], operation: "cut" });
const chamfer1 = chamfer({ body: combine1, edges: [], distance: 1 });
`;

test("a combine's tools are version uses, which bound a move by their chain's start only", () => {
  const source = model(`${base}\nreturn chamfer1;`);
  const g = graph(analyze(source), tlOf(source));
  expect(g.uses.filter((u) => u.owner === indexOf(source, "combine1")).map((u) => [u.name, u.role, u.key])).toEqual([
    ["plate", "consume", "target"],
    ["fillet1", "tool", "tools"],
  ]);
  // combine1 can move before fillet1 (which the move rewires), not before boss, where fillet1's chain starts.
  expect(allowedRange(g, indexOf(source, "combine1")).min).toBe(indexOf(source, "boss") + 1);
});

test("moving a combine makes its tools the versions at its new place", () => {
  const source = model(`${base}\nreturn chamfer1;`);
  const moved = edit(source, (a) => moveEntry(source, a, tlOf(source), indexOf(source, "combine1"), indexOf(source, "fillet1")));
  expect(statement(moved, "combine1")).toBe('const combine1 = combine({ target: plate, tools: [boss], operation: "cut" });');
});

test("a fillet inserted on a tool goes into the tool's chain", () => {
  const source = model(`${base}\nreturn chamfer1;`);
  const at = indexOf(source, "combine1");
  const out = edit(source, (a) => insertFeatureAt(source, a, tlOf(source), "fillet2", "fillet({ body: fillet1, edges: [], radius: 2 })", at, { shows: true, consumes: "fillet1" }));
  expect(statement(out, "combine1")).toBe('const combine1 = combine({ target: plate, tools: [fillet2], operation: "cut" });');
});

test("deleting a feature on a tool rewires the combine; deleting the combine brings its tools back", () => {
  const source = model(`${base}\nreturn chamfer1;`);
  const del = (name: string) => edit(source, (a) => deleteFeature(source, a, tlOf(source).entries.find((e): e is FeatureEntry => e.kind === "feature" && e.name === name)!));
  expect(statement(del("fillet1"), "combine1")).toBe('const combine1 = combine({ target: plate, tools: [boss], operation: "cut" });');
  const without = del("combine1");
  expect(statement(without, "chamfer1")).toBe("const chamfer1 = chamfer({ body: plate, edges: [], distance: 1 });");
  expect(returned(without)).toBe("[chamfer1, fillet1]");
});

const branched = (mode: "join" | "branch") =>
  model(`
    const sketch1 = ${SKETCH};
    const plate = extrude({ sketch: sketch1, distance: 5 });
    const chamfer1 = chamfer({ body: plate, edges: [], distance: 1 });
    const fillet1 = fillet({ body: ${mode === "join" ? "chamfer1" : "plate"}, edges: [], radius: 1 });
    const combine1 = combine({ target: plate, tools: [fillet1] });
    return ${mode === "join" ? "fillet1" : "[fillet1, chamfer1]"};`);

test("a feature joins its input's chain or branches off it", () => {
  for (const mode of ["join", "branch"] as const) {
    const source = branched(mode);
    const g = graph(analyze(source), tlOf(source));
    expect(chainMode(g, indexOf(source, "chamfer1"))).toBe(mode);
    // The combine uses the fillet as a tool, which carries its chain on, too.
    expect(chainMode(g, indexOf(source, "fillet1"))).toBe("join");
    expect(chainMode(g, indexOf(source, "combine1"))).toBe(undefined);
  }
});

test("switching between joining and branching rewires the later features and the return", () => {
  const joined = branched("join");
  const branch = edit(joined, (a) => setChainMode(joined, a, tlOf(joined), indexOf(joined, "chamfer1"), "branch"));
  expect(statement(branch, "fillet1")).toBe("const fillet1 = fillet({ body: plate, edges: [], radius: 1 });");
  // The combine's target isn't after the chamfer's input in the chain: it stays.
  expect(statement(branch, "combine1")).toBe("const combine1 = combine({ target: plate, tools: [fillet1] });");
  expect(returned(branch)).toBe("[fillet1, chamfer1]");
  const back = edit(branch, (a) => setChainMode(branch, a, tlOf(branch), indexOf(branch, "chamfer1"), "join"));
  expect(statement(back, "fillet1")).toBe("const fillet1 = fillet({ body: chamfer1, edges: [], radius: 1 });");
  expect(returned(back)).toBe("fillet1");
});

test("the return is edited by name, and only while it is a list of names", () => {
  const source = model(`${base}\nreturn chamfer1;`);
  const both = edit(source, (a) => addToReturn(source, a, "boss"));
  expect(returned(both)).toBe("[chamfer1, boss]");
  expect(returned(edit(both, (a) => removeFromReturn(a, "chamfer1")))).toBe("boss");
  expect(returned(edit(source, (a) => removeFromReturn(a, "chamfer1")))).toBe("[]");
  expect(returnEditable(analyze(source))).toBe(true);
  expect(returnEditable(analyze(model(`${base}\nreturn [...[chamfer1]];`)))).toBe(false);
  expect(returnEditable(analyze(model(base)))).toBe(true);
});

/** Two bodies, plate and bar, and a chamfer on one of them, with features after it. */
const twoBodies = (chamfer: string, rest: string, ret: string) =>
  model(`
    const sketch1 = ${SKETCH};
    const plate = extrude({ sketch: sketch1, distance: 5 });
    const sketch2 = ${SKETCH};
    const bar = extrude({ sketch: sketch2, distance: 9 });
    const chamfer1 = chamfer({ body: ${chamfer}, edges: [], distance: 1 });
    ${rest}
    return ${ret};`);
const moved = (source: string, to: string) => edit(source, (a) => rebody(a, tlOf(source), indexOf(source, "chamfer1"), to));

test("a feature moved to another body leaves its old one as it was before it, and joins the new one's chain", () => {
  // At the end: the chamfer stood in the return for bar, and stands for plate now.
  const last = moved(twoBodies("bar", "", "[plate, chamfer1]"), "plate");
  expect(statement(last, "chamfer1")).toBe("const chamfer1 = chamfer({ body: plate, edges: [], distance: 1 });");
  expect(returned(last)).toBe("[chamfer1, bar]");
  // In the middle of chains: plate's fillet works on plate again, bar's on the chamfer.
  const middle = moved(twoBodies("plate", "const fillet1 = fillet({ body: chamfer1, edges: [], radius: 1 });\nconst fillet2 = fillet({ body: bar, edges: [], radius: 1 });", "[fillet1, fillet2]"), "bar");
  expect(statement(middle, "chamfer1")).toBe("const chamfer1 = chamfer({ body: bar, edges: [], distance: 1 });");
  expect(statement(middle, "fillet1")).toBe("const fillet1 = fillet({ body: plate, edges: [], radius: 1 });");
  expect(statement(middle, "fillet2")).toBe("const fillet2 = fillet({ body: chamfer1, edges: [], radius: 1 });");
  expect(returned(middle)).toBe("[fillet1, fillet2]");
  // A branch off plate leaves plate's chain alone, and joins bar's.
  const branch = moved(twoBodies("plate", "const fillet1 = fillet({ body: plate, edges: [], radius: 1 });", "[fillet1, chamfer1, bar]"), "bar");
  expect(statement(branch, "chamfer1")).toBe("const chamfer1 = chamfer({ body: bar, edges: [], distance: 1 });");
  expect(statement(branch, "fillet1")).toBe("const fillet1 = fillet({ body: plate, edges: [], radius: 1 });");
  expect(returned(branch)).toBe("[fillet1, chamfer1]");
});
