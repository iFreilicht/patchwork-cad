/**
 * Reusing features' results across builds (research/24-feature-caching.md). The main check: a
 * build that reuses gives exactly what a build without the cache gives, over research/17's sweep;
 * the others check what a reuse depends on.
 */
import { beforeAll, expect, test } from "vitest";
import { Body, body, circle, defineFeature, edge, extrude, fillet, plane, rect, ref, sketch, Sketch, type Profile } from "../src/index.ts";
import { beginBuild, currentTrace, FeatureCache, type TraceEntry } from "../src/runtime.ts";
import { brep, buildPrint, diff } from "./fingerprint.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

type Model = { default: (p: Record<string, unknown>) => unknown; defaultParams: Record<string, unknown> };

/** Builds `main`, with `cache` if given, as the tool does (lenient), and returns its trace and the bodies it returned. */
function build<T>(main: () => T, cache?: FeatureCache, readOnly = false): { trace: TraceEntry[]; value: T; shown: Body[] } {
  beginBuild({ lenient: true, ...(cache ? { cache, cacheReadOnly: readOnly } : {}) });
  const value = main();
  const values = value instanceof Body ? [value] : value && typeof value === "object" ? Object.values(value) : [];
  return { trace: [...currentTrace()], value, shown: values.filter((v): v is Body => v instanceof Body) };
}

const reused = (trace: TraceEntry[]) => trace.filter((t) => t.cached).map((t) => t.name);
const ran = (trace: TraceEntry[]) => trace.filter((t) => !t.cached).map((t) => t.name);

test("every build of research/17's sweep, in turn with the cache, is the build without it", async () => {
  const FACTORS = [0.25, 0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2, 3];
  const RIBS = [[], [20], [45], [15, 45], [10, 30, 50]];
  const cache = new FeatureCache();
  let builds = 0;
  let calls = 0;
  let hits = 0;
  for (const name of ["m1", "m3", "m4"]) {
    const model = (await import(`../examples/${name}.js`)) as Model;
    const variants: Record<string, unknown>[] = [{}];
    for (const [key, value] of Object.entries(model.defaultParams)) if (typeof value === "number") for (const f of FACTORS) variants.push({ [key]: +(value * f).toFixed(3) });
    if (name === "m3") for (const ribs of RIBS) variants.push({ ribs });
    // Each variant, then back to the defaults, which the cache still has.
    for (const values of [...variants, {}]) {
      const main = () => model.default({ ...model.defaultParams, ...values });
      const cached = build(main, cache);
      const withCache = buildPrint(cached.trace, cached.shown);
      const fresh = build(main);
      expect(diff(withCache, buildPrint(fresh.trace, fresh.shown)), `${name} ${JSON.stringify(values)}`).toEqual([]);
      builds++;
      calls += cached.trace.length;
      hits += reused(cached.trace).length;
    }
  }
  expect(builds).toBe(128);
  // Every variant changes one parameter, which most features of these small parts use.
  expect(hits).toBeGreaterThan(calls / 10);
}, 600_000);

const block = (h: number, r: number, f: number) => () => {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [40, 30] }) }, { name: "sketch1", variable: true });
  const extrude1 = extrude({ sketch: sketch1, distance: h }, { name: "extrude1", variable: true });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [20, 15], radius: r }) }, { name: "sketch2", variable: true });
  const hole = extrude({ sketch: sketch2, operation: "cut", target: extrude1, extent: "through" }, { name: "hole", variable: true });
  const fillet1 = fillet({ body: hole, edges: [edge(extrude1.end, hole.side["c"]!)], radius: f }, { name: "fillet1", variable: true });
  return { part: fillet1 };
};

test("a build reuses the features before an edit and the ones that don't depend on it", () => {
  const cache = new FeatureCache();
  const first = build(block(10, 5, 1), cache);
  expect(reused(first.trace)).toEqual([]);
  const same = build(block(10, 5, 1), cache);
  expect(ran(same.trace)).toEqual([]);
  expect(same.value.part).toBe(first.value.part);
  expect(same.trace.every((t, i) => t.cost === first.trace[i]!.cost)).toBe(true);
  // The fillet's radius: only the fillet runs.
  expect(ran(build(block(10, 5, 1.5), cache).trace)).toEqual(["fillet1"]);
  // The hole's radius: the hole's sketch and everything after it.
  expect(ran(build(block(10, 6, 1.5), cache).trace)).toEqual(["sketch2", "hole", "fillet1"]);
  // The height: the extrusion and what uses it; both sketches are as they were.
  expect(ran(build(block(12, 6, 1.5), cache).trace)).toEqual(["extrude1", "hole", "fillet1"]);
});

