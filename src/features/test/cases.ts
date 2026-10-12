/**
 * M1 and M3 from research/03's benchmark, written with the feature library. The edits and oracles
 * are ported from the prototype (src/cases/m1-slotted-block.ts, m3-bracket.ts).
 */
import { describe, type EdgeInfo, type FaceInfo } from "../src/geom.ts";
import type { Shape } from "../src/oc.ts";
import type { Topo } from "../src/topo.ts";
import { chamfer, circle, extrude, fillet, plane, polygon, sketch, type Body, type Frame, type Profile, type Ref } from "../src/index.ts";

export type Expected = Shape[] | "gone";

export interface RefSpec<P> {
  slot: string;
  kind: "face" | "edge";
  multi: boolean;
  /** What the user means, in geometric terms. */
  oracle(t: Topo, p: P): Expected;
}

export interface Edit<P> {
  name: string;
  params: Partial<P>;
}

/** Supplies the references of slot `slot` to the feature that consumes it; `before` is the body the feature works on. */
export type RefFor = (slot: string, before: Body) => Ref[];

export interface Case<P> {
  model: string;
  params: P;
  build(p: P, refFor: RefFor): Body;
  refs: RefSpec<P>[];
  edits: Edit<P>[];
}

export const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) < tol;
const facesWhere = (t: Topo, pred: (i: FaceInfo) => boolean) => t.faces.filter((f) => pred(describe(f, "face") as FaceInfo));
const edgesWhere = (t: Topo, pred: (i: EdgeInfo) => boolean) => t.edges.filter((e) => pred(describe(e, "edge") as EdgeInfo));
const orGone = (xs: Shape[]): Expected => (xs.length ? xs : "gone");

/** The same polygon drawn in the opposite direction; every segment keeps its id. */
function reversed(p: Profile): Profile {
  if (p.kind !== "polygon") return p;
  const n = p.points.length;
  return { ...p, points: [...p.points].reverse(), ids: p.points.map((_, i) => p.ids[(2 * n - 2 - i) % n]!) };
}

/** Rectangle with segments front (y = y0), right, back, [corner,] left; y mirrored with `flip`. */
function block(x0: number, y0: number, w: number, d: number, flip = false, cornerCut = 0): Profile {
  const s = flip ? -1 : 1;
  const segs: Record<string, [number, number]> = { front: [x0, y0], right: [x0 + w, y0], back: [x0 + w, y0 + d] };
  if (cornerCut > 0) Object.assign(segs, { corner: [x0 + cornerCut, y0 + d], left: [x0, y0 + d - cornerCut] });
  else segs["left"] = [x0, y0 + d];
  for (const k of Object.keys(segs)) segs[k] = [segs[k]![0], s * segs[k]![1]];
  return polygon(segs);
}

const named = (name: string) => ({ name, variable: true });

// ---------- M1: slotted block ----------

interface M1 {
  w: number;
  d: number;
  h: number;
  a: number;
  r: number;
  flip: boolean;
  notch: boolean;
  extraNotch: boolean;
  cornerCut: number;
  reverse: boolean;
}

const capZ = (p: M1) => (p.flip ? -p.h : p.h);
const bossX = (p: M1) => p.w - 6;
const flipped: Frame = { origin: [0, 0, 0], normal: [0, 0, -1], xDir: [1, 0, 0] };

export const m1: Case<M1> = {
  model: "M1 slotted block",
  params: { w: 60, d: 40, h: 20, a: 30, r: 8, flip: false, notch: true, extraNotch: false, cornerCut: 0, reverse: false },
  build(p, refFor) {
    const profile = block(0, 0, p.w, p.d, p.flip, p.cornerCut);
    const sketch1 = sketch({ plane: p.flip ? flipped : plane("XY"), profile: p.reverse ? reversed(profile) : profile }, named("sketch1"));
    const extrude1 = extrude({ sketch: sketch1, distance: p.h }, named("extrude1"));
    let body = extrude1;
    if (p.notch) {
      const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [p.a, 0], radius: p.r }) }, named("sketch2"));
      body = extrude({ sketch: sketch2, operation: "cut", target: body, extent: "through" }, named("notch"));
    }
    if (p.extraNotch) {
      const sketch3 = sketch({ plane: plane("XY"), profile: circle({ center: [45, 0], radius: 3 }) }, named("sketch3"));
      body = extrude({ sketch: sketch3, operation: "cut", target: body, extent: "through" }, named("notch2"));
    }
    const fillet1 = fillet({ body, edges: refFor("notchTopEdge", body), radius: 1.5 }, named("fillet1"));
    const chamfer1 = chamfer({ body: fillet1, edges: refFor("frontRightTopEdge", fillet1), distance: 1 }, named("chamfer1"));
    const [face] = refFor("frontRightFace", chamfer1);
    const sketch4 = sketch({ body: chamfer1, plane: face!, profile: circle({ center: [bossX(p), capZ(p) / 2], radius: 2 }) }, named("sketch4"));
    return extrude({ sketch: sketch4, distance: 4, operation: "join", target: chamfer1 }, named("extrude2"));
  },
  refs: [
    {
      slot: "notchTopEdge",
      kind: "edge",
      multi: true,
      oracle: (t, p) => orGone(edgesWhere(t, (e) => e.type === "circle" && near(e.center![2], capZ(p)) && near(e.center![0], p.a) && near(e.center![1], 0) && near(e.radius!, p.r))),
    },
    {
      slot: "frontRightTopEdge",
      kind: "edge",
      multi: true,
      oracle: (t, p) =>
        orGone(edgesWhere(t, (e) => e.type === "line" && e.ends.every((v) => near(v[1], 0) && near(v[2], capZ(p))) && (!p.notch || Math.min(e.ends[0][0], e.ends[1][0]) >= p.a + p.r - 1e-4))),
    },
    {
      slot: "frontRightFace",
      kind: "face",
      multi: false,
      oracle: (t, p) =>
        orGone(facesWhere(t, (f) => f.type === "plane" && near(f.dir![1], -1) && near(f.offset!, 0) && f.bboxMin[0] <= bossX(p) && f.bboxMax[0] >= bossX(p) && (!p.notch || f.bboxMin[0] >= p.a + p.r - 1e-4))),
    },
  ],
  edits: [
    { name: "move notch (a 30→25)", params: { a: 25 } },
    { name: "taller block (h 20→30)", params: { h: 30 } },
    { name: "notch to right end (a=60)", params: { a: 60 } },
    { name: "notch to left end (a=0)", params: { a: 0 } },
    { name: "flip block extrude", params: { flip: true } },
    { name: "insert 2nd notch upstream", params: { extraNotch: true } },
    { name: "delete notch", params: { notch: false } },
    { name: "add corner segment to block sketch", params: { cornerCut: 5 } },
    { name: "block sketch drawn reversed", params: { reverse: true } },
  ],
};

