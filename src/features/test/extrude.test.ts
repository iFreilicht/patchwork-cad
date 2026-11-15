import { beforeAll, expect, test } from "vitest";
import { circle, extrude, plane, rect, sketch } from "../src/index.ts";
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
