/** The build hook an editor shows progress with (research/23): each feature as it starts and when it is done. */
import { beforeAll, expect, test } from "vitest";
import { extrude, plane, rect, sketch } from "../src/index.ts";
import { beginBuild, type TraceEntry } from "../src/runtime.ts";
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
