/**
 * Reference expressions (research/03, "References in code") and their resolution with S5:
 * history names, with split indices cross-checked by geometry.
 */
import { describe, dist, type Vec } from "./geom.ts";
import { isDescendant, key, lastLevel, piece, printAll, type Name } from "./names.ts";
import type { Kind, Shape } from "./oc.ts";
import { entities, histOf, indexOf, type Topo } from "./topo.ts";

/** Anything with a feature name: a feature result, or the name itself. */
export type FeatureLike = { readonly name: string } | string;

const featureName = (f: FeatureLike) => (typeof f === "string" ? f : f.name);

/** A reference to faces or edges, as written in code. It is resolved against a body by the feature that uses it. */
export class Ref {
  constructor(
    readonly kind: Kind,
    readonly names: readonly Name[],
    /** Centroid of the picked piece, for the geometric cross-check of the last split. */
    readonly near?: Vec,
  ) {}

  /** Piece `k` of this reference after feature `op` split it, e.g. `extrude1.side.front.piece(notch, 2, { near: [54, 0, 10] })`. */
  piece(op: FeatureLike, k: number, hint?: { near?: Vec }): Ref {
    return new Ref(
      this.kind,
      this.names.map((n) => piece(n, featureName(op), k)),
      hint?.near,
    );
  }

  /** The `n`-th of several edges between the same faces. */
  nth(n: number): Ref {
    return new Ref(
      this.kind,
      this.names.map((x) => (x.t === "edge" ? { ...x, n } : x)),
      this.near,
    );
  }

  /** The canonical expression, which is also printed in errors. */
  toString(): string {
    return printAll(this.names, this.near);
  }

  get key(): string {
    return this.names.map(key).sort().join(" | ");
  }
}

const isRef = (x: unknown): x is Ref => x instanceof Ref;

/** The faces a feature named, by feature name; feature results (bodies) are such names too. */
export class Named {
  constructor(readonly name: string) {}

  /** Side faces by sketch segment id: `extrude1.side.front`. */
  get side(): Readonly<Record<string, Ref>> {
    return new Proxy({}, { get: (_, seg) => (typeof seg === "string" ? new Ref("face", [{ t: "side", feature: this.name, seg }]) : undefined) });
  }

  get start(): Ref {
    return new Ref("face", [{ t: "cap", feature: this.name, cap: "start" }]);
  }

  get end(): Ref {
    return new Ref("face", [{ t: "cap", feature: this.name, cap: "end" }]);
  }

  /** The faces a fillet or chamfer created at vertices. */
  get corner(): Ref {
    return new Ref("face", [{ t: "corner", feature: this.name }]);
  }

  /** The face a fillet or chamfer created from `edge`. */
  face(edge: Ref): Ref {
    return new Ref("face", [{ t: "blend", feature: this.name, edge: [...edge.names] }]);
  }
}

/**
 * Features by name, for references to features without a variable, e.g. ones named explicitly in
 * a loop (`ref.rib0.side.foot`), or to a deleted feature, which then reports itself as broken.
 */
export const ref: Readonly<Record<string, Named>> = new Proxy({}, { get: (_, name) => (typeof name === "string" ? new Named(name) : undefined) });

function faceNames(r: Ref): Name[] {
  if (!isRef(r) || r.kind !== "face") throw new TypeError(`edge(): expected face references, got ${String(r)}`);
  return [...r.names];
}

/** The edge between two faces, or the seam of one face. */
export function edge(a: Ref, b?: Ref): Ref {
  const sides = b ? [faceNames(a), faceNames(b)] : [faceNames(a)];
  return new Ref("edge", [{ t: "edge", sides, n: 1 }]);
}

/** Any of several references, e.g. a face that a merge created from two faces. */
export function any(...refs: Ref[]): Ref {
  const first = refs[0];
  if (!first || !refs.every((r) => isRef(r) && r.kind === first.kind)) throw new TypeError("any(): expected references of one kind");
  return new Ref(
    first.kind,
    refs.flatMap((r) => r.names),
  );
}

/** `suggestion`: a likely replacement offered to the user, never applied silently. */
export type Resolution = { ok: Shape[] } | { missing: string; suggestion?: Shape[] } | { ambiguous: Shape[]; why: string; suggestion?: Shape[] };

const centroid = (es: Shape[], kind: Kind): Vec => {
  const cs = es.map((e) => describe(e, kind).centroid);
  return [0, 1, 2].map((i) => cs.reduce((a, c) => a + c[i]!, 0) / cs.length) as unknown as Vec;
};

const named = (t: Topo, kind: Kind, i: number, of: Name) => [...histOf(t, kind, i).values()].some((n) => isDescendant(n, of));

/** Entities grouped by their piece index k at the split level `<parent>.piece(op, k)`, descendants included. */
function splitGroups(t: Topo, kind: Kind, parent: Name, op: string): Map<number, Shape[]> {
  const groups = new Map<number, Shape[]>();
  entities(t, kind).forEach((e, i) => {
    for (let k = 1; k <= 16; k++) if (named(t, kind, i, piece(parent, op, k))) groups.set(k, [...(groups.get(k) ?? []), e]);
  });
  return groups;
}

