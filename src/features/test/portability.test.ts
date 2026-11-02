/**
 * Model files are plain JS that run with replicad, OCCT and this library alone (research/02,
 * "Design goal: portable models"): no names injected, no editor, strict failures.
 */
import { beforeAll, expect, test } from "vitest";
import { measureVolume } from "replicad";
import { Body } from "../src/index.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

test.each(["m1", "m3"])("%s runs as a plain module", async (name) => {
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: unknown };
  const result = model.default(model.defaultParams);
  expect(result).toBeInstanceOf(Body);
  const body = result as Body;
  // Without injected names, features fall back to generated ones; references still resolve.
  expect(body.name).toMatch(/^extrude#\d+$/);
  expect(measureVolume(body.shape as Parameters<typeof measureVolume>[0])).toBeGreaterThan(0);
  expect((body.shape as { mesh(): { triangles: number[] } }).mesh().triangles.length).toBeGreaterThan(0);
});

test("m4 runs as a plain module and returns its bodies", async () => {
  const name = "m4";
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: { w: number; d: number; h: number } };
  const result = model.default(model.defaultParams) as Body[];
  expect(result.map((b) => b.name)).toEqual(["combine#2", "move#2"]);
  const [notched, lid] = result.map((b) => measureVolume(b.shape as Parameters<typeof measureVolume>[0]));
  const { w, d, h } = model.defaultParams;
  // The lid is a copy of the plate; the notched plate has the boss and lacks a corner.
  expect(lid).toBeCloseTo(w * d * h, 3);
  expect(notched).toBeGreaterThan(w * d * h * 0.75);
  expect(notched).toBeLessThan(w * d * h);
});
