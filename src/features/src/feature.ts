/**
 * Feature types (research/02, "Feature types"): a build function wrapped with a parameter schema
 * and metadata. Calling a feature runs it, records it in the current build's trace and names it.
 */
import { cast, type AnyShape } from "replicad";
import { refForm, setFeaturePrinter, type Vec } from "./names.ts";
import type { Kind, Shape } from "./oc.ts";
import { capture, Named, Ref, resolveAll } from "./refs.ts";
import { entities, indexOf, namingTime, type Topo } from "./topo.ts";

import type { ParamSpec } from "./schema.ts";

/** Second argument of every feature call. The tool injects it in memory from the variable name (research/03). */
export interface FeatureMeta {
  name?: string;
  /** 1-based source line of the call. */
  line?: number;
  /** Whether `name` is a variable in scope, so references can be printed with it. */
  variable?: boolean;
  /** The variables a destructured result is declared as (`const [left, right] = body(…)`), which name its bodies. */
  names?: string[];
}

// ---------- bodies ----------

/**
 * A solid with history names. `shape` is the replicad shape, so a model can return a body to
 * replicad-evaluator directly (it treats any object with a `shape` as a `{ shape, name }` entry).
 * As a `Named`, a body also gives references to its feature's faces (`extrude1.side.front`).
 */
export class Body extends Named {
  readonly shape: AnyShape;
  declare readonly topo: Topo;

  constructor(name: string, topo: Topo) {
    super(name);
    this.shape = cast(topo.shape);
    // Not enumerable: replicad-evaluator spreads a returned body into its shape config.
    Object.defineProperty(this, "topo", { value: topo, enumerable: false });
  }
}

/** A planar sketch: a frame and a closed profile with named segments. */
export class Sketch {
  constructor(
    readonly name: string,
    readonly frame: Frame,
    readonly profile: Profile,
    /** Why the sketch could not be placed, e.g. a broken plane reference. Features using it fail. */
    readonly broken?: string,
  ) {}
}

export interface Frame {
  origin: Vec;
  normal: Vec;
  xDir: Vec;
}

/** A sketch's profile as a closed polyline in world coordinates, e.g. for a preview; circles are sampled. */
export function outline(sketch: Sketch, samples = 48): [number, number, number][] {
  const { origin, normal, xDir } = sketch.frame;
  const yDir: Vec = [normal[1] * xDir[2] - normal[2] * xDir[1], normal[2] * xDir[0] - normal[0] * xDir[2], normal[0] * xDir[1] - normal[1] * xDir[0]];
  const to3 = (x: number, y: number): [number, number, number] => [0, 1, 2].map((i) => origin[i]! + xDir[i]! * x + yDir[i]! * y) as [number, number, number];
  const p = sketch.profile;
  if (p.kind === "polygon") return p.points.map(([x, y]) => to3(x, y));
  return Array.from({ length: samples }, (_, i) => {
    const a = (2 * Math.PI * i) / samples;
    return to3(p.center[0] + p.radius * Math.cos(a), p.center[1] + p.radius * Math.sin(a));
  });
}

export type Profile =
  /** Segment `ids[i]` runs from `points[i]` to the next point. */
  | { kind: "polygon"; points: [number, number][]; ids: string[] }
  | { kind: "circle"; center: [number, number]; radius: number; id: string };

// ---------- build context and trace ----------

export interface RefDiagnostic {
  param: string;
  /** The body the reference was resolved against. */
  body: string;
  kind: Kind;
  /** Indices of the entities it resolved to, in the body's face or edge order. */
  matches: number[];
  /** Position in an array parameter. */
  index?: number;
  code: string;
  status: "ok" | "missing" | "ambiguous";
  message?: string;
  /** Replacement code, offered to the user. */
  suggestion?: string;
}

export interface TraceEntry {
  name: string;
  type: string;
  line?: number;
  variable: boolean;
  status: "ok" | "broken" | "failed";
  message?: string;
  refs: RefDiagnostic[];
  /** Bodies visible before this feature ran (the rollback state for picking). */
  before: Body[];
  /** The feature's result, if it is a body; the first of several bodies. */
  result?: Body;
  /** All bodies the feature made, e.g. several adopted with `body()`. */
  results: Body[];
  /** Bodies visible after this feature ran. */
  after: Body[];
  /** The variables its bodies are declared as, if several. */
  names?: string[];
  /** The feature's result, if it is a sketch. */
  sketch?: Sketch;
  /** Milliseconds the feature took, and how many of them went into naming its result's faces and edges. */
  ms: number;
  namingMs: number;
}

interface BuildContext {
  /** Lenient: a failing feature passes its input through and is reported, as in a CAD timeline. Strict: it throws. */
  lenient: boolean;
  trace: TraceEntry[];
  /** Bodies not consumed by a later feature, in creation order. */
  live: Body[];
  counts: Map<string, number>;
}

const newContext = (lenient: boolean): BuildContext => ({ lenient, trace: [], live: [], counts: new Map() });

let context = newContext(false);

/** Starts a build: resets names and the trace. The tool calls it before every evaluation. */
export function beginBuild(options: { lenient: boolean }): void {
  context = newContext(options.lenient);
  setFeaturePrinter((feature) => (context.trace.some((t) => t.variable && (t.name === feature || t.names?.includes(feature))) ? feature : refForm(feature)));
}

export function currentTrace(): readonly TraceEntry[] {
  return context.trace;
}

export function liveBodies(): readonly Body[] {
  return context.live;
}

