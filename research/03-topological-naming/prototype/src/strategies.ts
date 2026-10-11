/**
 * Reference strategies. Each captures a reference to the entities a user picked in the state before
 * a feature, and resolves it against the state before the same feature in an edited model.
 */
import { describe, dist, dot, fmt, parallel, type EdgeInfo, type FaceInfo, type Info, type Vec } from "./geom.ts";
import type { State } from "./model.ts";
import { oc, type Kind, type Shape } from "./oc.ts";

/** `suggestion`: a likely replacement offered to the user for confirmation, never applied silently. */
export type Resolution = { ok: Shape[] } | { missing: string; suggestion?: Shape[] } | { ambiguous: Shape[]; why: string; suggestion?: Shape[] };

/** Whether the consuming parameter accepts several entities (fillet edges: yes; sketch plane: no). */
export interface ResolveOpts {
  multi: boolean;
}

export interface RefStrategy<R = unknown> {
  name: string;
  capture(state: State, kind: Kind, picked: Shape): R;
  resolve(state: State, kind: Kind, ref: R, opts: ResolveOpts): Resolution;
  toCode(ref: R): string;
  /** Explains, in terms of the strategy's own mechanism, why `intended` was (not) found. For failure analysis. */
  explain(state: State, kind: Kind, ref: R, intended: Shape[] | "gone"): string;
}

const entities = (s: State, kind: Kind) => (kind === "face" ? s.faces : s.edges);
const indexOf = (s: State, kind: Kind, e: Shape) => entities(s, kind).findIndex((x) => x.IsSame(e));

// ---------- S0: index ----------

export const indexStrategy: RefStrategy<number> = {
  name: "S0 index",
  capture: (s, kind, e) => indexOf(s, kind, e),
  resolve: (s, kind, i) => {
    const e = entities(s, kind)[i];
    return e ? { ok: [e] } : { missing: `no ${kind} #${i}` };
  },
  toCode: (i) => `[${i}]`,
  explain: (s, kind, i, intended) =>
    intended === "gone" ? `intended entity gone; #${i} ${entities(s, kind)[i] ? "now exists as another entity" : "does not exist"}` : `intended entity is now #${intended.map((e) => indexOf(s, kind, e)).join(",")} (captured #${i})`,
};

// ---------- S1: geometric query ----------

type Pred =
  | { p: "type"; v: string }
  | { p: "facing"; v: Vec } // plane normal (signed)
  | { p: "axis"; v: Vec } // line direction / circle or cylinder axis (unsigned)
  | { p: "inPlane"; v: number } // plane offset along `facing`
  | { p: "radius"; v: number }
  | { p: "onLine"; v: Vec } // a point on the (infinite) line through a linear edge
  | { p: "center"; v: Vec } // circle center
  | { p: "containsPoint"; v: Vec };

const TOL = 1e-4;

function predicatesFor(info: Info, kind: Kind, e: Shape): Pred[] {
  const out: Pred[] = [{ p: "type", v: info.type }];
  if (info.kind === "face") {
    if (info.type === "plane") out.push({ p: "facing", v: info.dir! }, { p: "inPlane", v: info.offset! });
    if (info.type === "cylinder") out.push({ p: "axis", v: info.dir! }, { p: "radius", v: info.radius! });
  } else {
    if (info.type === "line") out.push({ p: "axis", v: info.dir! }, { p: "onLine", v: info.ends[0] });
    if (info.type === "circle") out.push({ p: "axis", v: info.dir! }, { p: "radius", v: info.radius! }, { p: "center", v: info.center! });
  }
  out.push({ p: "containsPoint", v: pointOn(e, kind, info) });
  return out;
}

/** A point on the entity: the edge midpoint, or the face point closest to its centroid. */
function pointOn(e: Shape, kind: Kind, info: Info): Vec {
  if (kind === "edge") {
    const ad = new (oc().BRepAdaptor_Curve)(oc().TopoDS.Edge(e));
    const p = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2);
    return [p.X(), p.Y(), p.Z()];
  }
  const o = oc();
  const c = info.centroid;
  const v = new o.BRepBuilderAPI_MakeVertex(new o.gp_Pnt(c[0], c[1], c[2])).Vertex();
  const d = distance(v, e);
  const p = d.PointOnShape2(1);
  return [p.X(), p.Y(), p.Z()];
}

function distance(a: Shape, b: Shape) {
  const d = new (oc().BRepExtrema_DistShapeShape)();
  d.LoadS1(a);
  d.LoadS2(b);
  d.Perform(new (oc().Message_ProgressRange)());
  return d;
}

