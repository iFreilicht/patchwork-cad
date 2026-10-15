/**
 * The built-in feature subset of PoC 2 (research/07): sketch, extrude (new, join, cut), fillet and
 * chamfer. The modelling operations are ported from research/03's prototype (model.ts), because
 * replicad doesn't expose OCCT's history. And `body`, which adopts shapes made with replicad (research/11).
 */
import { Shape as ReplicadShape, type AnyShape } from "replicad";
import { add, cross, describeFace, dot, scale, sub, unit, type Vec } from "./geom.ts";
import { key, type Name } from "./names.ts";
import { listToArray, oc, progress, subShapes, type Shape } from "./oc.ts";
import type { Ref } from "./refs.ts";
import { propagate, withTopology, type Hist, type History } from "./topo.ts";
import { Body, defineFeature, FeatureError, Sketch, type FeatureContext, type FeatureMeta, type Frame, type Profile } from "./feature.ts";
import { schemas } from "./schema.ts";

// ---------- planes and profiles ----------

const PLANES: Record<string, Frame> = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
};

/** An origin plane, moved by `offset` along its normal. XZ faces -Y, so its sketch y axis is +Z. */
export function plane(name: "XY" | "XZ" | "YZ", offset = 0): Frame {
  const p = PLANES[name];
  if (!p) throw new Error(`plane(): unknown plane ${JSON.stringify(name)}`);
  return { ...p, origin: scale(p.normal, offset) };
}

/** An axis-aligned rectangle with segments front (from y0), right, back and left. */
export function rect({ from, to }: { from: [number, number]; to: [number, number] }): Profile {
  const [x0, y0] = from;
  const [x1, y1] = to;
  return { kind: "polygon", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ids: ["front", "right", "back", "left"] };
}

export function circle({ center, radius, id = "c" }: { center: [number, number]; radius: number; id?: string }): Profile {
  return { kind: "circle", center, radius, id };
}

/** A closed polygon: each key is a segment id, its value the segment's start point; the last segment closes the loop. */
export function polygon(segments: Record<string, [number, number]>): Profile {
  return { kind: "polygon", points: Object.values(segments), ids: Object.keys(segments) };
}

/**
 * Sketch frame on a planar face: the origin is the world origin projected onto the plane, x is
 * world X projected (world Y if X is normal to the face). Independent of the face's extent.
 */
function frameOnFace(face: Shape): Frame {
  const o = oc();
  const ad = new o.BRepAdaptor_Surface(o.TopoDS.Face(face), true);
  if (ad.GetType() !== o.GeomAbs_SurfaceType.GeomAbs_Plane) throw new FeatureError("the sketch plane is not a planar face");
  const ax = ad.Plane().Axis();
  let n: Vec = [ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()];
  if (face.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED) n = scale(n, -1);
  const loc: Vec = [ax.Location().X(), ax.Location().Y(), ax.Location().Z()];
  ad.delete();
  const origin = scale(n, dot(n, loc));
  const wx: Vec = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const xDir = unit(sub(wx, scale(n, dot(wx, n))));
  return { origin, normal: n, xDir };
}

const isFrame = (x: unknown): x is Frame => typeof x === "object" && x !== null && "normal" in x && "xDir" in x;

/**
 * Checks that parameter `param` is a body of this library. A replicad shape is the likely mistake:
 * it has no history to name its faces by, and `body()` adopts it (research/11).
 */
function expectBody(value: unknown, param: string): asserts value is Body {
  if (value instanceof Body) return;
  if (value instanceof ReplicadShape) throw new FeatureError(`${param}: a replicad shape, not a feature body; wrap it with body(…)`);
  throw new FeatureError(`${param}: expected a body, got ${value === undefined ? "nothing" : typeof value}`);
}

/** A body without faces: what a feature that made no body gives in a lenient build, so that the build goes on. */
export function emptyBody(name: string): Body {
  const o = oc();
  const compound = new o.TopoDS_Compound();
  const builder = new o.TopoDS_Builder();
  builder.MakeCompound(compound);
  builder.delete();
  return new Body(name, withTopology(compound, [], []));
}

export const sketch = defineFeature<{ plane: Frame | Ref; profile: Profile; body?: Body }, Sketch>({
  type: "sketch",
  ...schemas.sketch,
  fallback: (p, name, message) => new Sketch(name, PLANES["XY"]!, p.profile, message),
  build({ plane, profile, body }, ctx) {
    if (isFrame(plane)) return new Sketch(ctx.name, plane, profile);
    if (body === undefined) throw new FeatureError("a sketch on a face needs the face's body");
    expectBody(body, "body");
    const [face] = ctx.resolve(body, "plane", plane, false);
    return new Sketch(ctx.name, frameOnFace(face!), profile);
  },
});