export class FeatureError extends Error {
  constructor(
    message: string,
    readonly refs: RefDiagnostic[] = [],
  ) {
    super(message);
  }
}

/** What a feature's build function gets besides its parameters. */
export interface FeatureContext {
  name: string;
  /** Resolves a reference parameter against a body, recording its status; throws a FeatureError if it is broken. */
  resolve(body: Body, param: string, refs: Ref | Ref[], multi: boolean): Shape[];
}

const suggestionCode = (topo: Topo, kind: Kind, shapes: Shape[]) => shapes.map((s) => String(capture(topo, kind, s))).join(", ");

function makeContext(name: string, diagnostics: RefDiagnostic[]): FeatureContext {
  return {
    name,
    resolve(body, param, input, multi) {
      const topo = body.topo;
      const list = Array.isArray(input) ? input : [input];
      const invalid = list.findIndex((r) => !(r instanceof Ref));
      if (invalid >= 0) {
        const code = String(list[invalid]);
        const at = Array.isArray(input) ? { index: invalid } : {};
        diagnostics.push({ param, body: body.name, kind: "face", matches: [], ...at, code, status: "missing", message: `${param}: ${code} is not a reference` });
        throw new FeatureError(`${param}: ${code} is not a reference`, diagnostics);
      }
      const { whole, parts } = resolveAll(topo, list, multi);
      parts.forEach((r, index) => {
        const ok = "ok" in whole || "ok" in r;
        const kind = list[index]!.kind;
        const matches = ("ok" in r ? r.ok : "ambiguous" in r ? r.ambiguous : []).map((e) => indexOf(topo, kind, e));
        const status = ok ? "ok" : "missing" in r ? "missing" : "ambiguous";
        const d: RefDiagnostic = { param, body: body.name, kind, matches, ...(Array.isArray(input) ? { index } : {}), code: String(list[index]), status };
        if (!ok && !("ok" in r)) {
          d.message = "missing" in r ? r.missing : r.why;
          if (r.suggestion) d.suggestion = suggestionCode(topo, kind, r.suggestion);
        }
        diagnostics.push(d);
      });
      if ("ok" in whole) return whole.ok;
      throw new FeatureError(diagnostics.filter((d) => d.param === param && d.message).map((d) => d.message).join("; "), diagnostics);
    },
  };
}

export interface FeatureDefinition<P extends Record<string, unknown>, R> {
  /** Function name in code, e.g. "extrude". */
  type: string;
  label: string;
  icon: string;
  params: { [K in keyof P]-?: ParamSpec };
  /** Bodies this call consumes; one of them is passed through when the feature fails in a lenient build. */
  inputs?(params: P): (Body | undefined)[];
  /** The result in a lenient build when the feature fails and has no input body to pass through. */
  fallback?(params: P, name: string, message: string, meta: FeatureMeta): R;
  build(params: P, ctx: FeatureContext, meta: FeatureMeta): R;
}

export type Feature<P extends Record<string, unknown>, R> = ((params: P, meta?: FeatureMeta) => R) & { readonly definition: FeatureDefinition<P, R> };

export function defineFeature<P extends Record<string, unknown>, R extends Body | Sketch | Body[]>(def: FeatureDefinition<P, R>): Feature<P, R> {
  const call = (params: P, meta: FeatureMeta = {}): R => {
    const count = (context.counts.get(def.type) ?? 0) + 1;
    context.counts.set(def.type, count);
    const name = meta.name ?? `${def.type}${meta.line !== undefined ? `@L${meta.line}` : ""}#${count}`;
    const entry: TraceEntry = { name, type: def.type, variable: meta.variable ?? false, status: "ok", refs: [], before: [...context.live], results: [], after: [], ms: 0, namingMs: 0 };
    if (meta.line !== undefined) entry.line = meta.line;
    if (meta.names) entry.names = meta.names;
    context.trace.push(entry);
    const inputs = (def.inputs?.(params) ?? []).filter((b): b is Body => b instanceof Body);
    const t0 = performance.now();
    const naming0 = namingTime.ms;
    const timed = () => {
      entry.ms = performance.now() - t0;
      entry.namingMs = namingTime.ms - naming0;
    };
    let result: R;
    try {
      result = def.build(params, makeContext(name, entry.refs), meta);
      timed();
    } catch (error) {
      timed();
      entry.status = error instanceof FeatureError && error.refs.some((r) => r.status !== "ok") ? "broken" : "failed";
      entry.message = error instanceof Error ? error.message : String(error);
      const passThrough = inputs[0] ?? def.fallback?.(params, name, entry.message, meta);
      entry.after = [...context.live];
      if (!context.lenient || !passThrough) throw error;
      return passThrough as R;
    }
    if (result instanceof Sketch) entry.sketch = result;
    const bodies = Array.isArray(result) ? result : result instanceof Body ? [result] : [];
    if (bodies.length > 0) {
      entry.result = bodies[0];
      entry.results = bodies;
      context.live = [...context.live.filter((b) => !inputs.includes(b)), ...bodies];
    }
    entry.after = [...context.live];
    return result;
  };
  return Object.assign(call, { definition: def });
}

/** The index of `e` in a body, for picking. */
export function entityIndex(b: Body, kind: Kind, e: Shape): number {
  return indexOf(b.topo, kind, e);
}

/** The reference the GUI writes for entity `index` of body `b`. */
export function pick(b: Body, kind: Kind, index: number): Ref {
  const e = entities(b.topo, kind)[index];
  if (!e) throw new Error(`pick: ${b.name} has no ${kind} ${index}`);
  return capture(b.topo, kind, e);
}
