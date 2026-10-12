/**
 * Topology with history names, ported from research/03's prototype (model.ts). Every operation
 * names the faces and edges of its result from OCCT's Generated/Modified/IsDeleted history.
 */
import { key, piece, type Name } from "./names.ts";
import { listToArray, subShapes, type Kind, type Shape } from "./oc.ts";

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
}

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
  const pool = [...faces, ...edges];
  const assignTo = (targets: Shape[], hists: Hist[]) => (s: Shape, names: Iterable<Name>) => {
    const i = targets.findIndex((x) => x.IsSame(s));
    if (i >= 0) add(hists[i]!, names);
  };
  const follow = (sources: Shape[], hists: Hist[], assign: (s: Shape, names: Iterable<Name>) => void) =>
    sources.forEach((s, i) => {
      // Fillet and chamfer report some untouched edges as deleted although they are still in the
      // result (research/03, kernel findings). Presence in the result wins.
      if (h.IsDeleted(s) && !pool.some((x) => x.IsSame(s))) return;
      const names = [...hists[i]!.values()];
      const mods = listToArray(h.Modified(s));
      if (mods.length === 0) assign(s, names);
      else if (mods.length === 1) assign(mods[0]!, names);
      else mods.forEach((m, k) => assign(m, names.map((n) => piece(n, op, k + 1))));
    });

  for (const input of inputs) {
    follow(input.faces, input.faceHist, assignTo(faces, faceHist));
    follow(input.edges, input.edgeHist, assignTo(edges, edgeHist));
  }
  for (const g of generators) for (const s of listToArray(h.Generated(g.from))) assignTo(faces, faceHist)(s, [g.name]);
  namingTime.ms += performance.now() - t0;
  return withTopology(result, faces, faceHist, edges, edgeHist);
}

/** Completes a topology: adjacency, and names for edges without history (by their adjacent faces). */
export function withTopology(shape: Shape, faces: Shape[], faceHist: Hist[], edges = subShapes(shape, "edge"), edgeHist: Hist[] = edges.map(() => new Map())): Topo {
  const t0 = performance.now();
  const edgeFaces = edges.map(() => [] as number[]);
  faces.forEach((f, fi) => {
    for (const e of subShapes(f, "edge")) {
      const ei = edges.findIndex((x) => x.IsSame(e));
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