test("calls of the same name are told apart by how many came before, e.g. in a loop", () => {
  const cache = new FeatureCache();
  const ribs = (xs: number[]) => () => xs.map((x) => extrude({ sketch: sketch({ plane: plane("XY"), profile: rect({ from: [x, 0], to: [x + 2, 10] }) }, { name: "rib", variable: true }), distance: 5 }, { name: "body", variable: true }));
  const a = build(ribs([0, 10, 20]), cache);
  const b = build(ribs([0, 15, 20]), cache);
  expect(b.trace.map((t) => `${t.name}${t.cached ? "" : " ran"}`)).toEqual(["rib", "body", "rib ran", "body ran", "rib", "body"]);
  expect(b.value[2]).toBe(a.value[2]);
});

test("a reused call printed the same names: a reference's code prints a feature as its variable only where it has one", () => {
  const cache = new FeatureCache();
  const model = (variable: boolean) => () => {
    const s = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [10, 10] }) }, { name: "s", variable: true });
    const box = extrude({ sketch: s, distance: 5 }, { name: "box", variable });
    return fillet({ body: box, edges: [edge(ref["box"]!.end, ref["box"]!.side["front"]!)], radius: 1 }, { name: "f", variable: true });
  };
  build(model(true), cache);
  const other = build(model(false), cache);
  // The box is the same, but the fillet's references print it otherwise.
  expect(ran(other.trace)).toEqual(["f"]);
  expect(other.trace[2]!.refs[0]!.code).toBe(build(model(false)).trace[2]!.refs[0]!.code);
});

test("arguments count as they were when the call ran, also when the model changes them afterwards", () => {
  const cache = new FeatureCache();
  const profile = { kind: "polygon", points: [[0, 0], [10, 0], [10, 10], [0, 10]], ids: ["a", "b", "c", "d"] } as Profile & { points: [number, number][] };
  const model = (width: number) => () => {
    profile.points[1]![0] = width;
    profile.points[2]![0] = width;
    const s = sketch({ plane: plane("XY"), profile }, { name: "s" });
    // A model that changes an argument after the call: the next build calls it with what it had then.
    profile.points[1]![0] = width + 5;
    return s;
  };
  const first = build(model(10), cache);
  const second = build(model(15), cache);
  expect(ran(second.trace)).toEqual(["s"]);
  expect((second.value.profile as { points: number[][] }).points[1]![0]).toBe(15);
  // The sketch kept a copy: the model's change after the call isn't in it.
  expect((first.value.profile as { points: number[][] }).points[1]![0]).toBe(10);
});

test("bodies and sketches are frozen, and a sketch keeps a copy of its profile, so that a reused one is as it was made", () => {
  const profile = rect({ from: [0, 0], to: [10, 10] });
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile });
  const b = extrude({ sketch: s, distance: 3 });
  expect(Object.isFrozen(s) && Object.isFrozen(s.profile) && Object.isFrozen(b)).toBe(true);
  expect(Object.isFrozen(profile)).toBe(false);
  expect(() => ((b as unknown as Record<string, unknown>)["color"] = "red")).toThrow(TypeError);
  // A returned body still spreads into replicad-evaluator's shape config.
  expect({ ...b }).toHaveProperty("shape");
});

test("a body whose replicad shape was read isn't reused, nor what it was made from, as replicad's booleans change their arguments", () => {
  const cache = new FeatureCache();
  const model = (read: boolean) => () => {
    const { part } = block(10, 5, 1)();
    if (read) void part.shape;
    return part;
  };
  build(model(true), cache);
  // The fillet and everything it was made from, which share its faces and edges.
  expect(reused(build(model(false), cache).trace)).toEqual([]);
  expect(ran(build(model(false), cache).trace)).toEqual([]);
});

