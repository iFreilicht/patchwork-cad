/**
 * M5: box with a boss sketched on its top face; the boss's top edge is filleted and the part shelled
 * by removing the bottom face.
 */
import { edgesWhere, facesWhere, near, orGone, type Case } from "../bench.ts";
import type { Feature } from "../model.ts";
import { circle, rect, when, XY } from "./common.ts";

interface P {
  w: number;
  d: number;
  h: number;
  bx: number;
  by: number;
  br: number;
  bh: number;
  flip: boolean;
  topChamfer: boolean;
  cornerCut: number;
  slot: boolean;
  filletAfterShell: boolean;
}

const capZ = (p: P) => (p.flip ? -p.h : p.h);
const capDir = (p: P) => (p.flip ? -1 : 1);

export const m5: Case<P> = {
  model: "M5 boss + shell",
  params: { w: 50, d: 40, h: 20, bx: 25, by: 20, br: 8, bh: 10, flip: false, topChamfer: false, cornerCut: 0, slot: false, filletAfterShell: false },
  features: (p) => {
    // Fillet radius > shell thickness: offsetting a convex fillet inward by more than its radius fails.
    const fillet: Feature = { id: "f3", type: "fillet", edges: "bossTopEdge", radius: 3 };
    return [
      { id: "f1", type: "extrude", plane: XY(0, p.flip), profile: rect(0, 0, p.w, p.d, p.flip, p.cornerCut), distance: p.h, op: "new" },
      ...when(p.topChamfer, { id: "topChamfer", type: "chamfer", edges: "capEdges", distance: 1 }),
      ...when(p.slot, { id: "slot", type: "extrude", plane: XY(capZ(p), p.flip), profile: rect(0, 8, p.w, 4, p.flip), distance: 5, op: "cut" }),
      { id: "f2", type: "extrude", plane: { onFace: "topFace" }, profile: circle(p.bx, p.by, p.br, p.flip), distance: p.bh, op: "fuse" },
      ...when(!p.filletAfterShell, fillet),
      { id: "f4", type: "shell", faces: "bottomFace", thickness: 1 },
      ...when(p.filletAfterShell, fillet),
    ];
  },
  refs: [
    {
      slot: "topFace",
      kind: "face",
      multi: false,
      intent: "the box's end cap (piece under the boss)",
      oracle: (s, p) => orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![2], capDir(p)) && near(f.offset!, p.h) && f.bboxMin[1] <= p.by && f.bboxMax[1] >= p.by && f.bboxMin[0] <= p.bx && f.bboxMax[0] >= p.bx)),
    },
    {
      slot: "bossTopEdge",
      kind: "edge",
      multi: true,
      intent: "outer edge of the boss's end cap",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "circle" && near(e.radius!, p.br) && near(e.center![2], capZ(p) + capDir(p) * p.bh))),
    },
    {
      slot: "bottomFace",
      kind: "face",
      multi: true,
      intent: "the box's start cap (removed by the shell)",
      oracle: (s, p) => orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![2], -capDir(p)) && near(f.offset!, 0))),
    },
    {
      slot: "capEdges",
      kind: "edge",
      multi: true,
      intent: "(edit-only) edges of the end cap, for the inserted chamfer",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "line" && e.ends.every((v) => near(v[2], capZ(p))))),
    },
  ],
  baseExpect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 },
  edits: [
    { name: "taller box (h 20→30)", category: "dimension", params: { h: 30 }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 } },
    { name: "flip box extrude", category: "flip", params: { flip: true }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 } },
    { name: "insert chamfer on cap upstream", category: "insert-upstream", params: { topChamfer: true }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1, capEdges: 4 } },
    { name: "add corner segment to box sketch", category: "sketch-segment", params: { cornerCut: 5 }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 } },
    { name: "move boss (x 25→12)", category: "dimension", params: { bx: 12 }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 } },
    {
      name: "insert slot splitting the cap",
      category: "insert-upstream",
      params: { slot: true },
      expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 },
      // OCCT's MakeThickSolidByJoin fails for every slot variant tried (investigations/shell-slot.ts). The
      // shell is the last feature and the consumer of bottomFace, which is resolved before it.
      allowFailures: { f4: "OCCT shell fails with the slot" },
    },
    { name: "fillet after shell", category: "reorder", params: { filletAfterShell: true }, expect: { topFace: 1, bossTopEdge: 1, bottomFace: 1 } },
  ],
};
