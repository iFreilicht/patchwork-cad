/**
 * M1: Bidarra et al.'s example. A through notch on the front face of a block splits that face; the
 * notch's top edge is filleted, the front-top edge right of the notch chamfered, and a boss is
 * sketched on the front face piece right of the notch.
 */
import { edgesWhere, facesWhere, near, orGone, type Case } from "../bench.ts";
import { circle, rect, reverseSketchOf, when, XY } from "./common.ts";

interface P {
  w: number;
  d: number;
  h: number;
  /** notch center x */
  a: number;
  r: number;
  flip: boolean;
  notch: boolean;
  extraNotch: boolean;
  cornerCut: number;
}

const capZ = (p: P) => (p.flip ? -p.h : p.h);
const bossX = (p: P) => p.w - 6;

export const m1: Case<P> = {
  model: "M1 slotted block",
  params: { w: 60, d: 40, h: 20, a: 30, r: 8, flip: false, notch: true, extraNotch: false, cornerCut: 0 },
  features: (p) => [
      { id: "f1", type: "extrude", plane: XY(0, p.flip), profile: rect(0, 0, p.w, p.d, p.flip, p.cornerCut), distance: p.h, op: "new" },
      ...when(p.notch, { id: "notch", type: "extrude", plane: XY(), profile: circle(p.a, 0, p.r), distance: 0, through: true, op: "cut" }),
      ...when(p.extraNotch, { id: "notch2", type: "extrude", plane: XY(), profile: circle(45, 0, 3), distance: 0, through: true, op: "cut" }),
      { id: "f3", type: "fillet", edges: "notchTopEdge", radius: 1.5 },
      { id: "f4", type: "chamfer", edges: "frontRightTopEdge", distance: 1 },
      { id: "f5", type: "extrude", plane: { onFace: "frontRightFace" }, profile: circle(bossX(p), capZ(p) / 2, 2), distance: 4, op: "fuse" },
    ],
  refs: [
    {
      slot: "notchTopEdge",
      kind: "edge",
      multi: true,
      intent: "arc where the notch meets the end cap",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "circle" && near(e.center![2], capZ(p)) && near(e.center![0], p.a) && near(e.center![1], 0) && near(e.radius!, p.r))),
    },
    {
      slot: "frontRightTopEdge",
      kind: "edge",
      multi: true,
      intent: "front edge of the end cap, right of the notch (all pieces)",
      oracle: (s, p) =>
        orGone(edgesWhere(s, (e) => e.type === "line" && e.ends.every((v) => near(v[1], 0) && near(v[2], capZ(p))) && (!p.notch || Math.min(e.ends[0][0], e.ends[1][0]) >= p.a + p.r - 1e-4))),
    },
    {
      slot: "frontRightFace",
      kind: "face",
      multi: false,
      intent: "front face piece right of the notch, where the boss sits",
      oracle: (s, p) =>
        orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![1], -1) && near(f.offset!, 0) && f.bboxMin[0] <= bossX(p) && f.bboxMax[0] >= bossX(p) && (!p.notch || f.bboxMin[0] >= p.a + p.r - 1e-4))),
    },
  ],
  baseExpect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 },
  edits: [
    { name: "move notch (a 30→25)", category: "dimension", params: { a: 25 }, expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "taller block (h 20→30)", category: "dimension", params: { h: 30 }, expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "notch to right end (a=60)", category: "dimension-topology", params: { a: 60 }, expect: { notchTopEdge: 1, frontRightTopEdge: "gone", frontRightFace: "gone" } },
    { name: "notch to left end (a=0)", category: "dimension-topology", params: { a: 0 }, expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "flip block extrude", category: "flip", params: { flip: true }, expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "insert 2nd notch upstream", category: "insert-upstream", params: { extraNotch: true }, expect: { notchTopEdge: 1, frontRightTopEdge: 2, frontRightFace: 1 } },
    { name: "delete notch", category: "delete-upstream", params: { notch: false }, expect: { notchTopEdge: "gone", frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "add corner segment to block sketch", category: "sketch-segment", params: { cornerCut: 5 }, expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
    { name: "block sketch drawn reversed", category: "sketch-direction", features: reverseSketchOf("f1"), expect: { notchTopEdge: 1, frontRightTopEdge: 1, frontRightFace: 1 } },
  ],
};