function containsPoint(e: Shape, p: Vec): boolean {
  const o = oc();
  const v = new o.BRepBuilderAPI_MakeVertex(new o.gp_Pnt(p[0], p[1], p[2])).Vertex();
  const d = distance(v, e);
  return d.IsDone() && d.Value() < TOL;
}

function holds(pred: Pred, info: Info, e: Shape): boolean {
  switch (pred.p) {
    case "type":
      return info.type === pred.v;
    case "facing":
      return info.kind === "face" && !!info.dir && dot(info.dir, pred.v) > 1 - 1e-6;
    case "axis":
      return !!info.dir && parallel(info.dir, pred.v);
    case "inPlane":
      return info.kind === "face" && info.offset !== undefined && Math.abs(info.offset - pred.v) < TOL;
    case "radius":
      return info.radius !== undefined && Math.abs(info.radius - pred.v) < TOL;
    case "onLine": {
      const ed = info as EdgeInfo;
      if (!ed.dir) return false;
      const d = [pred.v[0] - ed.ends[0][0], pred.v[1] - ed.ends[0][1], pred.v[2] - ed.ends[0][2]] as const;
      const along = dot(d, ed.dir);
      return dist(d, [ed.dir[0] * along, ed.dir[1] * along, ed.dir[2] * along]) < TOL;
    }
    case "center":
      return !!(info as EdgeInfo).center && dist((info as EdgeInfo).center!, pred.v) < TOL;
    case "containsPoint":
      return containsPoint(e, pred.v);
  }
}

function matches(s: State, kind: Kind, preds: Pred[]): Shape[] {
  return entities(s, kind).filter((e) => {
    const info = describe(e, kind);
    return preds.every((p) => holds(p, info, e));
  });
}

/**
 * Like a GUI generating replicad finder code: add predicates in a fixed order (type, orientation,
 * position, contained point) until the pick is unique, and keep that minimal prefix.
 */
export const geometricStrategy: RefStrategy<Pred[]> = {
  name: "S1 geometric",
  capture(s, kind, e) {
    const all = predicatesFor(describe(e, kind), kind, e);
    for (let n = 1; n <= all.length; n++) {
      const preds = all.slice(0, n);
      const m = matches(s, kind, preds);
      if (m.length === 1 && m[0]!.IsSame(e)) return preds;
    }
    return all;
  },
  resolve(s, kind, preds) {
    const m = matches(s, kind, preds);
    if (m.length === 0) return { missing: "no match" };
    if (m.length > 1) return { ambiguous: m, why: `${m.length} matches` };
    return { ok: m };
  },
  explain(s, kind, preds, intended) {
    if (intended === "gone") return `intended entity gone; ${matches(s, kind, preds).length} other entities satisfy all predicates`;
    return intended
      .map((e) => {
        const info = describe(e, kind);
        const failing = preds.filter((p) => !holds(p, info, e)).map((p) => p.p);
        return failing.length ? `intended entity fails ${failing.join(", ")}` : "intended entity satisfies all predicates";
      })
      .join("; ") + `; ${matches(s, kind, preds).length} entities match`;
  },
  toCode: (preds) =>
    preds
      .map((p) => `${p.p}(${typeof p.v === "number" ? +p.v.toFixed(3) : Array.isArray(p.v) ? fmt(p.v as Vec) : JSON.stringify(p.v)})`)
      .join("."),
};

// ---------- S2: lineage ----------

/** The lineage key of an entity: its name set (faces) or the name sets of its adjacent faces (edges). */
function key(s: State, kind: Kind, i: number): string {
  const faceKey = (fi: number) => [...s.faceNames[fi]!].sort().join("+") || "?";
  if (kind === "face") return faceKey(i);
  return s.edgeFaces[i]!.map(faceKey).sort().join(" | ");
}

/** Entities whose key overlaps `k` (a merged face matches any of its names; an unmerged face matches the merged key). */
function sameNamed(s: State, kind: Kind, k: string): Shape[] {
  const parts = (x: string) => (kind === "face" ? [x.split("+")] : x.split(" | ").map((f) => f.split("+")));
  const want = parts(k);
  const overlaps = (a: string[][], b: string[][]) => a.length === b.length && sortedPairs(a, b);
  return entities(s, kind).filter((_, i) => overlaps(parts(key(s, kind, i)), want));
}

