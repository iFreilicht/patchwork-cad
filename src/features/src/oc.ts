import { getOC } from "replicad";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance;
export type Shape = TopoDS_Shape;
export type Kind = "face" | "edge";

/** The OCCT instance replicad was set up with (`setOC`); the library never loads its own. */
export const oc = (): OC => getOC();

const shapeEnum = (kind: Kind | "vertex" | "solid") =>
  ({
    face: oc().TopAbs_ShapeEnum.TopAbs_FACE,
    edge: oc().TopAbs_ShapeEnum.TopAbs_EDGE,
    vertex: oc().TopAbs_ShapeEnum.TopAbs_VERTEX,
    solid: oc().TopAbs_ShapeEnum.TopAbs_SOLID,
  })[kind];

/**
 * Unique sub-shapes of `s` in OCCT's exploration order, deduplicated like replicad's `iterTopo`
 * (and TopExp::MapShapes), so indices match replicad's `faces`/`edges`.
 */
export function subShapes(s: Shape, kind: Kind | "vertex" | "solid"): Shape[] {
  const out: Shape[] = [];
  const ex = new (oc().TopExp_Explorer)(s, shapeEnum(kind), oc().TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((x) => x.IsSame(c))) out.push(c);
  }
  ex.delete();
  return out;
}

/** Copies an OCCT shape list into an array. */
export function listToArray(list: { Size(): number; First(): Shape; RemoveFirst(): void }): Shape[] {
  const out: Shape[] = [];
  while (list.Size() > 0) {
    out.push(list.First());
    list.RemoveFirst();
  }
  return out;
}

export const progress = () => new (oc().Message_ProgressRange)();
