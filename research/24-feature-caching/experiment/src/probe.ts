/**
 * What a cache has to rely on (research/24, "Bodies don't change"), probed with the library's OCCT:
 * 1. a build without cache gives the same result every time, in other heap states too;
 * 2. a boolean changes its arguments, unless it is non-destructive, as the library's are now;
 * 3. what non-destructive booleans change in the library's results, over research/17's sweep;
 * 4. meshing a body writes into its shapes, and meshing a copy doesn't, and gives the same mesh;
 * 5. a prism changes the face it sweeps, so that the next prism of it differs, unless it sweeps a copy.
 *
 * `node --experimental-transform-types src/probe.ts`
 */
import { getOC, setOC } from "replicad";
import init from "replicad-opencascadejs";
import { Body, circle, extrude, plane, rect, sketch } from "@patchwork-cad/features";
import { beginBuild, currentTrace, type TraceEntry } from "@patchwork-cad/features/runtime";
import { key } from "../../../../src/features/src/names.ts";
import { describe } from "../../../../src/features/src/geom.ts";
import { subShapes } from "../../../../src/features/src/oc.ts";
import { brep, buildPrint, diff, meshInPlace } from "./fingerprint.ts";
import { models, returnedBodies, type Model, type Params } from "./models.ts";

setOC(await init());
const oc = getOC();
const isBody = (v: unknown): v is Body => v instanceof Body;

function build(m: Model, p: Params): { trace: TraceEntry[]; shown: Body[] } {
  beginBuild({ lenient: true });
  const value = m.main({ ...m.defaults, ...p });
  return { trace: [...currentTrace()], shown: returnedBodies(value, isBody) };
}

const cases: [Model, Params][] = [
  [models.m1, {}],
  [models.m3, { ribs: [15, 30, 45] }],
  [models.m4, {}],
  [models.plate, {}],
  [models.plate, { combine: true }],
];
const label = (m: Model, p: Params) => `${m.name}${Object.keys(p).length ? ` ${JSON.stringify(p)}` : ""}`;

/** The sweep's variants (research/17) without its rib lists, and both plates. */
function sweep(): [Model, Params][] {
  const out: [Model, Params][] = [];
  for (const m of [models.m1, models.m3, models.m4]) {
    out.push([m, {}]);
    for (const [k, v] of Object.entries(m.defaults)) if (typeof v === "number") for (const f of [0.25, 0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2, 3]) out.push([m, { [k]: +(v * f).toFixed(3) }]);
  }
  return [...out, [models.plate, {}], [models.plate, { combine: true }]];
}

console.log("1. Builds without cache, four times each, the last two with other shapes made in between");
for (const [m, p] of cases) {
  const kept: Body[] = [];
  const prints = [0, 1, 2, 3].map((i) => {
    if (i >= 2) for (let k = 0; k < 3 * i; k++) kept.push(extrude({ sketch: sketch({ plane: plane("XY"), profile: circle({ center: [k, i], radius: 1 + k }) }), distance: 1 + i }));
    const { trace, shown } = build(m, p);
    return buildPrint(trace, shown);
  });
  const differences = prints.slice(1).flatMap((x) => diff(prints[0], x));
  console.log(`  ${label(m, p)}: ${differences.length ? `${differences.length} differences, e.g. ${differences.slice(0, 3).join("; ")}` : "identical"}`);
}

/**
 * Makes the library's booleans destructive, as OCCT's are by default, while `f` runs: the classes it
 * constructs through `oc()` make instances whose `SetNonDestructive(true)` sets false. (Replacing the
 * prototype's method breaks embind's dispatcher, which looks itself up on the prototype.)
 */
function destructive<T>(f: () => T): T {
  type Algo = { SetNonDestructive(flag: boolean): void };
  const names = ["BRepAlgoAPI_Fuse", "BRepAlgoAPI_Cut", "BRepAlgoAPI_Common", "BRepAlgoAPI_BuilderAlgo"] as const;
  const instance = oc as unknown as Record<string, new (...args: unknown[]) => Algo>;
  const saved = names.map((n) => instance[n]!);
  names.forEach((n, i) => {
    const Real = saved[i]!;
    instance[n] = function (...args: unknown[]) {
      const algo = new Real(...args);
      algo.SetNonDestructive = (flag: boolean) => void Real.prototype.SetNonDestructive.call(algo, flag && false);
      return algo;
    } as unknown as new (...args: unknown[]) => Algo;
  });
  try {
    return f();
  } finally {
    names.forEach((n, i) => (instance[n] = saved[i]!));
  }
}