// ---------- M3: L-bracket ----------

interface M3 {
  w: number;
  d: number;
  t: number;
  H: number;
  ribs: number[];
  ribT: number;
  uprightY: number;
  cornerCut: number;
  reverse: "" | "base" | "upright";
}

const holeAt = (p: M3): [number, number] => [p.w / 2, (p.t + p.H) / 2];

export const m3: Case<M3> = {
  model: "M3 bracket",
  params: { w: 60, d: 40, t: 8, H: 50, ribs: [30], ribT: 6, uprightY: 0, cornerCut: 0, reverse: "" },
  build(p, refFor) {
    const maybeReversed = (id: M3["reverse"], profile: Profile) => (p.reverse === id ? reversed(profile) : profile);
    const sketch1 = sketch({ plane: plane("XY"), profile: maybeReversed("base", block(0, 0, p.w, p.d, false, p.cornerCut)) }, named("sketch1"));
    const base = extrude({ sketch: sketch1, distance: p.t }, named("base"));
    const sketch2 = sketch({ plane: plane("XY", p.t), profile: maybeReversed("upright", block(0, p.uprightY, p.w, p.t)) }, named("sketch2"));
    let body = extrude({ sketch: sketch2, distance: p.H - p.t, operation: "join", target: base }, named("upright"));
    p.ribs.forEach((x, i) => {
      const y = p.uprightY + p.t;
      const rib = sketch({ plane: plane("YZ", x - p.ribT / 2), profile: polygon({ foot: [y, p.t], hyp: [y + 20, p.t], web: [y, p.t + 20] }) }, named(`ribSketch${i}`));
      body = extrude({ sketch: rib, distance: p.ribT, operation: "join", target: body }, named(`rib${i}`));
    });
    const fillet1 = fillet({ body, edges: refFor("innerCornerEdges", body), radius: 2 }, named("fillet1"));
    const chamfer1 = chamfer({ body: fillet1, edges: refFor("uprightTopBackEdge", fillet1), distance: 1 }, named("chamfer1"));
    const [face] = refFor("backFace", chamfer1);
    const sketch3 = sketch({ body: chamfer1, plane: face!, profile: circle({ center: holeAt(p), radius: 4 }) }, named("sketch3"));
    return extrude({ sketch: sketch3, distance: 5, operation: "cut", target: chamfer1 }, named("extrude1"));
  },
  refs: [
    {
      slot: "innerCornerEdges",
      kind: "edge",
      multi: true,
      oracle: (t, p) => orGone(edgesWhere(t, (e) => e.type === "line" && e.ends.every((v) => near(v[1], p.uprightY + p.t) && near(v[2], p.t)))),
    },
    {
      slot: "uprightTopBackEdge",
      kind: "edge",
      multi: true,
      oracle: (t, p) => orGone(edgesWhere(t, (e) => e.type === "line" && e.ends.every((v) => near(v[1], p.uprightY) && near(v[2], p.H)))),
    },
    {
      slot: "backFace",
      kind: "face",
      multi: false,
      oracle: (t, p) => {
        const [x, z] = holeAt(p);
        return orGone(facesWhere(t, (f) => f.type === "plane" && near(f.dir![1], -1) && near(f.offset!, -p.uprightY) && f.bboxMin[0] <= x && f.bboxMax[0] >= x && f.bboxMin[2] <= z && f.bboxMax[2] >= z));
      },
    },
  ],
  edits: [
    { name: "taller upright (H 50→60)", params: { H: 60 } },
    { name: "move rib (x 30→15)", params: { ribs: [15] } },
    { name: "delete rib", params: { ribs: [] } },
    { name: "thicker plates (t 8→10)", params: { t: 10 } },
    { name: "upright not flush (y 0→2)", params: { uprightY: 2 } },
    { name: "insert 2nd rib", params: { ribs: [30, 45] } },
    { name: "add corner segment to base sketch", params: { cornerCut: 5 } },
    { name: "upright sketch drawn reversed", params: { reverse: "upright" } },
    { name: "base sketch drawn reversed", params: { reverse: "base" } },
  ],
};
