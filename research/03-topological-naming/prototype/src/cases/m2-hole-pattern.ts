/**
 * M2: plate with a linear pattern of through holes. The 2nd hole's top edge is filleted, the plate's
 * front-top edge chamfered, and a boss is sketched on the top face.
 */
import { edgesWhere, facesWhere, near, orGone, type Case } from "../bench.ts";
import type { Feature } from "../model.ts";
import { circle, rect, when, XY } from "./common.ts";

interface P {
  w: number;
  d: number;
  h: number;
  count: number;
  pitch: number;
  x0: number;
  r: number;
  flip: boolean;
  boss: boolean;
  chamferFirst: boolean;
}

const capZ = (p: P) => (p.flip ? -p.h : p.h);
const bossAt: [number, number] = [90, 20];

export const m2: Case<P> = {
  model: "M2 hole pattern",
  params: { w: 100, d: 40, h: 8, count: 3, pitch: 25, x0: 20, r: 4, flip: false, boss: false, chamferFirst: false },
  features: (p) => {
    const chamfer: Feature = { id: "f4", type: "chamfer", edges: "plateFrontTopEdge", distance: 1 };
    return [
      { id: "f1", type: "extrude", plane: XY(0, p.flip), profile: rect(0, 0, p.w, p.d, p.flip), distance: p.h, op: "new" },
      ...when(p.boss, { id: "boss", type: "extrude", plane: XY(p.h), profile: rect(2, 15, 8, 10), distance: 6, op: "fuse" }),
      ...when(p.chamferFirst, chamfer),
      { id: "holes", type: "pattern", count: p.count, step: [p.pitch, 0, 0], of: { id: "hole", type: "extrude", plane: XY(), profile: circle(p.x0, p.d / 2, p.r), distance: 0, through: true, op: "cut" } },
      { id: "f3", type: "fillet", edges: "hole2TopEdge", radius: 1 },
      ...when(!p.chamferFirst, chamfer),
      { id: "f5", type: "extrude", plane: { onFace: "plateTopFace" }, profile: circle(bossAt[0], bossAt[1], 3, p.flip), distance: 4, op: "fuse" },
    ];
  },
  refs: [
    {
      slot: "hole2TopEdge",
      kind: "edge",
      multi: true,
      intent: "top edge of the 2nd hole",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "circle" && near(e.radius!, p.r) && near(e.center![0], p.x0 + p.pitch) && near(e.center![1], p.d / 2) && near(e.center![2], capZ(p)))),
    },
    {
      slot: "plateFrontTopEdge",
      kind: "edge",
      multi: true,
      intent: "front edge of the plate's end cap",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "line" && e.ends.every((v) => near(v[1], 0) && near(v[2], capZ(p))))),
    },
    {
      slot: "plateTopFace",
      kind: "face",
      multi: false,
      intent: "the plate's end cap, where the boss sits",
      oracle: (s, p) => orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![2], p.flip ? -1 : 1) && near(f.offset!, p.h) && f.bboxMin[0] <= bossAt[0] && f.bboxMax[0] >= bossAt[0])),
    },
  ],
  baseExpect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 },
  edits: [
    { name: "pitch 25→20", category: "dimension", params: { pitch: 20 }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "count 3→4", category: "pattern-count", params: { count: 4 }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "count 3→1", category: "pattern-count", params: { count: 1 }, expect: { hole2TopEdge: "gone", plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "first hole x 20→10", category: "dimension", params: { x0: 10 }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "insert boss upstream", category: "insert-upstream", params: { boss: true }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "chamfer before holes", category: "reorder", params: { chamferFirst: true }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "thicker plate (h 8→12)", category: "dimension", params: { h: 12 }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
    { name: "flip plate extrude", category: "flip", params: { flip: true }, expect: { hole2TopEdge: 1, plateFrontTopEdge: 1, plateTopFace: 1 } },
  ],
};
