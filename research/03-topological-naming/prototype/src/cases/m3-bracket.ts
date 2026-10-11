/**
 * M3: L-bracket. A base plate and an upright are fused with flush back faces (which merge into one
 * face), a triangular rib splits the inner corner edge. The corner is filleted, the upright's top
 * back edge chamfered, and a hole is sketched on the merged back face.
 */
import { edgesWhere, facesWhere, near, orGone, type Case } from "../bench.ts";
import type { Feature, Frame } from "../model.ts";
import { circle, rect, XY } from "./common.ts";

interface P {
  w: number;
  d: number;
  t: number;
  H: number;
  ribs: number[];
  ribT: number;
  uprightY: number;
  cornerCut: number;
}

const ribPlane = (x: number): Frame => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] });
const holeAt = (p: P): [number, number] => [p.w / 2, (p.t + p.H) / 2];

export const m3: Case<P> = {
  model: "M3 bracket",
  params: { w: 60, d: 40, t: 8, H: 50, ribs: [30], ribT: 6, uprightY: 0, cornerCut: 0 },
  features: (p) => [
    { id: "base", type: "extrude", plane: XY(), profile: rect(0, 0, p.w, p.d, false, p.cornerCut), distance: p.t, op: "new" },
    { id: "upright", type: "extrude", plane: XY(p.t), profile: rect(0, p.uprightY, p.w, p.t), distance: p.H - p.t, op: "fuse" },
    ...p.ribs.map(
      (x, i): Feature => ({
        id: `rib${i}`,
        type: "extrude",
        plane: ribPlane(x - p.ribT / 2),
        profile: { kind: "polygon", points: [[p.uprightY + p.t, p.t], [p.uprightY + p.t + 20, p.t], [p.uprightY + p.t, p.t + 20]], segments: ["foot", "hyp", "web"] },
        distance: p.ribT,
        op: "fuse",
      }),
    ),
    { id: "f4", type: "fillet", edges: "innerCornerEdges", radius: 2 },
    { id: "f5", type: "chamfer", edges: "uprightTopBackEdge", distance: 1 },
    { id: "f6", type: "extrude", plane: { onFace: "backFace" }, profile: circle(...holeAt(p), 4), distance: 5, op: "cut" },
  ],
  refs: [
    {
      slot: "innerCornerEdges",
      kind: "edge",
      multi: true,
      intent: "all pieces of the inner corner edge between base and upright",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "line" && e.ends.every((v) => near(v[1], p.uprightY + p.t) && near(v[2], p.t)))),
    },
    {
      slot: "uprightTopBackEdge",
      kind: "edge",
      multi: true,
      intent: "back edge of the upright's top face",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "line" && e.ends.every((v) => near(v[1], p.uprightY) && near(v[2], p.H)))),
    },
    {
      slot: "backFace",
      kind: "face",
      multi: false,
      intent: "back face where the hole sits (merged base+upright face while flush)",
      oracle: (s, p) => {
        const [x, z] = holeAt(p);
        return orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![1], -1) && near(f.offset!, -p.uprightY) && f.bboxMin[0] <= x && f.bboxMax[0] >= x && f.bboxMin[2] <= z && f.bboxMax[2] >= z));
      },
    },
  ],
  baseExpect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 },
  edits: [
    { name: "taller upright (H 50→60)", category: "dimension", params: { H: 60 }, expect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "move rib (x 30→15)", category: "dimension", params: { ribs: [15] }, expect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "delete rib", category: "delete-upstream", params: { ribs: [] }, expect: { innerCornerEdges: 1, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "thicker plates (t 8→10)", category: "dimension", params: { t: 10 }, expect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "upright not flush (y 0→2)", category: "dimension-topology", params: { uprightY: 2 }, expect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "insert 2nd rib", category: "insert-upstream", params: { ribs: [30, 45] }, expect: { innerCornerEdges: 3, uprightTopBackEdge: 1, backFace: 1 } },
    { name: "add corner segment to base sketch", category: "sketch-segment", params: { cornerCut: 5 }, expect: { innerCornerEdges: 2, uprightTopBackEdge: 1, backFace: 1 } },
  ],
};