console.log("2. Bodies that later features of the same build changed, with destructive and with non-destructive booleans");
for (const [m, p] of cases) {
  const count = () => {
    const made = new Map<Body, string>();
    beginBuild({ lenient: true, onFeature: (t, done) => done && t.results.forEach((b) => made.set(b, brep(b, true))) });
    m.main({ ...m.defaults, ...p });
    return `${[...made].filter(([b, text]) => brep(b, true) !== text).length} of ${made.size}`;
  };
  console.log(`  ${label(m, p)}: destructive ${destructive(count)}, non-destructive ${count()}`);
}

console.log("3. Non-destructive against destructive booleans, over the sweep: faces and edges by names, centroid, area and the features that changed them");
{
  let reordered = 0;
  let same = 0;
  const other: string[] = [];
  for (const [m, p] of sweep()) {
    const facesOf = () => {
      const { trace } = build(m, p);
      return trace.map((t) => ({
        status: t.status,
        refs: t.refs.map((r) => [r.code, r.status, r.matches.length]),
        bodies: t.results.map((b) => ({
          faces: b.topo.faces.map((f, i) => {
            const d = describe(f, "face") as { centroid: readonly number[]; area: number };
            return `${[...b.topo.faceHist[i]!.values()].map(key).sort().join("|")} @${d.centroid.map((x) => x.toFixed(4))} ${d.area.toFixed(4)}`;
          }),
          ops: b.topo.faces.map((_, i) => [...(b.topo.faceOps?.[i] ?? [])].sort().join(",")),
          edges: b.topo.edges.map((_, i) => [...b.topo.edgeHist[i]!.values()].map(key).sort().join("|")),
        })),
      }));
    };
    const a = destructive(facesOf);
    const b = facesOf();
    const sorted = (x: typeof a, ops: boolean) => JSON.stringify(x.map((t) => ({ ...t, bodies: t.bodies.map((y) => ({ faces: y.faces.map((f, i) => `${f}${ops ? ` ${y.ops[i]}` : ""}`).sort(), edges: [...y.edges].sort() })) })));
    if (JSON.stringify(a) === JSON.stringify(b)) same++;
    else if (sorted(a, false) !== sorted(b, false)) other.push(label(m, p));
    else {
      reordered++;
      if (sorted(a, true) !== sorted(b, true)) other.push(`${label(m, p)} (faceOps only)`);
    }
  }
  const opsOnly = other.filter((o) => o.endsWith("(faceOps only)")).length;
  console.log(`  ${same + reordered + other.length - opsOnly} builds: ${same} the same, ${reordered} with the same faces and edges in another order, ${other.length - opsOnly} with other faces, edges, statuses or references; faceOps differ in ${opsOnly}, e.g. ${other.slice(0, 3).join(", ")}`);
}

console.log("4. Meshing a body, as the tool did, against meshing a copy, as it does now");
for (const [m, p] of cases.slice(0, 3)) {
  const { trace } = build(m, p);
  let changed = 0;
  let same = 0;
  const bodies = trace.flatMap((t) => t.results).filter((b) => b.topo.faces.length);
  for (const b of bodies) {
    const before = brep(b, true);
    const copy = new oc.BRepBuilderAPI_Transform(b.topo.shape, new oc.gp_Trsf(), true, false).Shape();
    const ofCopy = meshInPlace(new Body(b.name, { ...b.topo, shape: copy, faces: subShapes(copy, "face"), edges: subShapes(copy, "edge") }));
    const untouched = brep(b, true) === before;
    const ofBody = meshInPlace(b);
    if (JSON.stringify(ofCopy) === JSON.stringify(ofBody) && untouched) same++;
    if (brep(b, true) !== before) changed++;
  }
  console.log(`  ${label(m, p)}: meshing changed ${changed} of ${bodies.length} bodies; a copy gave the same mesh and left the body as it was for ${same}`);
}

console.log("5. Three prisms of one sketch face, of the face itself and of copies of it: locations in each prism's B-rep");
beginBuild({ lenient: true });
for (const profile of [rect({ from: [0, 0], to: [10, 10] }), circle({ center: [0, 0], radius: 3 })]) {
  const face = sketch({ plane: plane("XY"), profile }).regions[0]!.face;
  const prism = (base: typeof face) => new oc.BRepPrimAPI_MakePrism(base, new oc.gp_Vec(0, 0, 3), false, true).Shape();
  const locations = (s: typeof face) => oc.BRepToolsWrapper.Write(s).split("\n")[2];
  const copy = (s: typeof face) => new oc.BRepBuilderAPI_Transform(s, new oc.gp_Trsf(), true, false).Shape();
  console.log(`  ${profile.kind}: the face ${[1, 2, 3].map(() => locations(prism(face))).join(", ")}; copies ${[1, 2, 3].map(() => locations(prism(copy(face)))).join(", ")}`);
}
