/** move: a translated copy of a body whose faces and edges are named by the copy and their names in the original. */
import { measureVolume, type Shape3D } from "replicad";
import { beforeAll, expect, test } from "vitest";
import { Body, chamfer, combine, edge, extrude, fillet, move, Named, plane, rect, ref, sketch } from "../src/index.ts";
import { beginBuild, changedVolume, currentTrace, describe, owners, pick, pickCode } from "../src/runtime.ts";
import { RESERVED } from "../src/names.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const volume = (b: Body) => measureVolume(b.shape as Shape3D);
const centroid = (b: Body) => describe(b.topo.faces[0]!, "face").centroid;
/** A copied feature through a body's own property, as model code writes it: `move1.extrude1`. */
const prop = (b: Named, feature: string) => (b as unknown as Record<string, Named>)[feature]!;

const block = (name = "extrude1") => {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  return extrude({ sketch: sketch1, distance: 5 }, { name });
};
const topIndex = (b: Body) => b.topo.faces.findIndex((f) => describe(f, "face").centroid[2] === 5);
const top = (b: Body) => String(pick(b, "face", topIndex(b)));

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

test("the copy's faces and edges are named by the copy, and references into it resolve there only", () => {
  beginBuild({ lenient: true });
  const extrude1 = block();
  const move1 = move({ body: extrude1, y: 20 }, { name: "move1" });
  expect(top(extrude1)).toBe("ref.extrude1.end");
  expect(top(move1)).toBe("ref.move1.extrude1.end");
  const front = String(pick(move1, "edge", move1.topo.edgeFaces.findIndex((f) => f.includes(topIndex(move1)))));
  expect(front).toMatch(/^edge\(ref\.move1\.extrude1\.(end|side\.\w+), ref\.move1\.extrude1\.(end|side\.\w+)\)$/);
  // As model code writes them, through the copy's variable: the original isn't named.
  expect(String(prop(move1, "extrude1").end)).toBe("ref.move1.extrude1.end");
  expect(String(move1.of("extrude1").end)).toBe("ref.move1.extrude1.end");
  const fillet1 = fillet({ body: move1, edges: [edge(prop(move1, "extrude1").end, prop(move1, "extrude1").side["front"]!)], radius: 1 }, { name: "fillet1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "fillet1", status: "ok" });
  expect(volume(fillet1)).toBeLessThan(volume(move1));
  // The original's names aren't the copy's.
  fillet({ body: move1, edges: [edge(extrude1.end, extrude1.side["front"]!)], radius: 1 }, { name: "fillet2" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "fillet2", status: "broken" });
});

test("copies of one body differ, a copy of a copy nests, and a copy's faces are the copy's own", () => {
  beginBuild({ lenient: false });
  const extrude1 = block();
  const move1 = move({ body: extrude1, y: 20 }, { name: "move1" });
  const move2 = move({ body: extrude1, y: 40 }, { name: "move2" });
  const move3 = move({ body: move1, x: 40 }, { name: "move3" });
  expect([top(move1), top(move2), top(move3)]).toEqual(["ref.move1.extrude1.end", "ref.move2.extrude1.end", "ref.move3.move1.extrude1.end"]);
  expect(String(prop(prop(move3, "move1"), "extrude1").end)).toBe("ref.move3.move1.extrude1.end");
  chamfer({ body: move3, edges: [edge(prop(prop(move3, "move1"), "extrude1").end, prop(prop(move3, "move1"), "extrude1").side["front"]!)], distance: 1 }, { name: "chamfer1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "chamfer1", status: "ok" });
  // Hovering the extrusion highlights the original only; the copy's faces are the move's.
  expect(Object.keys(owners(extrude1))).toEqual(["extrude1"]);
  expect(Object.keys(owners(move1))).toEqual(["move1"]);
  expect(Object.keys(owners(move3))).toEqual(["move3"]);
});

test("a copy merged with its original keeps both apart", () => {
  beginBuild({ lenient: false });
  const extrude1 = block();
  const move1 = move({ body: extrude1, x: 10 }, { name: "move1" });
  const joined = combine({ target: extrude1, tools: [move1] }, { name: "joined" });
  const tops = joined.topo.faces.flatMap((_, i) => (describe(joined.topo.faces[i]!, "face").centroid[2] === 5 ? [String(pick(joined, "face", i))] : []));
  // The merged top is named by both: one through the original, one through the copy.
  expect(tops.join(" ")).toContain("ref.extrude1.end");
  expect(tops.join(" ")).toContain("ref.move1.extrude1.end");
});

test("a copied feature whose name is a body's own property is reached through of()", () => {
  beginBuild({ lenient: false });
  const end = block("end");
  const move1 = move({ body: end, y: 20 }, { name: "move1" });
  expect(top(move1)).toBe('ref.move1.of("end").end');
  // A feature name that isn't an identifier, too.
  const odd = move({ body: block("extrude@L3#1"), y: 40 }, { name: "move2" });
  expect(top(odd)).toBe('ref.move2.of("extrude@L3#1").end');
  expect(String(ref["move1"]!.of("end").end)).toBe('ref.move1.of("end").end');
  // With the copy's variable, as the editor writes picks.
  expect(pickCode(move1, "face", topIndex(move1), currentTrace().map((t) => ({ ...t, variable: true })))).toBe('move1.of("end").end');
});

test("a body's copied features don't get in the way of its own properties", async () => {
  beginBuild({ lenient: false });
  const move1 = move({ body: block(), y: 20 }, { name: "move1" });
  // Not a thenable, nothing to spread, nothing that `in` finds.
  expect(await Promise.resolve(move1)).toBe(move1);
  expect(Object.keys({ ...move1 })).not.toContain("extrude1");
  expect("extrude1" in move1).toBe(false);
  expect(move1).toBeInstanceOf(Body);
  // Every property of a body is reserved, so that a copied feature of its name is printed through of().
  const props = new Set<string>(Reflect.ownKeys(move1).filter((k): k is string => typeof k === "string"));
  for (let p: object | null = Object.getPrototypeOf(move1); p; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) props.add(k);
  expect([...props].filter((p) => !RESERVED.has(p))).toEqual([]);
});

test("a failed copy fails alone; references into it fail with the features that use them", () => {
  beginBuild({ lenient: true });
  const move1 = move({ body: block(), x: NaN }, { name: "move1" });
  chamfer({ body: move1, edges: [edge(prop(move1, "extrude1").end, prop(move1, "extrude1").side["front"]!)], distance: 1 }, { name: "chamfer1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "chamfer1", status: "broken" });
});

test.each([NaN, Infinity])("a move by %d fails alone", (x) => {
  beginBuild({ lenient: true });
  const move1 = move({ body: block(), x }, { name: "move1" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "move1", status: "failed", message: `x: expected a finite length, got ${x}` });
  expect(move1.topo.faces).toHaveLength(0);
});
