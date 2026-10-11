/**
 * M4: stepped shaft, revolved from a sketch. The shoulder edge is filleted, the end edge chamfered,
 * and a hole is sketched on the end face.
 */
import { edgesWhere, facesWhere, near, orGone, type Case } from "../bench.ts";
import type { Feature, Frame, Profile } from "../model.ts";
import { circle, when } from "./common.ts";

interface P {
  r1: number;
  r2: number;
  l1: number;
  l2: number;
  step: boolean;
  groove: boolean;
  crossHole: boolean;
  chamferFirst: boolean;
}

const XZ: Frame = { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
const L = (p: P) => p.l1 + p.l2;
const endRadius = (p: P) => (p.step ? p.r2 : p.r1);

function profile(p: P): Profile {
  if (!p.step) return { kind: "polygon", points: [[0, 0], [p.r1, 0], [p.r1, L(p)], [0, L(p)]], segments: ["bottom", "big", "top", "axis"] };
  const pts: [number, number][] = [[0, 0], [p.r1, 0], [p.r1, p.l1], [p.r2, p.l1]];
  // A groove splits the "small" segment; the lower part keeps the name, as a sketcher splitting a line would.
  const segs = ["bottom", "big", "shoulder", "small"];
  if (p.groove) {
    const g = p.r2 - 1.5;
    pts.push([p.r2, p.l1 + 10], [g, p.l1 + 10], [g, p.l1 + 14], [p.r2, p.l1 + 14]);
    segs.push("grooveLow", "grooveBottom", "grooveHigh", "small2");
  }
  pts.push([p.r2, L(p)], [0, L(p)]);
  segs.push("top", "axis");
  return { kind: "polygon", points: pts, segments: segs };
}

export const m4: Case<P> = {
  model: "M4 shaft",
  params: { r1: 10, r2: 6, l1: 20, l2: 30, step: true, groove: false, crossHole: false, chamferFirst: false },
  features: (p) => {
    const chamfer: Feature = { id: "f3", type: "chamfer", edges: "endEdge", distance: 0.5 };
    return [
      { id: "f1", type: "revolve", plane: XZ, profile: profile(p), axis: { origin: [0, 0], dir: [0, 1] }, op: "new" },
      ...when(p.crossHole, { id: "cross", type: "extrude", plane: { origin: [0, 0, p.l1 / 2], normal: [0, 1, 0], xDir: [1, 0, 0] }, profile: circle(0, 0, 3), distance: 0, through: true, op: "cut" }),
      ...when(p.chamferFirst, chamfer),
      { id: "f2", type: "fillet", edges: "shoulderEdge", radius: 1 },
      ...when(!p.chamferFirst, chamfer),
      { id: "f4", type: "extrude", plane: { onFace: "endFace" }, profile: circle(0, 0, 2), distance: 8, op: "cut" },
    ];
  },
  refs: [
    {
      slot: "shoulderEdge",
      kind: "edge",
      multi: true,
      intent: "edge between shoulder and small diameter",
      oracle: (s, p) => (p.step ? orGone(edgesWhere(s, (e) => e.type === "circle" && near(e.radius!, p.r2) && near(e.center![2], p.l1))) : "gone"),
    },
    {
      slot: "endEdge",
      kind: "edge",
      multi: true,
      intent: "outer edge of the end face",
      oracle: (s, p) => orGone(edgesWhere(s, (e) => e.type === "circle" && near(e.radius!, endRadius(p)) && near(e.center![2], L(p)))),
    },
    {
      slot: "endFace",
      kind: "face",
      multi: false,
      intent: "end face, where the hole goes",
      oracle: (s, p) => orGone(facesWhere(s, (f) => f.type === "plane" && near(f.dir![2], 1) && near(f.offset!, L(p)))),
    },
  ],
  baseExpect: { shoulderEdge: 1, endEdge: 1, endFace: 1 },
  edits: [
    { name: "smaller diameter (r2 6→4)", category: "dimension", params: { r2: 4 }, expect: { shoulderEdge: 1, endEdge: 1, endFace: 1 } },
    { name: "longer big section (l1 20→25)", category: "dimension", params: { l1: 25 }, expect: { shoulderEdge: 1, endEdge: 1, endFace: 1 } },
    { name: "add groove to sketch", category: "sketch-segment", params: { groove: true }, expect: { shoulderEdge: 1, endEdge: 1, endFace: 1 } },
    { name: "remove step from sketch", category: "sketch-segment", params: { step: false }, expect: { shoulderEdge: "gone", endEdge: 1, endFace: 1 } },
    { name: "insert cross hole upstream", category: "insert-upstream", params: { crossHole: true }, expect: { shoulderEdge: 1, endEdge: 1, endFace: 1 } },
    { name: "chamfer before fillet", category: "reorder", params: { chamferFirst: true }, expect: { shoulderEdge: 1, endEdge: 1, endFace: 1 } },
  ],
};
