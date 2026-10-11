import init, { type OpenCascadeInstance, type TopoDS_Shape } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance;
export type Shape = TopoDS_Shape;
export type Kind = "face" | "edge";

let instance: OC | undefined;

export async function loadOC(): Promise<OC> {
  instance ??= await init();
  return instance;
}

export function oc(): OC {
  if (!instance) throw new Error("call loadOC() first");
  return instance;
}

const shapeEnum = (kind: Kind | "vertex" | "solid") =>
  ({
    face: oc().TopAbs_ShapeEnum.TopAbs_FACE,
    edge: oc().TopAbs_ShapeEnum.TopAbs_EDGE,
    vertex: oc().TopAbs_ShapeEnum.TopAbs_VERTEX,
    solid: oc().TopAbs_ShapeEnum.TopAbs_SOLID,
  })[kind];

/**
 * Unique sub-shapes of `s` in OCCT's deterministic exploration order (orientation-insensitive,
 * like TopExp::MapShapes).
 */
export function subShapes(s: Shape, kind: Kind | "vertex" | "solid"): Shape[] {
  // NCollection_IndexedMap is declared but not constructible in replicad's trimmed build
  // ("unbound types: NCollection_BaseMap"), so deduplicate here. Same first-seen order as MapShapes.
  const out: Shape[] = [];
  for (const ex = new (oc().TopExp_Explorer)(s, shapeEnum(kind), oc().TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((x) => x.IsSame(c))) out.push(c);
  }
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
