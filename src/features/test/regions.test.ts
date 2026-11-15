import { beforeAll, expect, test } from "vitest";
import { extrude, plane, polygon, rect, sketch, type Fill, type Path, type Profile } from "../src/index.ts";
import { beginBuild, currentTrace, pickRegion } from "../src/runtime.ts";
import { oc } from "../src/oc.ts";
import type { Body } from "../src/feature.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

/** A closed polygonal path with segments `<id>.1`, `<id>.2`, … */
const loop = (id: string, points: [number, number][], closed = true): Path => ({
  id,
  start: points[0]!,
  closed,
  segments: (closed ? points : points.slice(1)).map((_, i) => ({ id: `${id}.${i + 1}`, curve: { kind: "line" as const, to: closed ? points[(i + 1) % points.length]! : points[i + 1]! } })),
});
const box = (id: string, x0: number, y0: number, x1: number, y1: number) =>
  loop(id, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
const paths = (list: Path[], fills: Fill[] = list.filter((p) => p.closed).map((p) => ({ loops: [p.id], rule: "nonzero" as const }))): Profile => ({ kind: "paths", paths: list, fills, warnings: [] });

const volume = (b: Body) => {
  const o = oc();
  const g = new o.GProp_GProps();
  o.BRepGProp.VolumeProperties(b.topo.shape, g, false, false, false);
  return g.Mass();
};
const names = (b: Body) => b.topo.faceHist.map((h) => [...h.keys()].join(" | ")).sort();
const last = () => currentTrace().at(-1)!;

test("overlapping rectangles enclose three regions, named by the loops they lie inside", () => {
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: paths([box("a", 0, 0, 10, 10), box("b", 5, 5, 15, 15)]) }, { name: "s", variable: true });
  expect(s.regions.map((r) => `${r.loops.join("+")}: ${Math.round(r.area)}`).sort()).toEqual(["a+b: 25", "a: 75", "b: 75"]);
  expect(s.regions.map((_, i) => String(pickRegion(s, i))).sort()).toEqual(['s.region("a")', 's.region("a", "b")', 's.region("b")']);
  // Each alone, and several joined: a and its overlap are rectangle a again.
  expect(volume(extrude({ sketch: s, regions: [s.region("a", "b")], distance: 2 }))).toBeCloseTo(50);
  expect(volume(extrude({ sketch: s, regions: s.region("b"), distance: 2 }))).toBeCloseTo(150);
  const joined = extrude({ sketch: s, regions: [s.region("a"), s.region("b", "a")], distance: 2 }, { name: "e" });
  expect(volume(joined)).toBeCloseTo(200);
  expect(joined.topo.faces).toHaveLength(6);
  // Rectangle a's sides, whole again; b's left and bottom sides inside it are gone.
  expect(names(joined)).toEqual(['ref.e.end', 'ref.e.side["a.1"]', 'ref.e.side["a.2"]', 'ref.e.side["a.3"]', 'ref.e.side["a.4"]', "ref.e.start"]);
  expect(volume(extrude({ sketch: s, regions: [s.region("a"), s.region("a", "b"), s.region("b")], distance: 2 }))).toBeCloseTo(350);
  expect(currentTrace().every((t) => t.status === "ok")).toBe(true);
});

test("one sketch with several profiles needs them chosen; one with a single profile doesn't", () => {
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: paths([box("a", 0, 0, 10, 10), box("b", 5, 5, 15, 15)]) }, { name: "s", variable: true });
  extrude({ sketch: s });
  expect(last()).toMatchObject({ status: "failed", message: "s has 3 profiles: select which to use" });
  extrude({ sketch: s, regions: [] });
  expect(last()).toMatchObject({ status: "failed", message: "regions: select at least one profile" });
  const r = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [4, 5] }) });
  expect(volume(extrude({ sketch: r, distance: 1 }))).toBeCloseTo(20);
});