/** For edges, adjacent faces must pairwise share a name (in either order); for faces, share a name. */
function sortedPairs(a: string[][], b: string[][]): boolean {
  const share = (x: string[], y: string[]) => x.some((n) => y.includes(n));
  if (a.length === 1) return share(a[0]!, b[0]!);
  return (share(a[0]!, b[0]!) && share(a[1]!, b[1]!)) || (share(a[0]!, b[1]!) && share(a[1]!, b[0]!));
}

export interface LineageRef {
  key: string;
  /** Position among same-named entities at capture time (FreeCAD's "modification index"). */
  index: number;
  siblings: number;
}

export const lineageStrategy: RefStrategy<LineageRef> = {
  name: "S2 lineage",
  capture(s, kind, e) {
    const k = key(s, kind, indexOf(s, kind, e));
    const sib = sameNamed(s, kind, k);
    return { key: k, index: sib.findIndex((x) => x.IsSame(e)), siblings: sib.length };
  },
  resolve(s, kind, ref) {
    const sib = sameNamed(s, kind, ref.key);
    if (sib.length === 0) return { missing: `no ${ref.key}` };
    if (ref.siblings === 1) return sib.length === 1 ? { ok: sib } : { ambiguous: sib, why: `${ref.key} now ${sib.length}×` };
    const pick = sib[ref.index];
    return pick ? { ok: [pick] } : { missing: `${ref.key}#${ref.index} of ${sib.length}` };
  },
  toCode: (r) => `${r.key.includes(" | ") ? "edge" : "face"}(${JSON.stringify(r.key)}${r.siblings > 1 ? `, #${r.index}` : ""})`,
  explain: (s, kind, r, intended) => explainLineage(s, kind, r, intended),
};

function explainLineage(s: State, kind: Kind, r: LineageRef, intended: Shape[] | "gone"): string {
  const sib = sameNamed(s, kind, r.key);
  const now = `${sib.length} entities named ${r.key} (captured ${r.siblings}, picked #${r.index})`;
  if (intended === "gone") return `intended entity gone; ${now}`;
  return `${now}; intended: ${intended.map((e) => `${key(s, kind, indexOf(s, kind, e))} #${sib.findIndex((x) => x.IsSame(e))}`).join(", ")}`;
}

// ---------- S3: hybrid ----------

export interface HybridRef extends LineageRef {
  /** Centroids of all same-named siblings at capture time, in sibling order. */
  centroids: Vec[];
}

export const hybridStrategy: RefStrategy<HybridRef> = {
  name: "S3 hybrid",
  capture(s, kind, e) {
    const base = lineageStrategy.capture(s, kind, e);
    const centroids = sameNamed(s, kind, base.key).map((x) => describe(x, kind).centroid);
    return { ...base, centroids };
  },
  resolve(s, kind, ref) {
    const sib = sameNamed(s, kind, ref.key);
    if (sib.length === 0) return { missing: `no ${ref.key}` };
    if (ref.siblings === 1 && sib.length === 1) return { ok: sib };
    // Match old to new pieces by minimal total centroid displacement.
    const now = sib.map((x) => describe(x, kind).centroid);
    const match = matchPieces(ref.centroids, now);
    const mine = match[ref.index];
    if (sib.length === ref.siblings) return { ok: [sib[mine!]!] };
    // Pieces appeared or vanished: report, and offer the geometric match as a suggestion.
    const why = `${ref.key}: ${ref.siblings} → ${sib.length} pieces`;
    return mine === undefined ? { missing: why } : { ambiguous: sib, why, suggestion: [sib[mine]!] };
  },
  toCode: (r) => `${lineageStrategy.toCode(r)}${r.siblings > 1 ? ` near ${fmt(r.centroids[r.index]!)}` : ""}`,
  explain: (s, kind, r, intended) => explainLineage(s, kind, r, intended),
};

/**
 * match[i] = index in `b` matched to `a[i]` (or undefined if `a[i]` is left over), minimising the
 * total centroid distance over all injective matchings of the smaller set. Exhaustive; n is small.
 */
function matchPieces(a: Vec[], b: Vec[]): (number | undefined)[] {
  if (Math.max(a.length, b.length) > 7) throw new Error("too many pieces for exhaustive matching");
  const swap = a.length > b.length;
  const [small, large] = swap ? [b, a] : [a, b];
  let best: number[] = [];
  let bestCost = Infinity;
  const rec = (i: number, used: boolean[], perm: number[], cost: number) => {
    if (cost >= bestCost) return;
    if (i === small.length) return void ((best = [...perm]), (bestCost = cost));
    for (let j = 0; j < large.length; j++) {
      if (used[j]) continue;
      used[j] = true;
      perm.push(j);
      rec(i + 1, used, perm, cost + dist(small[i]!, large[j]!));
      perm.pop();
      used[j] = false;
    }
  };
  rec(0, [], [], 0);
  if (!swap) return best;
  const out: (number | undefined)[] = a.map(() => undefined);
  best.forEach((ai, bi) => (out[ai] = bi));
  return out;
}

