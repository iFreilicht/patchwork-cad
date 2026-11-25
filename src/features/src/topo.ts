/**
 * Topology with history names, ported from research/03's prototype (model.ts). Every operation
 * names the faces and edges of its result from OCCT's Generated/Modified/IsDeleted history.
 */
import { copied, key, owningFeatures, piece, type Name } from "./names.ts";
import { listToArray, ShapeIndex, subShapes, type Kind, type Shape } from "./oc.ts";

/** Names of one entity by key. A face carries several after a merge. */
export type Hist = Map<string, Name>;

export interface Topo {
  shape: Shape;
  faces: Shape[];
  edges: Shape[];
  faceHist: Hist[];
  edgeHist: Hist[];
  /** For each edge, the indices of its adjacent faces (1 for seams, 2 normally). */
  edgeFaces: number[][];
  /**
   * For each face, the features that created or changed it along its history: also those that only
   * modified it, e.g. a cut that made a hole in it, which its names don't tell (research/23, "The
   * view"). Missing for a body without history, e.g. one adopted with `body()`.
   */
  faceOps?: ReadonlySet<string>[];
}

/** The features that created or changed face `i` of `t` (`Topo.faceOps`), else those its names tell. */
export const opsOf = (t: Topo, i: number): ReadonlySet<string> => t.faceOps?.[i] ?? new Set([...t.faceHist[i]!.values()].flatMap(owningFeatures));

export interface History {
  Generated(s: Shape): { Size(): number; First(): Shape; RemoveFirst(): void };
  Modified(s: Shape): { Size(): number; First(): Shape; RemoveFirst(): void };
  IsDeleted(s: Shape): boolean;
}

/** Milliseconds spent naming since the counter was last reset, for measuring the naming overhead. */
export const namingTime = { ms: 0 };

export const entities = (t: Topo, kind: Kind) => (kind === "face" ? t.faces : t.edges);
export const histOf = (t: Topo, kind: Kind, i: number) => (kind === "face" ? t.faceHist[i]! : t.edgeHist[i]!);
export const indexOf = (t: Topo, kind: Kind, e: Shape) => entities(t, kind).findIndex((x) => x.IsSame(e));

const add = (h: Hist, names: Iterable<Name>) => {
  for (const n of names) h.set(key(n), n);
};

/**
 * Names the entities of `result`: entities of the inputs keep their names (through Modified, or
 * unchanged), and faces generated from `generators` get the generator's name. An entity reachable
 * from several sources (merge) gets all their names. An input entity modified into several pieces
 * names each piece `<name>.piece(op, k)`.
 */
export function propagate(h: History, inputs: Topo[], generators: { from: Shape; name: Name }[], result: Shape, op: string): Topo {
  const t0 = performance.now();
  const faces = subShapes(result, "face");
  const edges = subShapes(result, "edge");
  const faceHist: Hist[] = faces.map(() => new Map());
  const edgeHist: Hist[] = edges.map(() => new Map());
  const pool = new ShapeIndex([...faces, ...edges]);
  const faceIndex = new ShapeIndex(faces);
  const edgeIndex = new ShapeIndex(edges);
  const faceOps: (ReadonlySet<string> | undefined)[] = faces.map(() => undefined);
  const assignTo = (targets: ShapeIndex, hists: Hist[]) => (s: Shape, names: Iterable<Name>) => {
    const i = targets.indexOf(s);
    if (i >= 0) add(hists[i]!, names);
  };
  /** Face `s` of the result came from a face with `ops`, changed by this operation or not; a merge unites them. */
  const opsTo = (s: Shape, ops: ReadonlySet<string>, changed: boolean) => {
    const i = faceIndex.indexOf(s);
    if (i < 0) return;
    const next = changed ? new Set(ops).add(op) : ops;
    const prev = faceOps[i];
    faceOps[i] = prev && prev !== next ? new Set([...prev, ...next]) : next;
  };
  const follow = (sources: Shape[], hists: Hist[], assign: (s: Shape, names: Iterable<Name>) => void, ops?: (i: number) => ReadonlySet<string>) =>
    sources.forEach((s, i) => {
      // Fillet and chamfer report some untouched edges as deleted although they are still in the
      // result (research/03, kernel findings). Presence in the result wins.
      if (h.IsDeleted(s) && pool.indexOf(s) < 0) return;
      const names = [...hists[i]!.values()];
      const mods = listToArray(h.Modified(s));
      if (mods.length === 0) assign(s, names);
      else if (mods.length === 1) assign(mods[0]!, names);
      else mods.forEach((m, k) => assign(m, names.map((n) => piece(n, op, k + 1))));
      if (ops) for (const m of mods.length ? mods : [s]) opsTo(m, ops(i), mods.length > 0);
    });

  for (const input of inputs) {
    follow(input.faces, input.faceHist, assignTo(faceIndex, faceHist), (i) => opsOf(input, i));
    follow(input.edges, input.edgeHist, assignTo(edgeIndex, edgeHist));
  }
  for (const g of generators) for (const s of listToArray(h.Generated(g.from))) assignTo(faceIndex, faceHist)(s, [g.name]);
  const created = new Set([op]);
  const ops = faceOps.map((o) => o ?? created);
  namingTime.ms += performance.now() - t0;
  return { ...withTopology(result, faces, faceHist, edges, edgeHist), faceOps: ops };
}

/** Completes a topology: adjacency, and names for edges without history (by their adjacent faces). */
/** The topology of a copy that copy `by` makes of `t`: its entities named by `by` and their names (`copied`). */
export function copyOf(t: Topo, by: string): Topo {
  const rename = (h: Hist): Hist => new Map([...h.values()].map((n) => copied(n, by)).map((n) => [key(n), n]));
  return { ...t, faceHist: t.faceHist.map(rename), edgeHist: t.edgeHist.map(rename), faceOps: t.faces.map((_, i) => new Set(opsOf(t, i)).add(by)) };
}

export function withTopology(shape: Shape, faces: Shape[], faceHist: Hist[], edges = subShapes(shape, "edge"), edgeHist: Hist[] = edges.map(() => new Map())): Topo {
  const t0 = performance.now();
  const edgeFaces = edges.map(() => [] as number[]);
  const edgeIndex = new ShapeIndex(edges);
  faces.forEach((f, fi) => {
    for (const e of subShapes(f, "edge")) {
      const ei = edgeIndex.indexOf(e);
      if (ei >= 0 && !edgeFaces[ei]!.includes(fi)) edgeFaces[ei]!.push(fi);
    }
  });
  const seen = new Map<string, number>();
  edges.forEach((_, i) => {
    if (edgeHist[i]!.size > 0) return;
    const sides = edgeFaces[i]!.map((fi) => [...faceHist[fi]!.values()]);
    const sideKey = edgeFaces[i]!.map((fi) => [...faceHist[fi]!.keys()].sort().join("+")).sort().join(" | ");
    const n = (seen.get(sideKey) ?? 0) + 1;
    seen.set(sideKey, n);
    add(edgeHist[i]!, [{ t: "edge", sides, n }]);
  });
  namingTime.ms += performance.now() - t0;
  return { shape, faces, faceHist, edges, edgeHist, edgeFaces };
}
