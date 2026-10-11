import { describe, fmt, type EdgeInfo, type FaceInfo, type Info } from "./geom.ts";
import { build, type BuiltModel, type Feature, type State } from "./model.ts";
import type { Kind, Shape } from "./oc.ts";
import { strategies, type Resolution, type RefStrategy, type ResolveOpts } from "./strategies.ts";

export type Category =
  | "dimension"
  | "dimension-topology"
  | "flip"
  | "insert-upstream"
  | "delete-upstream"
  | "sketch-segment"
  | "sketch-direction"
  | "reorder"
  | "pattern-count";

export type Expected = number | "gone";

export interface RefSpec<P> {
  /** Reference slot name as used in the model's features. */
  slot: string;
  kind: Kind;
  /** Whether the consuming parameter accepts several entities (fillet/chamfer edges, shell faces). */
  multi: boolean;
  /** What the user *means*, written by hand per model. `"gone"` if the intended entity no longer exists. */
  oracle(s: State, p: P): Shape[] | "gone";
  /** Plain-language intent, for the report. */
  intent: string;
}

export interface Edit<P> {
  name: string;
  category: Category;
  params?: Partial<P>;
  features?(features: Feature[], p: P): Feature[];
  /** Expected oracle result per slot, a sanity check on the oracles themselves. */
  expect: Record<string, Expected>;
  /** Features allowed to fail in this edit (kernel failures that cannot affect scoring), with the reason. */
  allowFailures?: Record<string, string>;
}

export interface Case<P> {
  model: string;
  params: P;
  features(p: P): Feature[];
  refs: RefSpec<P>[];
  baseExpect: Record<string, number>;
  edits: Edit<P>[];
}

export type Score = "correct" | "reported" | "wrong";

export interface Result {
  model: string;
  edit: string;
  category: Category;
  slot: string;
  strategy: string;
  score: Score;
  outcome: string;
  code: string;
  ms: number;
  expected: string;
  got: string;
  /** For reported outcomes with a suggested replacement: is the suggestion what the user meant? */
  suggestion?: "right" | "wrong";
  /** The strategy's own account of the outcome (non-correct cells only). */
  explanation?: string;
  /** Features before the consumer that failed in the edited model (oracle-driven build). */
  upstreamFailures?: string[];
}

/** Resolver that uses the ground truth, so every reference is scored independently of the others. */
const oracleResolver =
  <P>(c: Case<P>, p: P) =>
  (slot: string, s: State) => {
    const r = c.refs.find((x) => x.slot === slot)!.oracle(s, p);
    return r === "gone" ? [] : r;
  };

export function consumerOf(features: Feature[], slot: string): string | undefined {
  return features.find((f) => ("edges" in f && f.edges === slot) || ("faces" in f && f.faces === slot) || ("plane" in f && "onFace" in f.plane && f.plane.onFace === slot))?.id;
}

export function buildCase<P>(c: Case<P>, p: P, features: Feature[]): BuiltModel {
  return build(features, oracleResolver(c, p));
}

export const summarize = (e: Shape, kind: Kind) => short(describe(e, kind));
export function short(i: Info): string {
  return i.kind === "face" ? `${i.type}@${fmt(i.centroid)}` : `${i.type}@${fmt(i.centroid)}`;
}

function score(expected: Shape[] | "gone", r: Resolution): Score {
  if ("ok" in r) {
    if (expected === "gone") return "wrong";
    const same = r.ok.length === expected.length && r.ok.every((x) => expected.some((y) => y.IsSame(x)));
    return same ? "correct" : "wrong";
  }
  return expected === "gone" ? "correct" : "reported";
}

function suggestionScore(expected: Shape[] | "gone", r: Resolution): { suggestion?: "right" | "wrong" } {
  if ("ok" in r || !r.suggestion) return {};
  return { suggestion: score(expected, { ok: r.suggestion }) === "correct" ? "right" : "wrong" };
}

