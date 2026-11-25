import { beforeAll, expect, test } from "vitest";
import { circle, extrude, plane, polygon, rect, sketch } from "../src/index.ts";
import { describe } from "../src/geom.ts";
import { beginBuild, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";
import { oc } from "../src/oc.ts";

beforeAll(loadOC);

// A cut through a zero-height plate never returned from OCCT and hung the kernel worker.
test.each([0, -0, 1e-9, Infinity, NaN])("an extrusion by %d fails alone, and a cut into it doesn't hang", (distance) => {
  beginBuild({ lenient: true });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance }, { name: "plate" });
  expect(currentTrace().at(-1)).toMatchObject({ name: "plate", status: "failed", message: `distance: expected a finite length other than 0, got ${distance}` });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [30, 20], radius: 4 }) });
  const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" }, { name: "bore" });
  expect(bore.topo.faces).toHaveLength(0);
});

test("the distance runs along the sketch's normal, whatever the operation: into a body is negative", () => {
  beginBuild({ lenient: true });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const plate = extrude({ sketch: sketch1, distance: 5 }, { name: "plate", variable: true });
  const sketch2 = sketch({ plane: plate.end, body: plate, profile: rect({ from: [5, 2], to: [15, 8] }) });
  const volume = (b: { topo: { shape: unknown } }) => {
    const o = oc();
    const g = new o.GProp_GProps();
    o.BRepGProp.VolumeProperties(b.topo.shape as never, g, false, false, false);
    return g.Mass();
  };
  expect(volume(extrude({ sketch: sketch2, distance: 2, operation: "join", target: plate }))).toBeCloseTo(1000 + 120);
  expect(volume(extrude({ sketch: sketch2, distance: -2, operation: "cut", target: plate }))).toBeCloseTo(1000 - 120);
  // Away from the plate, a cut takes nothing away.
  expect(volume(extrude({ sketch: sketch2, distance: 2, operation: "cut", target: plate }))).toBeCloseTo(1000);
  expect(currentTrace().every((t) => t.status === "ok")).toBe(true);
});

// OCCT appends the pieces that unifying same-domain faces rebuilt in the order of a map hashed by
// address, so `piece(hole, 1)` named another face after the heap changed (research/03, kernel findings).
test("piece indices are the same in every build, also of pieces that unifying faces rebuilt", () => {
  // A U whose sides are two coplanar faces each, meeting at the hole's height: unifying them merges the hole's rims.
  const build = () => {
    beginBuild({ lenient: false });
    const profile = polygon({ a: [0, 0], b: [50, 0], b2: [50, 25], c: [50, 40], d: [40, 40], d2: [40, 25], e: [40, 10], f: [10, 10], f2: [10, 25], g: [10, 40], h: [0, 40], h2: [0, 25] });
    const u = extrude({ sketch: sketch({ plane: plane("XY"), profile }), distance: 10 }, { name: "u" });
    const hole = extrude({ sketch: sketch({ plane: plane("YZ"), profile: circle({ center: [25, 5], radius: 3 }) }), operation: "cut", target: u, extent: "through" }, { name: "hole" });
    const piece = hole.topo.faceHist.findIndex((h) => h.has("ref.hole.side.c.piece(ref.hole, 1)"));
    return describe(hole.topo.faces[piece]!, "face").centroid[0];
  };
  const first = build();
  for (let i = 0; i < 10; i++) {
    // Shapes kept alive in between, so that the next build's shapes are elsewhere in the heap.
    const kept = Array.from({ length: 100 * (i + 1) }, (_, j) => new (oc().BRepPrimAPI_MakeBox)(1 + j, 2, 3).Shape());
    expect(build()).toBeCloseTo(first, 6);
    kept.forEach((s) => s.delete());
  }
});