/** The profile as a face on the frame, with its segments' edges in the face's own edge order. */
function profileFace(p: Profile, fr: Frame): { face: Shape; segments: { edge: Shape; id: string }[] } {
  const o = oc();
  const yDir = cross(fr.normal, fr.xDir);
  const to3 = ([x, y]: [number, number]) => add(fr.origin, add(scale(fr.xDir, x), scale(yDir, y)));
  const P = (v: Vec) => new o.gp_Pnt(v[0], v[1], v[2]);
  const wire = new o.BRepBuilderAPI_MakeWire();
  const ids: string[] = [];
  if (p.kind === "polygon") {
    p.points.forEach((pt, i) => {
      const next = p.points[(i + 1) % p.points.length]!;
      wire.Add(new o.BRepBuilderAPI_MakeEdge(P(to3(pt)), P(to3(next))).Edge());
      ids.push(p.ids[i]!);
    });
  } else {
    const ax = new o.gp_Ax2(P(to3(p.center)), new o.gp_Dir(fr.normal[0], fr.normal[1], fr.normal[2]), new o.gp_Dir(fr.xDir[0], fr.xDir[1], fr.xDir[2]));
    wire.Add(new o.BRepBuilderAPI_MakeEdge(new o.gp_Circ(ax, p.radius)).Edge());
    ids.push(p.id);
  }
  if (!wire.IsDone()) throw new FeatureError("the profile is not a closed loop");
  const face = new o.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face();
  wire.delete();
  // A single wire built edge by edge keeps its insertion order.
  const faceEdges = subShapes(face, "edge");
  return { face, segments: ids.map((id, k) => ({ edge: faceEdges[k]!, id })) };
}

function moveFace(face: Shape, v: Vec): Shape {
  const o = oc();
  const t = new o.gp_Trsf();
  t.SetTranslation(new o.gp_Vec(v[0], v[1], v[2]));
  return new o.BRepBuilderAPI_Transform(face, t, true, false).Shape();
}

type Operation = "new" | "join" | "cut";

export const extrude = defineFeature<
  { sketch: Sketch; distance?: number; operation?: Operation; target?: Body; extent?: "distance" | "through" },
  Body
>({
  type: "extrude",
  ...schemas.extrude,
  inputs: ({ target, operation }) => (operation && operation !== "new" ? [target] : []),
  // A join or cut without a valid target has nothing to pass through: it gives an empty body, so that only it and its users fail.
  fallback: (_, name) => emptyBody(name),
  build({ sketch: sk, distance = 10, operation = "new", target, extent = "distance" }, ctx) {
    if (!(sk instanceof Sketch)) throw new FeatureError("sketch: expected a sketch");
    if (sk.broken) throw new FeatureError(`sketch ${sk.name} is broken: ${sk.broken}`);
    if (operation !== "new") {
      if (target === undefined) throw new FeatureError(`a ${operation} needs a target body`);
      expectBody(target, "target");
    }
    const o = oc();
    const { face, segments } = profileFace(sk.profile, sk.frame);
    const through = extent === "through";
    // A cut goes into the material behind the sketch plane; "through" is symmetric and long.
    const dir = operation === "cut" ? scale(sk.frame.normal, -1) : sk.frame.normal;
    const base = through ? moveFace(face, scale(dir, -500)) : face;
    const vec = scale(dir, through ? 1000 : distance);
    const mk = new o.BRepPrimAPI_MakePrism(base, new o.gp_Vec(vec[0], vec[1], vec[2]), false, true);
    mk.Build(progress());
    if (!mk.IsDone()) throw new FeatureError("the extrusion failed");
    const tool = mk.Shape();
    // Prism history refers to the (possibly moved) base face's edges, in the same order.
    const baseEdges = subShapes(base, "edge");
    const toolFaces = subShapes(tool, "face");
    const toolHist: Hist[] = toolFaces.map(() => new Map());
    const nameFaces = (targets: Shape[], n: Name) => {
      for (const t of targets) {
        const i = toolFaces.findIndex((x) => x.IsSame(t));
        if (i >= 0) toolHist[i]!.set(key(n), n);
      }
    };
    segments.forEach(({ id }, k) => nameFaces(listToArray(mk.Generated(baseEdges[k]!)), { t: "side", feature: ctx.name, seg: id }));
    nameFaces([mk.FirstShape()], { t: "cap", feature: ctx.name, cap: "start" });
    nameFaces([mk.LastShape()], { t: "cap", feature: ctx.name, cap: "end" });
    const toolTopo = withTopology(tool, toolFaces, toolHist);
    if (operation === "new") return new Body(ctx.name, toolTopo);

    const t = target!.topo;
    const bop = operation === "join" ? new o.BRepAlgoAPI_Fuse(t.shape, tool, progress()) : new o.BRepAlgoAPI_Cut(t.shape, tool, progress());
    if (!bop.IsDone()) throw new FeatureError(`the ${operation} failed`);
    // replicad unifies same-domain faces after every boolean (fuseShapes/cutShape); so does this.
    bop.SimplifyResult(true, true, 1e-3);
    return new Body(ctx.name, propagate(bop as unknown as History, [t, toolTopo], [], bop.Shape(), ctx.name));
  },
});

