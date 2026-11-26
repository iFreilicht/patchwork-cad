/**
 * Everything a build gives that a cached build must reproduce (research/24), as comparable data: per trace entry
 * its status, message, references and bodies, per body its B-rep (without triangulation), its face
 * and edge names, and its mesh as the tool's worker meshes it.
 */
import { createHash } from "node:crypto";
import { getOC } from "replicad";
import type { Body, Sketch } from "../src/index.ts";
import { meshable, owners, shapeOf, shapers, type TraceEntry } from "../src/runtime.ts";

const MESH = { tolerance: 0.1, angularTolerance: 30 };
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The B-rep as OCCT writes it, read back and written again without triangulations, so that the body itself isn't changed. */
export function brep(body: Body, withMesh = false): string {
  const oc = getOC();
  const text = oc.BRepToolsWrapper.Write(body.topo.shape);
  if (withMesh) return text;
  const copy = oc.BRepToolsWrapper.Read(text);
  oc.BRepTools.Clean(copy, true);
  return oc.BRepToolsWrapper.Write(copy);
}

/** Whether any face of the body carries a triangulation, e.g. from an earlier meshing. */
export const meshed = (body: Body): boolean => brep(body, true).includes("\nTriangulations ") && !/\nTriangulations 0\n/.test(brep(body, true));

type Meshed = { vertices: number[]; triangles: number[]; normals: number[]; faceGroups: { start: number; count: number; faceId: number }[] };
type MeshedEdges = { lines: number[]; edgeGroups: { start: number; count: number; edgeId: number }[] };
interface MeshableShape {
  mesh(o: typeof MESH): Meshed;
  meshEdges(o: typeof MESH): MeshedEdges;
}

/** The mesh of a shape with groups by face and edge index, given the ids of its faces and edges in the body's order. */
function meshPrint(shape: MeshableShape, faceIds: number[], edgeIds: number[]): { faces: string; edges: string } {
  const f = shape.mesh(MESH);
  const e = shape.meshEdges(MESH);
  return {
    faces: hash(JSON.stringify([f.vertices, f.triangles, f.normals, f.faceGroups.map((g) => [g.start, g.count, faceIds.indexOf(g.faceId)])])),
    edges: hash(JSON.stringify([e.lines, e.edgeGroups.map((g) => [g.start, g.count, edgeIds.indexOf(g.edgeId)])])),
  };
}

/** The body's mesh as the worker makes it, of a copy (`meshable`). */
export function meshOf(body: Body): { faces: string; edges: string } {
  const m = meshable(body);
  return meshPrint(m.meshes as unknown as MeshableShape, m.faceIds, m.edgeIds);
}

/** The body's mesh made of its own shape, as the tool meshed before research/24, which leaves triangulations in it. */
export function meshInPlace(body: Body): { faces: string; edges: string } {
  const hasher = getOC().ReplicadShapeHasher;
  const ids = (shapes: unknown[]) => shapes.map((s) => hasher.HashCode(s as never, 2147483647));
  return meshPrint(shapeOf(body) as unknown as MeshableShape, ids(body.topo.faces), ids(body.topo.edges));
}

/**
 * The B-rep as OCCT writes it, with any triangulation, and its shapes' flags but "Free": OCCT
 * clears that flag on a shape it puts into another ("From now the Component cannot be edited",
 * `TopoDS_Builder::Add`), so on a reused body it also tells which later features of earlier builds
 * shared its shapes. Only adding to such a shape depends on it, which no feature does to its inputs.
 */
export const state = (body: Body): string => unfree(brep(body, true));
const unfree = (text: string) => text.replace(/^[01]([01]{6})$/gm, "_$1");

export interface BodyPrint {
  name: string;
  /** The B-rep as OCCT writes it, with flags but "Free" and any triangulation: the body's whole state (`state`). */
  state: string;
  brep: string;
  faceNames: string;
  edgeNames: string;
  edgeFaces: string;
  faceOps: string;
  owners: string;
  shapers: string;
  mesh?: { faces: string; edges: string };
}

export function bodyPrint(body: Body, mesh: boolean): BodyPrint {
  const t = body.topo;
  const keys = (h: Map<string, unknown>[]) => hash(JSON.stringify(h.map((m) => [...m.keys()].sort())));
  return {
    name: body.name,
    state: hash(state(body)),
    brep: hash(unfree(brep(body))),
    faceNames: keys(t.faceHist),
    edgeNames: keys(t.edgeHist),
    edgeFaces: hash(JSON.stringify(t.edgeFaces)),
    faceOps: hash(JSON.stringify(t.faceOps?.map((s) => [...s].sort()) ?? null)),
    owners: hash(JSON.stringify(owners(body))),
    shapers: hash(JSON.stringify(shapers(body))),
    ...(mesh ? { mesh: meshOf(body) } : {}),
  };
}

const sketchPrint = (s: Sketch) => hash(JSON.stringify([s.name, s.frame, s.profile, s.broken ?? null, s.broken ? null : s.regions.map((r) => [r.filled, r.triangles])]));

export interface EntryPrint {
  name: string;
  type: string;
  line: number | undefined;
  variable: boolean;
  status: string;
  message: string | undefined;
  refs: string;
  warnings: string | undefined;
  names: string | undefined;
  before: string[];
  inputs: string[];
  after: string[];
  results: string[];
  sketches: string[];
  sketch: string | undefined;
  uses: string[];
}

export function entryPrint(t: TraceEntry): EntryPrint {
  return {
    name: t.name,
    type: t.type,
    line: t.line,
    variable: t.variable,
    status: t.status,
    message: t.message,
    refs: JSON.stringify(t.refs),
    warnings: t.warnings && JSON.stringify(t.warnings),
    names: t.names && JSON.stringify(t.names),
    before: t.before.map((b) => b.name),
    inputs: t.inputs.map((b) => b.name),
    after: t.after.map((b) => b.name),
    results: t.results.map((b) => b.name),
    sketches: t.sketches.map(sketchPrint),
    sketch: t.sketch && sketchPrint(t.sketch),
    uses: t.uses,
  };
}

/** A whole build: its trace, every body any entry made, and the meshes of `shown`, the bodies the tool would mesh. */
export function buildPrint(trace: readonly TraceEntry[], shown: readonly Body[]): { entries: EntryPrint[]; bodies: BodyPrint[] } {
  const bodies = [...new Set(trace.flatMap((t) => t.results))];
  return { entries: trace.map(entryPrint), bodies: bodies.map((b) => bodyPrint(b, shown.includes(b))) };
}

/** The differences between two prints, as paths and values, empty if they are the same. */
export function diff(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
}