/** Resolves a multi-entity reference: ok only if every captured entity resolves. */
function resolveAll<R>(st: RefStrategy<R>, s: State, kind: Kind, refs: R[], opts: ResolveOpts): Resolution {
  const parts = refs.map((r) => st.resolve(s, kind, r, opts));
  const combined = parts.length > 1 ? st.combine?.(parts) : undefined;
  if (combined) return combined;
  const failed = parts.find((p) => "ambiguous" in p) ?? parts.find((p) => "missing" in p);
  if (failed) {
    // A combined suggestion exists only if every part either resolved or suggested something.
    const pieces = parts.map((p) => ("ok" in p ? p.ok : p.suggestion));
    if (pieces.some((x) => !x)) {
      const { suggestion: _, ...rest } = failed as { suggestion?: Shape[] };
      return rest as Resolution;
    }
    const suggestion: Shape[] = [];
    for (const xs of pieces) for (const e of xs!) if (!suggestion.some((x) => x.IsSame(e))) suggestion.push(e);
    return { ...failed, suggestion } as Resolution;
  }
  const ok: Shape[] = [];
  for (const p of parts) for (const e of (p as { ok: Shape[] }).ok) if (!ok.some((x) => x.IsSame(e))) ok.push(e);
  return { ok };
}

const show = (kind: Kind, r: Shape[] | "gone") => (r === "gone" ? "gone" : r.map((e) => summarize(e, kind)).join(", "));
const outcome = (kind: Kind, r: Resolution) => {
  if ("ok" in r) return `ok: ${show(kind, r.ok)}`;
  const sugg = r.suggestion ? `; suggests ${show(kind, r.suggestion)}` : "";
  return "missing" in r ? `missing (${r.missing}${sugg})` : `ambiguous (${r.why}${sugg})`;
};

export function runCase<P>(c: Case<P>, only?: { edit?: string; slot?: string; strategy?: string }): Result[] {
  const results: Result[] = [];
  const baseFeatures = c.features(c.params);
  const base = buildCase(c, c.params, baseFeatures);
  for (const ref of c.refs) {
    if (only?.slot && only.slot !== ref.slot) continue;
    const consumer = consumerOf(baseFeatures, ref.slot);
    if (!consumer) continue; // slot only used by an edit's inserted feature; not scored
    const s0 = base.before(consumer);
    const picked = ref.oracle(s0, c.params);
    if (picked === "gone") throw new Error(`${c.model}/${ref.slot}: oracle finds nothing in the base model`);
    for (const st of strategies) {
      if (only?.strategy && only.strategy !== st.name) continue;
      const captured = picked.map((e) => st.capture(s0, ref.kind, e));
      const code = captured.map((r) => st.toCode(r)).join(", ");
      for (const edit of c.edits) {
        if (only?.edit && only.edit !== edit.name) continue;
        const p = { ...c.params, ...edit.params } as P;
        const feats = edit.features ? edit.features(c.features(p), p) : c.features(p);
        const consumerNow = consumerOf(feats, ref.slot);
        if (!consumerNow) continue;
        const built = buildCase(c, p, feats);
        const s1 = built.before(consumerNow);
        const upstreamFailures = built.failures.filter((f) => feats.findIndex((x) => x.id === f.feature) < feats.findIndex((x) => x.id === consumerNow));
        const expected = ref.oracle(s1, p);
        const t0 = performance.now();
        const r = resolveAll(st, s1, ref.kind, captured, { multi: ref.multi });
        const ms = performance.now() - t0;
        results.push({
          model: c.model,
          edit: edit.name,
          category: edit.category,
          slot: ref.slot,
          strategy: st.name,
          score: score(expected, r),
          outcome: outcome(ref.kind, r),
          code,
          ms,
          expected: show(ref.kind, expected),
          got: "ok" in r ? show(ref.kind, r.ok) : "-",
          ...suggestionScore(expected, r),
          ...(score(expected, r) !== "correct" ? { explanation: captured.map((c) => st.explain(s1, ref.kind, c, expected)).join(" ‖ ") } : {}),
          ...(upstreamFailures.length ? { upstreamFailures: upstreamFailures.map((f) => `${f.feature}: ${f.error}`) } : {}),
        });
      }
    }
  }
  return results;
}

// ---------- oracle helpers ----------

export const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) < tol;

export function facesWhere(s: State, pred: (i: FaceInfo) => boolean): Shape[] {
  return s.faces.filter((f) => pred(describe(f, "face") as FaceInfo));
}

export function edgesWhere(s: State, pred: (i: EdgeInfo) => boolean): Shape[] {
  return s.edges.filter((e) => pred(describe(e, "edge") as EdgeInfo));
}

/** `"gone"` for an empty result, so oracles read naturally. */
export const orGone = (xs: Shape[]): Shape[] | "gone" => (xs.length ? xs : "gone");