function blend(type: "fillet" | "chamfer", body: Body, refs: Ref[], size: number, ctx: FeatureContext): Body {
  expectBody(body, "body");
  const t = body.topo;
  const picked = ctx.resolve(body, "edges", refs, true);
  if (picked.length === 0) throw new FeatureError("no edges selected");
  const o = oc();
  const mk = type === "fillet" ? new o.BRepFilletAPI_MakeFillet(t.shape, o.ChFi3d_FilletShape.ChFi3d_Rational) : new o.BRepFilletAPI_MakeChamfer(t.shape);
  for (const e of picked) mk.Add(size, o.TopoDS.Edge(e));
  mk.Build(progress());
  if (!mk.IsDone()) throw new FeatureError(`the ${type} failed (OCCT)`);
  // Blends propagate along tangent edge chains, and OCCT reports the faces they create as generated
  // from whichever edge or vertex of the chain made them, not only from the picked edges. So every
  // input edge and vertex is asked.
  const gens: { from: Shape; name: Name }[] = t.edges.map((e, i) => ({ from: e, name: { t: "blend", feature: ctx.name, edge: [...t.edgeHist[i]!.values()] } }));
  for (const v of subShapes(t.shape, "vertex")) gens.push({ from: v, name: { t: "corner", feature: ctx.name } });
  return new Body(ctx.name, propagate(mk as unknown as History, [t], gens, mk.Shape(), ctx.name));
}

export const fillet = defineFeature<{ body: Body; edges: Ref[]; radius: number }, Body>({
  type: "fillet",
  ...schemas.fillet,
  inputs: ({ body }) => [body],
  build: ({ body, edges, radius }, ctx) => blend("fillet", body, edges, radius, ctx),
});

export const chamfer = defineFeature<{ body: Body; edges: Ref[]; distance: number }, Body>({
  type: "chamfer",
  ...schemas.chamfer,
  inputs: ({ body }) => [body],
  build: ({ body, edges, distance }, ctx) => blend("chamfer", body, edges, distance, ctx),
});

// ---------- adopting shapes ----------

type Adoptable = AnyShape | Body;

/** What `body()` adopts: a shape, a body, several of them, or a function that returns those, like a model's `main`. */
export type BodySource = Adoptable | readonly Adoptable[] | (() => Adoptable | readonly Adoptable[]);

/**
 * A body from a shape without history. Each face is named by its centroid (`cut_plate.faceAt([…])`),
 * each edge by its adjacent faces. A body of this library is treated the same: its history is not
 * kept (research/11, "Open").
 */
function adoptOne(value: unknown, name: string): Body {
  const shape = value instanceof Body ? value.topo.shape : value instanceof ReplicadShape ? (value.wrapped as Shape) : undefined;
  if (!shape) throw new FeatureError(`expected a shape, got ${value === undefined ? "nothing" : typeof value}`);
  const faces = subShapes(shape, "face");
  const hist: Hist[] = faces.map((f) => {
    const n: Name = { t: "at", feature: name, near: describeFace(f).centroid };
    return new Map([[key(n), n]]);
  });
  return new Body(name, withTopology(shape, faces, hist));
}

const adopt = defineFeature<{ source: BodySource }, Body | Body[]>({
  type: "body",
  ...schemas.body,
  // A failing function makes empty bodies, as many as are declared, so that only it and its users fail.
  fallback: (_, name, _message, meta) => (meta.names ? meta.names.map((n) => emptyBody(n)) : emptyBody(name)),
  build({ source }, ctx, meta: FeatureMeta) {
    const value = typeof source === "function" ? source() : source;
    if (Array.isArray(value)) return value.map((v, i) => adoptOne(v, meta.names?.[i] ?? `${ctx.name}[${i}]`));
    if (meta.names) throw new FeatureError(`${meta.names.length} bodies are declared, but it made one shape`);
    return adoptOne(value, ctx.name);
  },
});

/**
 * Adopts shapes made with replicad as bodies that features can use, e.g.
 * `const cut_plate = body(() => plate.cut(bore))` or `const [left, right] = body(() => [a, b])`
 * (research/11). It returns a body for a shape and an array of bodies for an array, as `main` does.
 */
export function body(source: Adoptable | (() => Adoptable), meta?: FeatureMeta): Body;
export function body(source: readonly Adoptable[] | (() => readonly Adoptable[]), meta?: FeatureMeta): Body[];
export function body(source: BodySource, meta?: FeatureMeta): Body | Body[];
export function body(source: BodySource, meta?: FeatureMeta): Body | Body[] {
  return adopt({ source }, meta);
}