test("a region that is missing or ambiguous is a broken reference with a suggestion", () => {
  beginBuild({ lenient: true });
  // A line across the rectangle splits it into two regions, both inside r alone.
  const s = sketch({ plane: plane("XY"), profile: paths([box("r", 0, 0, 10, 10), loop("cut", [[-5, 5], [15, 5]], false)]) }, { name: "s", variable: true });
  expect(s.regions).toHaveLength(2);
  extrude({ sketch: s, regions: [s.region("r")] });
  expect(last()).toMatchObject({ status: "broken", refs: [{ kind: "region", status: "ambiguous", matches: [0, 1], suggestion: expect.stringMatching(/^s\.region\("r", \{ near: \[.*\] \}\), s\.region\("r", \{ near: \[.*\] \}\)$/) }] });
  const top = extrude({ sketch: s, regions: [s.region("r", { near: [3, 8] })], distance: 1 }, { name: "top" });
  expect(volume(top)).toBeCloseTo(50);
  expect(names(top)).toEqual(["ref.top.end", 'ref.top.side["cut.1"]', 'ref.top.side["r.2"]', 'ref.top.side["r.3"]', 'ref.top.side["r.4"]', "ref.top.start"]);
  // A point names the nearest of them, also outside both.
  expect(volume(extrude({ sketch: s, regions: [s.region("r", { near: [3, -40] })], distance: 1 }))).toBeCloseTo(50);
  extrude({ sketch: s, regions: [s.region("q", { near: [3, 8] })] });
  expect(last()).toMatchObject({ status: "broken", refs: [{ status: "missing", message: 's.region("q", { near: [3, 8] }): no profile lies inside "q" alone', suggestion: expect.stringMatching(/^s\.region\("r", \{ near/) }] });
  const other = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [1, 1] }) }, { name: "other", variable: true });
  extrude({ sketch: s, regions: [other.region("polygon")] });
  expect(last()).toMatchObject({ status: "broken", message: 'regions: other.region("polygon") is a profile of other, not of s' });
  extrude({ sketch: s, regions: ["r"] as never });
  expect(last()).toMatchObject({ status: "broken", message: "regions: r is not a profile of a sketch" });
});

test("open paths enclose nothing alone, and are never closed", () => {
  beginBuild({ lenient: true });
  const open = sketch({ plane: plane("XY"), profile: paths([loop("u", [[0, 0], [10, 0], [10, 10], [0, 10]], false)]) }, { name: "open", variable: true });
  expect(open.regions).toHaveLength(0);
  extrude({ sketch: open });
  expect(last()).toMatchObject({ status: "failed", message: "open encloses no profile: none of its curves close" });
  // A dangling line inside a rectangle splits nothing; open paths that meet end to end enclose a region outside every loop.
  const dangling = sketch({ plane: plane("XY"), profile: paths([box("r", 0, 0, 10, 10), loop("d", [[2, 2], [5, 5]], false)]) });
  expect(dangling.regions.map((r) => r.loops)).toEqual([["r"]]);
  const lines = sketch({ plane: plane("XY"), profile: paths([loop("l1", [[0, 0], [10, 0], [10, 10]], false), loop("l2", [[10, 10], [0, 10], [0, 0]], false)]) }, { name: "lines", variable: true });
  expect(lines.regions.map((r) => r.loops)).toEqual([[]]);
  expect(String(pickRegion(lines, 0))).toBe("lines.region()");
  expect(volume(extrude({ sketch: lines, regions: lines.region(), distance: 1 }))).toBeCloseTo(100);
});

test("a hole is a region of its own, and fill rules decide what is filled", () => {
  beginBuild({ lenient: true });
  const outer = box("o", 0, 0, 10, 10);
  const inner = box("i", 2, 2, 8, 8);
  const evenodd = sketch({ plane: plane("XY"), profile: paths([outer, inner], [{ loops: ["o", "i"], rule: "evenodd" }]) }, { name: "evenodd", variable: true });
  expect(evenodd.regions.map((r) => `${r.loops.join("+")}: ${r.filled}, ${Math.round(r.area)}`).sort()).toEqual(["i+o: false, 36", "o: true, 64"]);
  const ring = extrude({ sketch: evenodd, regions: evenodd.filled, distance: 1 });
  expect(volume(ring)).toBeCloseTo(64);
  expect(ring.topo.faces).toHaveLength(10);
  expect(volume(extrude({ sketch: evenodd, regions: [evenodd.region("o"), evenodd.region("o", "i")], distance: 1 }))).toBeCloseTo(100);
  // Nonzero: both loops run the same way, so the hole is filled too.
  const nonzero = sketch({ plane: plane("XY"), profile: paths([outer, inner], [{ loops: ["o", "i"], rule: "nonzero" }]) });
  expect(nonzero.regions.every((r) => r.filled)).toBe(true);
  const none = sketch({ plane: plane("XY"), profile: paths([outer], []) }, { name: "none", variable: true });
  extrude({ sketch: none, regions: none.filled });
  expect(last()).toMatchObject({ status: "broken", message: "none.filled: nothing in the sketch is filled" });
});

