/** Lineages and their lanes beneath the timeline (research/15), derived from the code. */
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { graph } from "../src/model/deps.ts";
import { lanes, lanesAt, type Lanes } from "../src/model/lanes.ts";
import { timeline } from "../src/model/timeline.ts";

const model = (body: string) => `import { sketch, plane, rect, circle, extrude, fillet, chamfer, combine, move, body, edge } from "@patchwork-cad/features";

export default function main() {
${body
  .trim()
  .split("\n")
  .map((l) => `  ${l.trim()}`)
  .join("\n")}
}
`;

function lanesOf(body: string): Lanes {
  const source = model(body);
  const a = analyze(source);
  const tl = timeline(source, a, []);
  return lanes(tl, graph(a, tl));
}

/** Each lane as `name: versions (row) …`, with how it starts and ends. */
const summary = (l: Lanes) =>
  l.lanes.map((lane) => {
    const from = lane.from ? ` ${lane.from.kind} from ${l.lanes[lane.from.from.lane]!.name}@${lane.from.from.entry}` : "";
    const end = lane.merged !== undefined ? ` merged@${lane.merged}` : lane.returned ? " returned" : "";
    return `${lane.output ? "output " : ""}${lane.name}: ${lane.versions.map((v) => `${v.name} `).join("")}[${lane.start}-${lane.stop}] row ${lane.row}${from}${end}`;
  });

const SKETCH = `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`;

const plate = `
const sketch1 = ${SKETCH};
const plate = extrude({ sketch: sketch1, distance: 5 });
const sketch2 = ${SKETCH};
const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" });
const fillet1 = fillet({ body: bore, edges: [], radius: 1 });
`;

test("a chain is one lane, from its sketch to the return; a cut's sketch merges into it", () => {
  const l = lanesOf(`${plate}\nreturn fillet1;`);
  expect(summary(l)).toEqual(["plate: sketch1 plate bore fillet1 [0-5] row 0 returned", "sketch2: sketch2 [2-3] row 1 merged@3"]);
  expect(l.rows).toBe(2);
  expect(l.links).toEqual([{ kind: "merge", from: { lane: 1, entry: 2 }, to: { lane: 0, entry: 3 } }]);
});

test("rows are reused once a lane has ended, also in the next column", () => {
  const l = lanesOf(`${plate}
    const sketch3 = ${SKETCH};
    const boss = extrude({ sketch: sketch3, operation: "join", target: fillet1 });
    return boss;`);
  expect(summary(l)).toEqual(["plate: sketch1 plate bore fillet1 boss [0-7] row 0 returned", "sketch2: sketch2 [2-3] row 1 merged@3", "sketch3: sketch3 [5-6] row 1 merged@6"]);
  expect(l.rows).toBe(2);
});

test("a fork: the continuation with the longer chain keeps the lane, the earlier one on a tie", () => {
  const longer = lanesOf(`${plate}
    const chamfer1 = chamfer({ body: bore, edges: [], distance: 1 });
    const chamfer2 = chamfer({ body: chamfer1, edges: [], distance: 1 });
    return [fillet1, chamfer2];`);
  expect(summary(longer)).toEqual([
    "plate: sketch1 plate bore chamfer1 chamfer2 [0-7] row 0 returned",
    "sketch2: sketch2 [2-3] row 1 merged@3",
    "fillet1: fillet1 [3-7] row 2 fork from plate@3 returned",
  ]);
  const tie = lanesOf(`${plate}
    const chamfer1 = chamfer({ body: bore, edges: [], distance: 1 });
    return [fillet1, chamfer1];`);
  expect(summary(tie)).toEqual(["plate: sketch1 plate bore fillet1 [0-6] row 0 returned", "sketch2: sketch2 [2-3] row 1 merged@3", "chamfer1: chamfer1 [3-6] row 2 fork from plate@3 returned"]);
});

test("a move copies: its lane starts with a copy link and leaves the original's lane open", () => {
  const l = lanesOf(`${plate}
    const move1 = move({ body: fillet1, x: 20 });
    return [fillet1, move1];`);
  expect(summary(l)).toEqual(["plate: sketch1 plate bore fillet1 [0-6] row 0 returned", "sketch2: sketch2 [2-3] row 1 merged@3", "move1: move1 [4-6] row 1 copy from plate@4 returned"]);
});

test("a combine merges its tools into its target's lane, also a fork of the target (a diamond)", () => {
  const l = lanesOf(`${plate}
    const boss = chamfer({ body: plate, edges: [], distance: 1 });
    const combine1 = combine({ target: fillet1, tools: [boss], operation: "cut" });
    return combine1;`);
  expect(summary(l)).toEqual([
    "plate: sketch1 plate bore fillet1 combine1 [0-7] row 0 returned",
    "sketch2: sketch2 [2-3] row 2 merged@3",
    "boss: boss [1-6] row 1 fork from plate@1 merged@6",
  ]);
  expect(l.links).toContainEqual({ kind: "merge", from: { lane: 2, entry: 5 }, to: { lane: 0, entry: 6 } });
});

