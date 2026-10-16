// References as data (research/13): a collaborator's picked face or edge, sent as its Ref data, is
// found in another build state, e.g. before or after the split that a rolled-back timeline lacks.
import { beforeAll, expect, test } from "vitest";
import { print } from "../src/names.ts";
import { beginBuild, currentTrace, locate, pickData, type RefData } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

async function m1() {
  const model = (await import("../examples/m1.js")) as { default: (p: unknown) => unknown; defaultParams: unknown };
  beginBuild({ lenient: false });
  model.default(model.defaultParams);
  const trace = currentTrace();
  // extrude#1 is the block, extrude#2 the notch that splits its front face.
  return { block: trace.find((t) => t.name === "extrude#1")!.result!, final: trace.at(-1)!.result! };
}

const faceNamed = (body: Awaited<ReturnType<typeof m1>>["final"], text: string) => body.topo.faceHist.findIndex((h) => [...h.values()].some((n) => print(n) === text));
/** Through JSON, as presence sends it. */
const sent = (data: RefData) => JSON.parse(JSON.stringify(data)) as RefData;

test("a face picked in the final body is found there again", async () => {
  const { final } = await m1();
  const index = faceNamed(final, 'ref["extrude#1"].side.front.piece(ref["extrude#2"], 2)');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(locate(final, sent(pickData(final, "face", index)))).toEqual([index]);
});

test("a face picked before a split names all its pieces after it", async () => {
  const { block, final } = await m1();
  const front = faceNamed(block, 'ref["extrude#1"].side.front');
  const pieces = [1, 2].map((k) => faceNamed(final, `ref["extrude#1"].side.front.piece(ref["extrude#2"], ${k})`));
  expect(locate(final, sent(pickData(block, "face", front))).sort()).toEqual(pieces.sort());
});

test("a piece picked after a split suggests the unsplit face before it", async () => {
  const { block, final } = await m1();
  const piece = faceNamed(final, 'ref["extrude#1"].side.front.piece(ref["extrude#2"], 2)');
  expect(locate(block, sent(pickData(final, "face", piece)))).toEqual([faceNamed(block, 'ref["extrude#1"].side.front')]);
});

test("an edge is found by its reference, and data that isn't a reference names nothing", async () => {
  const { final } = await m1();
  const edge = 3;
  expect(locate(final, sent(pickData(final, "edge", edge)))).toContain(edge);
  expect(locate(final, { kind: "face", names: [{ t: "nonsense" } as never] })).toEqual([]);
});
