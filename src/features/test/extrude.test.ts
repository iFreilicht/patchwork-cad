import { beforeAll, expect, test } from "vitest";
import { circle, extrude, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

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
