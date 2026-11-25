/** What an editor shows a build's progress with (research/23): each feature as it starts and when it is done, and which features shaped each face. */
import { beforeAll, expect, test } from "vitest";
import { circle, extrude, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, describe, shapers, type TraceEntry } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

test("onFeature reports each feature's start and end, a failed one with its status", () => {
  const events: [string, boolean, TraceEntry["status"]][] = [];
  beginBuild({ lenient: true, onFeature: (entry, done) => events.push([entry.name, done, entry.status]) });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  const extrude1 = extrude({ sketch: sketch1, distance: 5 }, { name: "extrude1" });
  extrude({ sketch: sketch1, distance: 0, operation: "join", target: extrude1 }, { name: "extrude2" });
  expect(events).toEqual([
    ["sketch1", false, "ok"],
    ["sketch1", true, "ok"],
    ["extrude1", false, "ok"],
    ["extrude1", true, "ok"],
    ["extrude2", false, "ok"],
    ["extrude2", true, "failed"],
  ]);
});

test("a strict build reports a failed feature before it throws", () => {
  const done: string[] = [];
  beginBuild({ lenient: false, onFeature: (entry, end) => end && done.push(`${entry.name}:${entry.status}`) });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  expect(() => extrude({ sketch: sketch1, distance: 0 }, { name: "extrude1" })).toThrow();
  expect(done).toEqual(["sketch1:ok", "extrude1:failed"]);
});

test("shapers: a face lists the features that created or changed it, also by only cutting into it", () => {
  beginBuild({ lenient: false });
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) }, { name: "sketch1" });
  const plate = extrude({ sketch: sketch1, distance: 5 }, { name: "plate" });
  const sketch2 = sketch({ plane: plane("XY", 5), profile: circle({ center: [10, 5], radius: 2 }) }, { name: "sketch2" });
  const hole = extrude({ sketch: sketch2, distance: -2, operation: "cut", target: plate }, { name: "hole" });
  const by = shapers(hole);
  const top = hole.topo.faces.findIndex((_, i) => Math.abs(describe(hole.topo.faces[i]!, "face").centroid[2] - 5) < 1e-6);
  const side = hole.topo.faces.findIndex((_, i) => Math.abs(describe(hole.topo.faces[i]!, "face").centroid[1]) < 1e-6);
  // The top keeps its names from the plate, but the cut changed it.
  expect(by["plate"]).toContain(top);
  expect(by["hole"]).toContain(top);
  // The side the cut didn't touch.
  expect(by["plate"]).toContain(side);
  expect(by["hole"]).not.toContain(side);
});