// ---------- S4: history names (FreeCAD-style) ----------

const histOf = (s: State, kind: Kind, i: number) => (kind === "face" ? s.faceHist[i]! : s.edgeHist[i]!);

/**
 * Splits `edge(<faces> | <faces>)~k/op#1/op2#2` into its adjacent face-name sets, the creation index
 * and the split chain. Face names may themselves contain parentheses and `/`.
 */
function parseEdge(n: string): { faces: string[][]; head: string; chain: string } | undefined {
  if (!n.startsWith("edge(")) return undefined;
  let depth = 0;
  for (let i = 4; i < n.length; i++) {
    if (n[i] === "(") depth++;
    else if (n[i] === ")" && --depth === 0) {
      const rest = n.slice(i + 1);
      const slash = rest.indexOf("/");
      const head = slash < 0 ? rest : rest.slice(0, slash);
      return { faces: n.slice(5, i).split(" | ").map((f) => f.split("+")), head, chain: slash < 0 ? "" : rest.slice(slash) };
    }
  }
  return undefined;
}

const share = (a: string[], b: string[]) => a.some((x) => b.includes(x));

/** `name` equals `of` or descends from it through further splits. Edge names match on overlapping face sets (merges). */
function isDescendant(name: string, of: string): boolean {
  if (name === of || name.startsWith(`${of}/`)) return true;
  const [n, o] = [parseEdge(name), parseEdge(of)];
  if (!n || !o || n.faces.length !== o.faces.length || n.head !== o.head) return false;
  const facesMatch =
    n.faces.length === 1 ? share(n.faces[0]!, o.faces[0]!) : (share(n.faces[0]!, o.faces[0]!) && share(n.faces[1]!, o.faces[1]!)) || (share(n.faces[0]!, o.faces[1]!) && share(n.faces[1]!, o.faces[0]!));
  return facesMatch && (n.chain === o.chain || n.chain.startsWith(`${o.chain}/`));
}
/** `a/op#1/op2#2` → `a/op#1` → `a`; edge names also drop a trailing `~k`. */
const parent = (n: string) => {
  const i = n.lastIndexOf("/");
  return i < 0 ? undefined : n.slice(0, i);
};

export const historyStrategy: RefStrategy<string[]> = {
  name: "S4 history",
  capture: (s, kind, e) => [...histOf(s, kind, indexOf(s, kind, e))],
  resolve(s, kind, names, { multi }) {
    const pool = entities(s, kind);
    const descendants = pool.filter((_, i) => [...histOf(s, kind, i)].some((n) => names.some((w) => isDescendant(n, w))));
    if (descendants.length === 1 || (descendants.length > 1 && multi)) return { ok: descendants };
    if (descendants.length > 1) return { ambiguous: descendants, why: `${descendants.length} descendants of ${names.join("+")}` };
    // Not found: the nearest surviving ancestor (e.g. the split was undone) is only a suggestion.
    for (let anc = names.map(parent); anc.some((a) => a); anc = anc.map((a) => (a ? parent(a) : undefined))) {
      const found = pool.filter((_, i) => [...histOf(s, kind, i)].some((n) => anc.includes(n)));
      if (found.length) return { missing: `no ${names.join("+")}`, suggestion: found };
    }
    return { missing: `no ${names.join("+")}` };
  },
  toCode: (names) => `${names.length > 1 ? "any" : ""}(${names.map((n) => JSON.stringify(n)).join(", ")})`,
  explain(s, kind, names, intended) {
    const desc = entities(s, kind).filter((_, i) => [...histOf(s, kind, i)].some((n) => names.some((w) => isDescendant(n, w)))).length;
    const cap = `captured ${names.join("+")}; ${desc} descendants`;
    if (intended === "gone") return `intended entity gone; ${cap}`;
    return `${cap}; intended named ${intended.map((e) => [...histOf(s, kind, indexOf(s, kind, e))].join("+")).join(", ")}`;
  },
};

export const strategies: RefStrategy<any>[] = [indexStrategy, geometricStrategy, lineageStrategy, hybridStrategy, historyStrategy];

export type { FaceInfo };
