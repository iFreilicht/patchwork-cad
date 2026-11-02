/** What the pointer is on in the lanes beneath the timeline (research/15, "The timeline with lanes"). */
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { graph } from "../src/model/deps.ts";
import { lanes } from "../src/model/lanes.ts";
import { timeline } from "../src/model/timeline.ts";
import { laneTargetAt, y, type Columns } from "../src/components/editor/laneGeometry.ts";

const SKETCH = `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`;
const source = `import { sketch, plane, rect, extrude, fillet } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = ${SKETCH};
  const plate = extrude({ sketch: sketch1, distance: 5 });
  const sketch2 = ${SKETCH};
  const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" });
  const fillet1 = fillet({ body: bore, edges: [], radius: 1 });
  return [plate, fillet1];
}
`;
const a = analyze(source);
const tl = timeline(source, a, []);
// bore (sketch1 plate bore fillet1), row 0, returned; plate, a body of its own, on lane 2 in row 1; sketch2, row 2, merged into bore.
const l = lanes(tl, graph(a, tl));
const c: Columns = { xs: [0, 100, 200, 300, 400], returnX: 500, markerX: 510, pastX: 1000, width: 1000 };

test("near a node, its entry and version; near a port, the return", () => {
  expect(laneTargetAt(l, c, 100, y(0))).toEqual({ kind: "entry", entry: 1, version: "plate" });
  expect(laneTargetAt(l, c, 106, y(0) + 2)).toEqual({ kind: "entry", entry: 1, version: "plate" });
  expect(laneTargetAt(l, c, 205, y(2))).toEqual({ kind: "entry", entry: 2, version: "sketch2" });
  expect(laneTargetAt(l, c, 495, y(0))).toEqual({ kind: "return" });
});

test("on a lane, its lineage by the version its segment stands for", () => {
  expect(laneTargetAt(l, c, 150, y(0))).toEqual({ kind: "lane", lane: 0, version: "plate" });
  expect(laneTargetAt(l, c, 450, y(0))).toEqual({ kind: "lane", lane: 0, version: "fillet1" });
  expect(laneTargetAt(l, c, 250, y(2))).toEqual({ kind: "lane", lane: 1, version: "sketch2" });
  // A returned version's own lane stands for it, a body of its own.
  expect(laneTargetAt(l, c, 250, y(1))).toEqual({ kind: "lane", lane: 2, version: "plate" });
});

test("the nearest row wins, and nothing is where no lane is", () => {
  expect(laneTargetAt(l, c, 450, y(0) + 3)).toEqual({ kind: "lane", lane: 0, version: "fillet1" });
  expect(laneTargetAt(l, c, 450, y(0) + 4)).toEqual({ kind: "lane", lane: 2, version: "plate" });
  expect(laneTargetAt(l, c, 50, y(2))).toBeUndefined();
  expect(laneTargetAt(l, c, 600, y(0))).toBeUndefined();
});
