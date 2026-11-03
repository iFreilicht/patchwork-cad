/**
 * Model files are plain JS that run with replicad, OCCT and this library alone (research/02,
 * "Design goal: portable models"): no names injected, no editor, strict failures.
 */
import { beforeAll, expect, test } from "vitest";
import { measureVolume } from "replicad";
import { Body, body } from "../src/index.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

test.each([
  ["m1", "block"],
  ["m3", "bracket"],
])("%s runs as a plain module", async (name, output) => {
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => Record<string, Body>; defaultParams: unknown };
  const result = model.default(model.defaultParams);
  expect(Object.keys(result)).toEqual([output]);
  const body = result[output]!;
  expect(body).toBeInstanceOf(Body);
  // Without injected names, features fall back to generated ones; references still resolve.
  expect(body.name).toMatch(/^extrude#\d+$/);
  expect(measureVolume(body.shape as Parameters<typeof measureVolume>[0])).toBeGreaterThan(0);
  expect((body.shape as { mesh(): { triangles: number[] } }).mesh().triangles.length).toBeGreaterThan(0);
});

test("m4 runs as a plain module and returns its bodies", async () => {
  const name = "m4";
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: { w: number; d: number; h: number } };
  const result = model.default(model.defaultParams) as Record<string, Body>;
  // Its outputs are named by their keys, independent of the features that made them.
  expect(Object.entries(result).map(([key, b]) => [key, b.name])).toEqual([
    ["plate", "combine#2"],
    ["lid", "move#2"],
  ]);
  const [notched, lid] = Object.values(result).map((b) => measureVolume(b.shape as Parameters<typeof measureVolume>[0]));
  const { w, d, h } = model.defaultParams;
  // The lid is a copy of the plate; the notched plate has the boss and lacks a corner.
  expect(lid).toBeCloseTo(w * d * h, 3);
  expect(notched).toBeGreaterThan(w * d * h * 0.75);
  expect(notched).toBeLessThan(w * d * h);
});

test("another model's outputs are adopted with body(), by key", async () => {
  const name = "m4";
  const m4 = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => Record<string, Body>; defaultParams: unknown };
  const { plate, lid } = body(() => m4.default(m4.defaultParams), { name: "plate", destructured: { plate: "plate", lid: "lid" }, variable: true });
  expect([plate!.name, lid!.name]).toEqual(["plate", "lid"]);
  expect(measureVolume(lid!.shape as Parameters<typeof measureVolume>[0])).toBeCloseTo(60 * 40 * 8, 3);
});

test("replicad's evaluator shows a model's outputs through Object.entries", async () => {
  const name = "m4";
  const m4 = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => Record<string, Body>; defaultParams: unknown };
  // What research/15 suggests for running a model in replicad's studio: one { name, shape } per output.
  const shapes = Object.entries(m4.default(m4.defaultParams)).map(([name, b]) => ({ name, shape: b.shape }));
  expect(shapes.map((s) => s.name)).toEqual(["plate", "lid"]);
  for (const s of shapes) expect((s.shape as { mesh(): { triangles: number[] } }).mesh().triangles.length).toBeGreaterThan(0);
});
