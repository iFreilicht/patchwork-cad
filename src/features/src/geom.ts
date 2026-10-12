import { oc, subShapes, type Kind, type Shape } from "./oc.ts";

export type Vec = readonly [number, number, number];

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: Vec) => Math.sqrt(dot(a, a));
export const dist = (a: Vec, b: Vec) => norm(sub(a, b));
export const unit = (a: Vec): Vec => scale(a, 1 / norm(a));
/** Parallel or anti-parallel within tolerance. */
export const parallel = (a: Vec, b: Vec, tol = 1e-6) => 1 - Math.abs(dot(unit(a), unit(b))) < tol;
export const fmt = (v: Vec) => `[${v.map((x) => +x.toFixed(3)).join(", ")}]`;

export type SurfaceType = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
export type CurveType = "line" | "circle" | "other";

export interface FaceInfo {
  kind: "face";
  type: SurfaceType;
  centroid: Vec;
  area: number;
  /** Outward normal for planes, axis direction for cylinders/cones. */
  dir?: Vec;
  /** Signed plane offset `dot(normal, p)` for planes. */
  offset?: number;
  radius?: number;
  bboxMin: Vec;
  bboxMax: Vec;
}

export interface EdgeInfo {
  kind: "edge";
  type: CurveType;
  centroid: Vec;
  length: number;
  /** Line direction or circle axis. */
  dir?: Vec;
  radius?: number;
  /** Circle center. */
  center?: Vec;
  ends: [Vec, Vec];
  bboxMin: Vec;
  bboxMax: Vec;
}

export type Info = FaceInfo | EdgeInfo;

const pnt = (p: { X(): number; Y(): number; Z(): number }): Vec => [p.X(), p.Y(), p.Z()];

function bbox(points: Vec[]): { bboxMin: Vec; bboxMax: Vec } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) (min[i] = Math.min(min[i]!, p[i]!)), (max[i] = Math.max(max[i]!, p[i]!));
  return { bboxMin: min as unknown as Vec, bboxMax: max as unknown as Vec };
}

export function describe(s: Shape, kind: Kind): Info {
  return kind === "face" ? describeFace(s) : describeEdge(s);
}

export function describeFace(s: Shape): FaceInfo {
  const o = oc();
  const face = o.TopoDS.Face(s);
  const props = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(face, props, false, false);
  const ad = new o.BRepAdaptor_Surface(face, true);
  const t = ad.GetType();
  const reversed = face.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED;
  const info: FaceInfo = {
    kind: "face",
    type: "other",
    centroid: pnt(props.CentreOfMass()),
    area: props.Mass(),
    ...bbox(subShapes(face, "edge").flatMap((e) => edgeSamples(e))),
  };
  if (t === o.GeomAbs_SurfaceType.GeomAbs_Plane) {
    let n = pnt(ad.Plane().Axis().Direction());
    if (reversed) n = scale(n, -1);
    info.type = "plane";
    info.dir = n;
    info.offset = dot(n, info.centroid);
  } else if (t === o.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const cyl = ad.Cylinder();
    info.type = "cylinder";
    info.dir = pnt(cyl.Axis().Direction());
    info.radius = cyl.Radius();
  } else if (t === o.GeomAbs_SurfaceType.GeomAbs_Cone) info.type = "cone";
  else if (t === o.GeomAbs_SurfaceType.GeomAbs_Sphere) info.type = "sphere";
  else if (t === o.GeomAbs_SurfaceType.GeomAbs_Torus) info.type = "torus";
  return info;
}

export function describeEdge(s: Shape): EdgeInfo {
  const o = oc();
  const edge = o.TopoDS.Edge(s);
  const props = new o.GProp_GProps();
  o.BRepGProp.LinearProperties(edge, props, false, false);
  const ad = new o.BRepAdaptor_Curve(edge);
  const samples = edgeSamples(edge);
  const ends: [Vec, Vec] = [samples[0]!, samples[samples.length - 1]!];
  const t = ad.GetType();
  const info: EdgeInfo = { kind: "edge", type: "other", centroid: pnt(props.CentreOfMass()), length: props.Mass(), ends, ...bbox(samples) };
  if (t === o.GeomAbs_CurveType.GeomAbs_Line) {
    info.type = "line";
    info.dir = unit(sub(ends[1], ends[0]));
  } else if (t === o.GeomAbs_CurveType.GeomAbs_Circle) {
    const c = ad.Circle();
    info.type = "circle";
    info.dir = pnt(c.Axis().Direction());
    info.radius = c.Radius();
    info.center = pnt(c.Location());
  }
  return info;
}

/** 9 points along an edge, including both ends. */
function edgeSamples(s: Shape): Vec[] {
  const ad = new (oc().BRepAdaptor_Curve)(oc().TopoDS.Edge(s));
  const [t0, t1] = [ad.FirstParameter(), ad.LastParameter()];
  const out: Vec[] = [];
  for (let i = 0; i <= 8; i++) out.push(pnt(ad.Value(t0 + ((t1 - t0) * i) / 8)));
  return out;
}

export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
