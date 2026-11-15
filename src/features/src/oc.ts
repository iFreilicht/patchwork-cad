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
  const out = new ShapeIndex();
  const ex = new (oc().TopExp_Explorer)(s, shapeEnum(kind), oc().TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (out.indexOf(c) < 0) out.push(c);
  }
  ex.delete();
  return out.shapes;
}

/** OCCT's hash of a shape: of its TShape and location, which IsSame compares, so that shapes that are the same have the same hash. */
const hashOf = (s: Shape) => oc().ReplicadShapeHasher.HashCode(s, 2147483647);

/**
 * Shapes in order, found by IsSame without comparing with each: only with those of the same hash.
 * A large sketch, e.g. of text, has thousands of edges, and comparing each with all is quadratic.
 */
export class ShapeIndex {
  readonly shapes: Shape[] = [];
  private readonly buckets = new Map<number, number[]>();

  constructor(shapes: Iterable<Shape> = []) {
    for (const s of shapes) this.push(s);
  }

  /** Adds a shape at the end, and returns its index. */
  push(s: Shape): number {
    const i = this.shapes.push(s) - 1;
    const h = hashOf(s);
    const bucket = this.buckets.get(h);
    if (bucket) bucket.push(i);
    else this.buckets.set(h, [i]);
    return i;
  }

  /** The index of the first shape that IsSame as `s`, or -1. */
  indexOf(s: Shape): number {
    for (const i of this.buckets.get(hashOf(s)) ?? []) if (this.shapes[i]!.IsSame(s)) return i;
    return -1;
  }
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
