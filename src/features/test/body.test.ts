/**
 * Adopting replicad shapes with body() (research/11): bodies with geometric face names that
 * features can use, in strict (plain module) and lenient (editor) builds.
 */
import { drawCircle, drawRoundedRectangle, measureVolume, type Shape3D } from "replicad";
import { beforeAll, expect, test } from "vitest";
import { body, Body, edge, extrude, fillet, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, currentTrace, describe, owners, pick } from "../src/runtime.ts";
import type { Vec } from "../src/geom.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const plate = (width: number) => {
  const p = drawRoundedRectangle(width, 40, 6).sketchOnPlane().extrude(12) as Shape3D;
  const bore = drawCircle(15).sketchOnPlane().extrude(12) as Shape3D;
  return p.cut(bore);
};
const volume = (b: Body) => measureVolume(b.shape as Parameters<typeof measureVolume>[0]);

/** The index of the face of `b` whose centroid is nearest to `to`. */
const faceNear = (b: Body, to: Vec) => {
  const d = (i: number) => {
    const c = describe(b.topo.faces[i]!, "face").centroid;
    return Math.hypot(c[0] - to[0], c[1] - to[1], c[2] - to[2]);
  };
  return b.topo.faces.map((_, i) => i).reduce((a, i) => (d(i) < d(a) ? i : a));
};

test("a closure's shape becomes a body whose faces are named by their centroids", () => {
  beginBuild({ lenient: false });
  const cut_plate = body(() => plate(100), { name: "cut_plate", variable: true });
  expect(cut_plate).toBeInstanceOf(Body);
  expect(cut_plate.name).toBe("cut_plate");
  expect(String(pick(cut_plate, "face", faceNear(cut_plate, [0, 0, 12])))).toMatch(/^cut_plate\.faceAt\(\[.*, 12\]\)$/);
  // Edges are named by their adjacent faces.
  expect(String(pick(cut_plate, "edge", 0))).toMatch(/^edge\(cut_plate\.faceAt\(.*\), cut_plate\.faceAt\(.*\)\)$/);
  const [entry] = currentTrace();
  expect(entry).toMatchObject({ type: "body", name: "cut_plate", status: "ok" });
  expect(entry!.after).toEqual([cut_plate]);
});

test("a join onto an adopted body, and a fillet by its face names, also after its code changed", () => {
  const build = (width: number, top: string, front: string) => {
    beginBuild({ lenient: false });
    const cut_plate = body(() => plate(width), { name: "cut_plate", variable: true });
    const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
    const extrude1 = extrude({ sketch: sketch1, distance: 20, operation: "join", target: cut_plate }, { name: "extrude1" });
    const ref = eval(`edge(${top}, ${front})`) as ReturnType<typeof edge>;
    return { cut_plate, extrude1, filleted: fillet({ body: extrude1, edges: [ref], radius: 1 }, { name: "fillet1" }) };
  };
  // Pick the top and front faces of the 100 mm plate.
  beginBuild({ lenient: false });
  const picked = body(() => plate(100), { name: "cut_plate", variable: true });
  const top = String(pick(picked, "face", faceNear(picked, [0, 0, 12])));
  const front = String(pick(picked, "face", faceNear(picked, [0, -20, 6])));
  (globalThis as Record<string, unknown>)["cut_plate"] = picked;
  (globalThis as Record<string, unknown>)["edge"] = edge;
  const first = build(100, top, front);
  expect(volume(first.extrude1)).toBeGreaterThan(volume(first.cut_plate));
  expect(volume(first.filleted)).toBeLessThan(volume(first.extrude1));
  // A wider plate moves the faces' centroids; each is still clearly the nearest, so the fillet still resolves.
  const wider = build(104, top, front);
  expect(volume(wider.filleted)).toBeLessThan(volume(wider.extrude1));
  expect(currentTrace().find((t) => t.name === "fillet1")!.status).toBe("ok");
});

test("an array becomes several bodies, named by the declared variables", () => {
  beginBuild({ lenient: false });
  const [left, right] = body(() => [plate(100).translate(-60, 0, 0), plate(100).translate(60, 0, 0)], { name: "left", names: ["left", "right"], variable: true });
  expect([left!.name, right!.name]).toEqual(["left", "right"]);
  const [entry] = currentTrace();
  expect(entry!.results).toEqual([left, right]);
  expect(entry!.after).toEqual([left, right]);
  // Each body owns its faces under its own name, which the editor highlights an entry's bodies by (research/12).
  expect(Object.keys(owners(left!))).toEqual(["left"]);
  expect(owners(right!)["right"]!.faces).toHaveLength(right!.topo.faces.length);
  // A bare shape and a library body are adopted as well; a body loses its history.
  const bare = body(plate(80), { name: "bare" });
  const again = body(bare, { name: "again" });
  expect(String(pick(again, "face", 0))).toMatch(/^ref\.again\.faceAt/);
});

test("a replicad shape where a body is expected says to wrap it", () => {
  beginBuild({ lenient: false });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  expect(() => extrude({ sketch: sketch1, operation: "join", target: plate(100) as unknown as Body })).toThrow("target: a replicad shape, not a feature body; wrap it with body(…)");
  // In the editor's lenient builds, the join fails alone and gives an empty body.
  beginBuild({ lenient: true });
  const sketch2 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const joined = extrude({ sketch: sketch2, operation: "join", target: plate(100) as unknown as Body }, { name: "extrude1" });
  expect(joined.topo.faces).toHaveLength(0);
  expect(currentTrace().at(-1)).toMatchObject({ name: "extrude1", status: "failed", message: "target: a replicad shape, not a feature body; wrap it with body(…)" });
});

test("a failing closure fails its entry alone in a lenient build", () => {
  beginBuild({ lenient: false });
  expect(() => body(() => { throw new Error("boom"); })).toThrow("boom");
  beginBuild({ lenient: true });
  const [a, b] = body((): Shape3D[] => { throw new Error("boom"); }, { name: "a", names: ["a", "b"] });
  expect([a!.topo.faces.length, b!.topo.faces.length, a!.name, b!.name]).toEqual([0, 0, "a", "b"]);
  expect(currentTrace()[0]).toMatchObject({ status: "failed", message: "boom" });
  // Its users fail as broken, and the build goes on.
  const f = fillet({ body: a!, edges: [], radius: 1 }, { name: "fillet1" });
  expect(f).toBe(a);
  expect(currentTrace()[1]).toMatchObject({ name: "fillet1", status: "failed" });
  // Destructuring one shape is reported.
  expect(() => (beginBuild({ lenient: false }), body(() => plate(100), { names: ["x", "y"] }))).toThrow("2 bodies are declared, but it made one shape");
});
