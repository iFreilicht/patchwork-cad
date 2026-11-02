/** combine: booleans between bodies, which consume the target and the tools (research/15). */
import { measureVolume, type Shape3D } from "replicad";
import { beforeAll, expect, test } from "vitest";
import { Body, combine, edge, extrude, fillet, move, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, changedVolume, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const volume = (b: Body) => measureVolume(b.shape as Shape3D);
const sum = (shapes: unknown[]) => shapes.reduce<number>((a, s) => a + measureVolume(s as Shape3D), 0);

/** A 20 × 10 × 10 block and a 10 × 10 × 20 post that overlaps half of it. */
function blocks() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  const block = extrude({ sketch: sketch1, distance: 10 }, { name: "block" });
  const sketch2 = sketch({ plane: plane("XY"), profile: rect({ from: [10, 0], to: [20, 10] }) }, { name: "sketch2" });
  const post = extrude({ sketch: sketch2, distance: 20 }, { name: "post" });
  return { block, post };
}

test.each([
  ["join", 20 * 10 * 10 + 10 * 10 * 10, 1000],
  ["cut", 10 * 10 * 10, 1000],
  ["intersect", 10 * 10 * 10, 1000],
] as const)("a %s of two bodies", (operation, expected, changed) => {
  beginBuild({ lenient: false });
  const { block, post } = blocks();
  const combine1 = combine({ target: block, tools: [post], operation }, { name: "combine1" });
  expect(volume(combine1)).toBeCloseTo(expected, 3);
  const entry = currentTrace().at(-1)!;
  expect(entry).toMatchObject({ type: "combine", status: "ok" });
  // It consumes target and tools; hovering it shows what changed in the target.
  expect(entry.after).toEqual([combine1]);
  expect(sum(changedVolume(entry))).toBeCloseTo(changed, 3);
});

test("faces keep the names of both inputs, so a fillet refers to them", () => {
  beginBuild({ lenient: false });
  const { block, post } = blocks();
  const combine1 = combine({ target: block, tools: [post] }, { name: "combine1" });
  // The concave edge where the post's left side meets the block's top.
  fillet({ body: combine1, edges: [edge(block.end, post.side["left"]!)], radius: 1 }, { name: "fillet1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "fillet1", status: "ok" });
});

test("several tools, one of them a copy of the target", () => {
  beginBuild({ lenient: false });
  const { block, post } = blocks();
  const copy = move({ body: block, y: 5 }, { name: "copy" });
  const combine1 = combine({ target: block, tools: [post, copy], operation: "join" }, { name: "combine1" });
  expect(volume(combine1)).toBeCloseTo(20 * 15 * 10 + 10 * 10 * 10, 3);
});

test.each([
  [{ tools: [] }, "tools: select at least one body"],
  [{ tools: "post" }, "tools: select at least one body"],
  [{ tools: ["oops"] }, "tools[0]: expected a body, got string"],
  [{ tools: ["block"] }, "tools: block is the target"],
  [{ tools: ["post"], operation: "xor" }, "operation: expected join, cut or intersect, got xor"],
] as const)("a combine with %j fails alone", (params, message) => {
  beginBuild({ lenient: true });
  const { block, post } = blocks();
  const named = (v: unknown) => (v === "post" ? post : v === "block" ? block : v);
  const tools = Array.isArray(params.tools) ? params.tools.map(named) : params.tools;
  const operation = "operation" in params ? params.operation : undefined;
  const result = combine({ target: block, tools, ...(operation ? { operation } : {}) } as unknown as Parameters<typeof combine>[0], { name: "combine1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "combine1", status: "failed", message });
  // It passes its target through.
  expect(result).toBe(block);
});

test("an intersection of bodies that don't overlap fails", () => {
  beginBuild({ lenient: true });
  const { block } = blocks();
  const away = move({ body: block, x: 100 }, { name: "away" });
  combine({ target: block, tools: [away], operation: "intersect" }, { name: "combine1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "combine1", status: "failed", message: "the intersect leaves nothing" });
});