test("several tools, one of them also returned, and one used twice", () => {
  const l = lanesOf(`
    const sketch1 = ${SKETCH};
    const a = extrude({ sketch: sketch1, distance: 5 });
    const b = move({ body: a, x: 5 });
    const c = move({ body: a, y: 5 });
    const ab = combine({ target: a, tools: [b, c] });
    const d = combine({ target: ab, tools: [c] });
    return [d, b];`);
  expect(summary(l)).toEqual([
    "a: sketch1 a ab d [0-6] row 0 returned",
    "b: b [1-4] row 1 copy from a@1 merged@4",
    "c: c [1-4] row 2 copy from a@1 merged@4",
    "output b: [2-6] row 3 output from b@2 returned",
  ]);
  // c's second use as a tool is a link of its own.
  expect(l.links).toContainEqual({ kind: "merge", from: { lane: 2, entry: 3 }, to: { lane: 0, entry: 5 } });
});

test("a returned version that a later feature continues is a body of its own, on a lane of its own to the return", () => {
  const l = lanesOf(`${plate}\nreturn [plate, fillet1];`);
  // The lineage it is in is named by its first body version that isn't one: bore.
  expect(summary(l)).toEqual(["bore: sketch1 plate bore fillet1 [0-5] row 0 returned", "sketch2: sketch2 [2-3] row 2 merged@3", "output plate: [1-5] row 1 output from bore@1 returned"]);
  // It exists from where it is made, also after bore consumed it.
  const at = (m: number) => lanesAt(l, m).map(({ lane, head }) => `${l.lanes[lane]!.name}:${head.name}`);
  expect(at(1)).toEqual(["bore:sketch1"]);
  expect(at(2)).toEqual(["bore:plate", "plate:plate"]);
  expect(at(5)).toEqual(["bore:fillet1", "plate:plate"]);
});

test("open heads that main doesn't return end at their entry; an unused sketch is a lane of its own", () => {
  const l = lanesOf(`${plate}
    const sketch3 = ${SKETCH};
    return [bore];`);
  expect(summary(l)).toEqual(["plate: sketch1 plate bore fillet1 [0-4] row 0", "sketch2: sketch2 [2-3] row 1 merged@3", "sketch3: sketch3 [5-5] row 0", "output bore: [3-6] row 2 output from plate@3 returned"]);
});

test("Custom Script names that features use start lanes; body() starts one per name", () => {
  const l = lanesOf(`
    const raw = drawBox();
    const [left, right] = body(() => [raw, raw]);
    const fillet1 = fillet({ body: left, edges: [], radius: 1 });
    const width = 10;
    const fillet2 = fillet({ body: right, edges: [], radius: width });
    return [fillet1, fillet2];`);
  expect(summary(l)).toEqual(["left: left fillet1 [1-5] row 0 returned", "right: right fillet2 [1-5] row 1 returned"]);
});

test("the lanes at the marker, with their heads there", () => {
  const l = lanesOf(`${plate}
    const move1 = move({ body: fillet1, x: 20 });
    return [fillet1, move1];`);
  const at = (m: number) => lanesAt(l, m).map(({ lane, head }) => `${l.lanes[lane]!.name}:${head.name}`);
  expect(at(0)).toEqual([]);
  expect(at(3)).toEqual(["plate:plate", "sketch2:sketch2"]);
  expect(at(4)).toEqual(["plate:bore"]);
  expect(at(6)).toEqual(["plate:fillet1", "move1:move1"]);
});

test("Custom Script code carries a version on into what it declares, or ends its lane", () => {
  const l = lanesOf(`
    const sketch1 = ${SKETCH};
    const upright = extrude({ sketch: sketch1, distance: 5 });
    let body = upright;
    for (const x of [1, 2]) body = extrude({ sketch: sketch1, distance: x, operation: "join", target: body });
    const fillet1 = fillet({ body, edges: [], radius: 1 });
    const sketch2 = ${SKETCH};
    const tool = extrude({ sketch: sketch2, distance: 5 });
    console.log(tool.shape);
    return fillet1;`);
  expect(summary(l)).toEqual(["upright: sketch1 upright body fillet1 [0-7] row 0 returned", "tool: sketch2 tool [4-6] row 1 merged@6"]);
  // The code that ends a lane has no lane to link to.
  expect(l.links).toEqual([]);
});
