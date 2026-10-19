// The volume a feature added or removed, which editors show when hovering a feature whose schema
// says `hover: "difference"` (research/12); in M1 (a 60 × 40 × 20 block).
import { beforeAll, expect, test } from "vitest";
import { measureVolume, type Shape3D } from "replicad";
import { schemas } from "../src/schema.ts";
import { beginBuild, changedVolume, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

async function m1() {
  const name = "m1";
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: unknown };
  beginBuild({ lenient: false });
  model.default(model.defaultParams);
  const trace = currentTrace();
  return (feature: string) => changedVolume(trace.find((t) => t.name === feature)!).reduce((sum, s) => sum + measureVolume(s as Shape3D), 0);
}

test("a cut's volume is what it removed, a join's what it added, a new body all of it", async () => {
  const volume = await m1();
  // Without the editor's preparation, features are named by type and count: extrude#1 is the block, extrude#2 the notch, extrude#3 the boss.
  // Half of the notch's r = 8 cylinder is in the block, through its height.
  expect(volume("extrude#2")).toBeCloseTo((Math.PI * 64 * 20) / 2, 0);
  // The boss: r = 2, 4 long.
  expect(volume("extrude#3")).toBeCloseTo(Math.PI * 4 * 4, 1);
  expect(volume("extrude#1")).toBeCloseTo(60 * 40 * 20, 0);
});

test("every feature chooses what hovering it shows", () => {
  expect(Object.fromEntries(Object.entries(schemas).map(([type, s]) => [type, s.hover]))).toEqual({ sketch: "faces", extrude: "difference", fillet: "faces", chamfer: "faces", body: "faces" });
});