test("a feature failing with the library's error is reused failing; its pass-through and message are the same", () => {
  const cache = new FeatureCache();
  const model = () => {
    const s = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [10, 10] }) }, { name: "s", variable: true });
    const box = extrude({ sketch: s, distance: 5 }, { name: "box", variable: true });
    return fillet({ body: box, edges: [edge(box.end, box.side["nope"]!)], radius: 1 }, { name: "f", variable: true });
  };
  const a = build(model, cache);
  const b = build(model, cache);
  expect(a.trace[2]!.status).toBe("broken");
  expect(b.trace[2]).toMatchObject({ cached: true, status: "broken", message: a.trace[2]!.message });
  expect(b.value).toBe(b.trace[1]!.result);
});

test("an error other than the library's, which may not come again, isn't kept", () => {
  const cache = new FeatureCache();
  // A frame without an origin makes placing the sketch throw a TypeError.
  const model = () => sketch({ plane: { normal: [0, 0, 1], xDir: [1, 0, 0] } as never, profile: rect({ from: [0, 0], to: [10, 10] }) }, { name: "s" });
  const first = build(model, cache);
  expect(first.trace[0]).toMatchObject({ status: "failed", message: expect.stringMatching(/undefined/) });
  expect(ran(build(model, cache).trace)).toEqual(["s"]);
});

test("a sketch that is the same as before is the earlier one, so that its users are reused (early cutoff)", () => {
  const cache = new FeatureCache();
  const model = (h: number) => () => {
    const base = extrude({ sketch: sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 20] }) }, { name: "s1" }), distance: h }, { name: "base" });
    // A sketch on the base's side, whose plane doesn't depend on the height, and a new body from it.
    const side = sketch({ body: base, plane: base.side["front"]!, profile: circle({ center: [10, 2], radius: 1 }) }, { name: "s2" });
    return extrude({ sketch: side, distance: 3 }, { name: "peg" });
  };
  const a = build(model(5), cache);
  const b = build(model(6), cache);
  expect(ran(b.trace)).toEqual(["base", "s2"]);
  expect(b.value).toBe(a.value);
});

test("a read-only build reuses results but keeps none", () => {
  const cache = new FeatureCache();
  build(block(10, 5, 1), cache);
  const size = cache.size;
  const trial = build(block(10, 5, 2), cache, true);
  expect(ran(trial.trace)).toEqual(["fillet1"]);
  expect(cache.size).toBe(size);
  expect(ran(build(block(10, 5, 1), cache).trace)).toEqual([]);
});

test("results are kept for two builds after their last use: switching back and forth reuses both", () => {
  for (const [generations, again] of [[2, []], [1, ["extrude1", "hole", "fillet1"]]] as const) {
    const cache = new FeatureCache({ generations });
    build(block(10, 5, 1), cache);
    build(block(12, 5, 1), cache);
    expect(ran(build(block(10, 5, 1), cache).trace)).toEqual(again);
  }
});

test("only the library's features are reused: a feature defined elsewhere may depend on anything", () => {
  const cache = new FeatureCache();
  let n = 0;
  const counted = defineFeature<{ body: Body }, Body>({ type: "counted", label: "Counted", icon: "", params: { body: { kind: "body", label: "Body" } as never }, hover: "faces", build: ({ body: b }) => (n++, b) });
  const model = () => counted({ body: extrude({ sketch: sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [5, 5] }) }), distance: 1 }) });
  build(model, cache);
  build(model, cache);
  expect(n).toBe(2);
  // body() of a function runs its code every time; of a body, it is reused.
  const adopted = () => {
    const b = extrude({ sketch: sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [5, 5] }) }), distance: 1 });
    return [body(() => b), body(b)];
  };
  build(adopted, cache);
  expect(build(adopted, cache).trace.map((t) => `${t.type} ${t.cached}`)).toEqual(["sketch true", "extrude true", "body false", "body true"]);
});

test("a reused body is as it was made: later features and the view's meshing leave it unchanged", () => {
  const cache = new FeatureCache();
  const first = build(block(10, 5, 1), cache);
  const made = new Map(first.trace.flatMap((t) => t.results).map((b) => [b, brep(b, true)]));
  build(block(10, 5, 2), cache);
  for (const [b, state] of made) expect(brep(b, true), b.name).toBe(state);
  expect(first.trace.flatMap((t) => (t.sketch ? [t.sketch] : [])).every((s) => s instanceof Sketch && Object.isFrozen(s))).toBe(true);
});
