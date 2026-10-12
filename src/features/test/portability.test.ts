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
