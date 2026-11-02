/** move: a translated copy of a body whose faces and edges keep their names. */
import { measureVolume, type Shape3D } from "replicad";
import { beforeAll, expect, test } from "vitest";
import { Body, edge, extrude, fillet, move, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, changedVolume, currentTrace, describe, pick } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const volume = (b: Body) => measureVolume(b.shape as Shape3D);
const centroid = (b: Body) => describe(b.topo.faces[0]!, "face").centroid;

const block = () => {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  return extrude({ sketch: sketch1, distance: 5 }, { name: "extrude1" });
};

test("a move copies its body, translated, and leaves the original a body of its own", () => {
  beginBuild({ lenient: false });
  const extrude1 = block();
  const move1 = move({ body: extrude1, x: 30, y: -5, z: 2 }, { name: "move1" });
  expect(volume(move1)).toBeCloseTo(volume(extrude1), 6);
  const [a, b] = [centroid(extrude1), centroid(move1)];
  expect([b[0] - a[0], b[1] - a[1], b[2] - a[2]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([30, -5, 2]);
  const entry = currentTrace().at(-1)!;
  expect(entry).toMatchObject({ type: "move", name: "move1", status: "ok" });
  expect(entry.after).toEqual([extrude1, move1]);
  // Hovering it shows the whole copy.
  expect(changedVolume(entry).reduce((sum, s) => sum + measureVolume(s as Shape3D), 0)).toBeCloseTo(20 * 10 * 5, 6);
});

test("references into the copy use the original's names", () => {
  beginBuild({ lenient: false });
  const extrude1 = block();
  const move1 = move({ body: extrude1, y: 20 }, { name: "move1" });
  const top = extrude1.topo.faces.findIndex((f) => describe(f, "face").centroid[2] === 5);
  expect(String(pick(move1, "face", top))).toBe(String(pick(extrude1, "face", top)));
  const filleted = fillet({ body: move1, edges: [edge(extrude1.end, extrude1.side["front"]!)], radius: 1 }, { name: "fillet1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "fillet1", status: "ok" });
  expect(volume(filleted)).toBeLessThan(volume(move1));
});

test.each([NaN, Infinity])("a move by %d fails alone", (x) => {
  beginBuild({ lenient: true });
  const move1 = move({ body: block(), x }, { name: "move1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "move1", status: "failed", message: `x: expected a finite length, got ${x}` });
  expect(move1.topo.faces).toHaveLength(0);
});