test("a self-intersecting polygon encloses a region per lobe", () => {
  beginBuild({ lenient: true });
  const bowtie = sketch({ plane: plane("XY"), profile: polygon({ a: [0, 0], b: [10, 10], c: [10, 0], d: [0, 10] }) }, { name: "bowtie", variable: true });
  expect(bowtie.regions.map((r) => Math.round(r.area))).toEqual([25, 25]);
  const both = extrude({ sketch: bowtie, regions: bowtie.filled, distance: 1 }, { name: "both" });
  expect(volume(both)).toBeCloseTo(50);
  // Two solids: each cap is a piece, as are the pieces of the segments that cross.
  expect(names(both).filter((n) => /start|end/.test(n))).toEqual(["ref.both.end.piece(ref.both, 1)", "ref.both.end.piece(ref.both, 2)", "ref.both.start.piece(ref.both, 1)", "ref.both.start.piece(ref.both, 2)"]);
  expect(names(both).filter((n) => n.includes("side.a")).length).toBe(2);
});

test("curves: arcs, ellipses and Bézier curves enclose their exact areas", () => {
  beginBuild({ lenient: true });
  const disc: Path = { id: "c", start: [5, 0], closed: true, segments: [{ id: "c.1", curve: { kind: "arc", center: [0, 0], u: [5, 0], v: [0, 5], from: 0, to: 2 * Math.PI } }] };
  // An ellipse turned by 30°, given by conjugate radii that aren't its axes, drawn clockwise.
  const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const a: [number, number] = [4 * c, 4 * s];
  const b: [number, number] = [-2 * s, 2 * c];
  const u: [number, number] = [a[0] + b[0], a[1] + b[1]];
  const v: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const ellipse: Path = { id: "e", start: [20 + u[0] / Math.SQRT2, u[1] / Math.SQRT2], closed: true, segments: [{ id: "e.1", curve: { kind: "arc", center: [20, 0], u: [u[0] / Math.SQRT2, u[1] / Math.SQRT2], v: [v[0] / Math.SQRT2, v[1] / Math.SQRT2], from: 0, to: -2 * Math.PI } }] };
  // Half a disc: an arc and its chord.
  const half: Path = { id: "h", start: [45, 0], closed: true, segments: [{ id: "h.1", curve: { kind: "arc", center: [40, 0], u: [5, 0], v: [0, 5], from: 0, to: Math.PI } }, { id: "h.2", curve: { kind: "line", to: [45, 0] } }] };
  // A cubic Bézier and its chord: the area between them is 3/5 of their hull's for this symmetric one.
  const bez: Path = { id: "z", start: [60, 0], closed: true, segments: [{ id: "z.1", curve: { kind: "bezier", controls: [[60, 10], [70, 10]], to: [70, 0] } }, { id: "z.2", curve: { kind: "line", to: [60, 0] } }] };
  const sk = sketch({ plane: plane("XY"), profile: paths([disc, ellipse, half, bez]) }, { name: "sk", variable: true });
  const area = (loop: string) => sk.regions.find((r) => r.loops.join() === loop)!.area;
  expect(area("c")).toBeCloseTo(25 * Math.PI, 6);
  expect(area("e")).toBeCloseTo(8 * Math.PI, 6);
  expect(area("h")).toBeCloseTo(12.5 * Math.PI, 6);
  expect(area("z")).toBeCloseTo(60, 6);
  expect(volume(extrude({ sketch: sk, regions: sk.region("c"), distance: 2 }))).toBeCloseTo(50 * Math.PI, 4);
});

test("several extrusions use one sketch", () => {
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: paths([box("a", 0, 0, 10, 10), box("b", 5, 5, 15, 15)]) }, { name: "s", variable: true });
  const first = extrude({ sketch: s, regions: [s.region("a")], distance: 1 }, { name: "first" });
  const second = extrude({ sketch: s, regions: [s.region("b")], distance: 3 }, { name: "second" });
  const both = extrude({ sketch: s, regions: [s.region("a")], distance: 2, operation: "join", target: second }, { name: "both" });
  expect([volume(first), volume(second), volume(both)].map(Math.round)).toEqual([75, 225, 375]);
  expect(currentTrace().map((t) => t.status)).toEqual(["ok", "ok", "ok", "ok"]);
});