/**
 * Resolves a reference against a body's topology. `multi`: whether the parameter accepts several
 * entities (fillet edges: yes; a sketch plane: no).
 *
 * The cross-check differs from the benchmark's S5 in what it compares: the code keeps only the
 * picked piece's centroid (`near`), not those of all its siblings, so the check takes the piece
 * nearest to it instead of a one-to-one matching of all pieces.
 */
export function resolve(t: Topo, ref: Ref, multi: boolean): Resolution {
  const { kind } = ref;
  const pool = entities(t, kind);
  const found = pool.filter((_, i) => ref.names.some((w) => named(t, kind, i, w)));
  const nearest = (es: Shape[], to: Vec) => es.reduce((a, b) => (dist(describe(a, kind).centroid, to) <= dist(describe(b, kind).centroid, to) ? a : b));
  let r: Resolution;
  if (found.length === 1 || (found.length > 1 && multi)) r = { ok: found };
  else if (found.length > 1) r = { ambiguous: found, why: `${found.length} entities match ${ref}`, ...(ref.near ? { suggestion: [nearest(found, ref.near)] } : {}) };
  else r = { missing: `nothing matches ${ref}` };

  const level = ref.names.length === 1 ? lastLevel(ref.names[0]!) : undefined;
  if (!level || !ref.near) return r;
  const groups = splitGroups(t, kind, level.parent, level.op);
  // Pieces now present at this split level, or the unsplit parent if the split no longer happens.
  const pieces: Shape[][] = groups.size ? [...groups.values()] : pool.filter((_, i) => named(t, kind, i, level.parent)).map((e) => [e]);
  const near = ref.near;
  const best = pieces.length ? pieces.reduce((a, b) => (dist(centroid(a, kind), near) <= dist(centroid(b, kind), near) ? a : b)) : undefined;
  const sameIndex = best !== undefined && groups.get(level.k) === best;
  if (sameIndex && !("missing" in r)) return r;
  if ("ambiguous" in r && !sameIndex) return r;
  if ("missing" in r) return best ? { missing: r.missing, suggestion: best } : r;
  const candidates = "ok" in r ? r.ok : r.ambiguous;
  const why = `piece ${level.k} of ${level.op} is no longer the one nearest to ${ref.near.map((x) => +x.toFixed(3)).join(", ")}`;
  return best ? { ambiguous: candidates, why, suggestion: best } : { ambiguous: candidates, why };
}

/**
 * A multi-entity reference as a whole: if every part either resolved or only disagrees with
 * geometry, and the name-based and geometric results cover the same entities, a changed piece
 * order doesn't matter.
 */
export function combine(parts: Resolution[]): Resolution | undefined {
  if (!parts.every((p) => "ok" in p || ("ambiguous" in p && p.suggestion))) return undefined;
  const byName = parts.flatMap((p) => ("ok" in p ? p.ok : (p as { ambiguous: Shape[] }).ambiguous));
  const byGeometry = parts.flatMap((p) => ("ok" in p ? p.ok : (p as { suggestion: Shape[] }).suggestion));
  const same = byName.every((x) => byGeometry.some((y) => y.IsSame(x))) && byGeometry.every((x) => byName.some((y) => y.IsSame(x)));
  return same ? { ok: byName.filter((x, i) => byName.findIndex((y) => y.IsSame(x)) === i) } : undefined;
}

/** The reference the GUI writes when the user picks entity `e`: its history names, and the centroid if the name ends in a split. */
export function capture(t: Topo, kind: Kind, e: Shape): Ref {
  const i = indexOf(t, kind, e);
  if (i < 0) throw new Error(`capture: the ${kind} is not part of this body`);
  const names = [...histOf(t, kind, i).values()];
  if (names.length === 0) throw new Error(`${kind} ${i} has no history name (${describe(e, kind).type} at ${describe(e, kind).centroid.map((x) => +x.toFixed(2)).join(", ")})`);
  const split = names.length === 1 && lastLevel(names[0]!) !== undefined;
  return new Ref(kind, names, split ? describe(e, kind).centroid : undefined);
}

/**
 * Resolves the references of one parameter (several for an edge list). It is ok only if every
 * reference resolves, or if they resolve as a whole (`combine`). A suggestion for the whole exists
 * only if every part either resolved or suggested something.
 */
export function resolveAll(t: Topo, refs: Ref[], multi: boolean): { whole: Resolution; parts: Resolution[] } {
  const parts = refs.map((r) => resolve(t, r, multi));
  const combined = parts.length > 1 ? combine(parts) : undefined;
  if (combined) return { whole: combined, parts };
  const failed = parts.find((p) => "ambiguous" in p) ?? parts.find((p) => "missing" in p);
  const unique = (xs: Shape[][]) => xs.flat().filter((e, i, all) => all.findIndex((x) => x.IsSame(e)) === i);
  if (!failed) return { whole: { ok: unique(parts.map((p) => (p as { ok: Shape[] }).ok)) }, parts };
  const pieces = parts.map((p) => ("ok" in p ? p.ok : p.suggestion));
  const { suggestion: _, ...rest } = failed;
  if (pieces.some((x) => !x)) return { whole: rest as Resolution, parts };
  return { whole: { ...rest, suggestion: unique(pieces as Shape[][]) } as Resolution, parts };
}
