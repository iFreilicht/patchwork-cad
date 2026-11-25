/**
 * Feature types (research/02, "Feature types"): a build function wrapped with a parameter schema
 * and metadata. Calling a feature runs it, records it in the current build's trace and names it.
 */
import { cast, type AnyShape } from "replicad";
import { refForm, setFeaturePrinter, type Vec } from "./names.ts";
import type { Kind, Shape } from "./oc.ts";
import { capture, Named, Ref, resolveAll } from "./refs.ts";
import { entities, indexOf, namingTime, type Topo } from "./topo.ts";
import { arrange, extentOf, RegionRef, regionCode, regionRef, resolveRegion, samplePath, type Arrangement, type Fill, type Frame, type Path, type Region } from "./profile.ts";

import type { ParamSpec } from "./schema.ts";

/** Second argument of every feature call. The tool injects it in memory from the variable name (research/03). */
export interface FeatureMeta {
  name?: string;
  /** 1-based source line of the call. */
  line?: number;
  /** Whether `name` is a variable in scope, so references can be printed with it. */
  variable?: boolean;
  /** The variables a destructured result is declared as, by key (`const { base, lid: top } = body(…)`), which name its bodies. */
  destructured?: Record<string, string>;
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

/** Each sketch's regions, computed when they are first asked for. */
const arrangements = new WeakMap<Sketch, Arrangement>();

/**
 * A planar sketch: a frame and a profile of paths with named segments. The regions its curves
 * enclose are what an extrusion extrudes (research/21, "Sketch from a drawing"): `region(…)` names
 * one by the closed paths it lies inside, `filled` every region a fill covers.
 */
export class Sketch {
  constructor(
    readonly name: string,
    readonly frame: Frame,
    readonly profile: Profile,
    /** Why the sketch could not be placed, e.g. a broken plane reference. Features using it fail. */
    readonly broken?: string,
  ) {}

  /** The regions of the plane that its curves split, bounded on every side, and the pieces of the curves. */
  get arrangement(): Arrangement {
    let a = arrangements.get(this);
    if (!a) {
      const { paths, fills } = pathsOf(this.profile);
      a = arrange(paths, fills, this.frame);
      arrangements.set(this, a);
    }
    return a;
  }

  get regions(): readonly Region[] {
    return this.arrangement.regions;
  }

  /** The region inside the loops with these ids and no other, e.g. `region("a", "b")`; `{ near: [x, y] }` last tells several such apart. */
  region(...args: (string | { near: [number, number] })[]): RegionRef {
    return regionRef(this.name, args);
  }

  /** Every region that a fill of the profile covers, e.g. the letters of a text without their holes. */
  get filled(): RegionRef {
    return new RegionRef(this.name, "filled");
  }
}

export type { Frame };

/** A profile's paths, and what is filled: a rectangle, circle or polygon is one filled loop. */
export function pathsOf(p: Profile): { paths: Path[]; fills: Fill[] } {
  if (p.kind === "paths") return { paths: p.paths, fills: p.fills };
  if (p.kind === "circle") {
    const [cx, cy] = p.center;
    const path: Path = { id: "circle", start: [cx + p.radius, cy], closed: true, segments: [{ id: p.id, curve: { kind: "arc", center: p.center, u: [p.radius, 0], v: [0, p.radius], from: 0, to: 2 * Math.PI } }] };
    return { paths: [path], fills: [{ loops: ["circle"], rule: "nonzero" }] };
  }
  const n = p.points.length;
  const path: Path = { id: "polygon", start: p.points[0] ?? [0, 0], closed: true, segments: p.points.map((_, i) => ({ id: p.ids[i]!, curve: { kind: "line", to: p.points[(i + 1) % n]! } })) };
  return { paths: [path], fills: [{ loops: ["polygon"], rule: "nonzero" }] };
}

/** A sketch's paths as polylines in world coordinates, e.g. for a preview; curves are sampled. */
export function outline(sketch: Sketch): { points: [number, number, number][]; closed: boolean }[] {
  const { origin, normal, xDir } = sketch.frame;
  const yDir: Vec = [normal[1] * xDir[2] - normal[2] * xDir[1], normal[2] * xDir[0] - normal[0] * xDir[2], normal[0] * xDir[1] - normal[1] * xDir[0]];
  const to3 = ([x, y]: [number, number]): [number, number, number] => [0, 1, 2].map((i) => origin[i]! + xDir[i]! * x + yDir[i]! * y) as [number, number, number];
  const { paths } = pathsOf(sketch.profile);
  const extent = extentOf(paths);
  const size = extent ? Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1]) : 1;
  return paths.map((p) => {
    const points = samplePath(p, size / 1000).map(to3);
    // A closed path's last point is its first.
    return { points: p.closed ? points.slice(0, -1) : points, closed: p.closed };
  });
}

/** The code that names region `index` of a sketch, e.g. for a pick in the view. */
export const pickRegion = (sketch: Sketch, index: number): RegionRef => regionCode(sketch.name, sketch.regions, index);

export type Profile =
  /** Segment `ids[i]` runs from `points[i]` to the next point. */
  | { kind: "polygon"; points: [number, number][]; ids: string[] }
  | { kind: "circle"; center: [number, number]; radius: number; id: string }
  /** Paths of lines, Bézier curves and arcs, e.g. of an SVG (`svg()`), what is filled, and what of the source couldn't be drawn. */
  | { kind: "paths"; paths: Path[]; fills: Fill[]; warnings: string[]; error?: string };

// ---------- build context and trace ----------

export interface RefDiagnostic {
  param: string;
  /** The body the reference was resolved against, or the sketch for a region. */
  body: string;
  kind: Kind | "region";
  /** Indices of the entities it resolved to, in the body's face or edge order, or the sketch's regions. */
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
  /** The bodies it consumed, e.g. an extrusion's target (`inputs` of its definition). */
  inputs: Body[];
  /** The sketches among its parameters, e.g. an extrusion's profile. */
  sketches: Sketch[];
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
  /** What of its input it couldn't use, e.g. an SVG's elements that aren't drawn. */
  warnings?: string[];
  /** Milliseconds the feature took, and how many of them went into naming its result's faces and edges. */
  ms: number;
  namingMs: number;
}

/** How a build runs; the tool passes them to `beginBuild`. */
export interface BuildOptions {
  /** Lenient: a failing feature passes its input through and is reported, as in a CAD timeline. Strict: it throws. */
  lenient: boolean;
  /** Called with a feature's trace entry when it starts and when it is done, e.g. for an editor's progress (research/23). */
  onFeature?: (entry: TraceEntry, done: boolean) => void;
}

interface BuildContext extends BuildOptions {
  trace: TraceEntry[];
  /** Bodies not consumed by a later feature, in creation order. */
  live: Body[];
  counts: Map<string, number>;
}

const newContext = (options: BuildOptions): BuildContext => ({ ...options, trace: [], live: [], counts: new Map() });

let context = newContext({ lenient: false });

/** Starts a build: resets names and the trace. The tool calls it before every evaluation. */
export function beginBuild(options: BuildOptions): void {
  context = newContext(options);
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
  /** The indices of the regions of `sketch` that parameter `param` names, all of one if it names none; throws a FeatureError if it is broken. */
  resolveRegions(sketch: Sketch, param: string, refs: unknown): number[];
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
    resolveRegions(sketch, param, input) {
      const regions = sketch.regions;
      if (input === undefined) {
        if (regions.length === 1) return [0];
        throw new FeatureError(regions.length ? `${sketch.name} has ${regions.length} profiles: select which to use` : `${sketch.name} encloses no profile: none of its curves close`);
      }
      const list = Array.isArray(input) ? (input as unknown[]) : [input];
      if (!list.length) throw new FeatureError(`${param}: select at least one profile`);
      const out = new Set<number>();
      list.forEach((r, i) => {
        const at = Array.isArray(input) ? { index: i } : {};
        const d: RefDiagnostic = { param, body: sketch.name, kind: "region", matches: [], ...at, code: String(r), status: "missing" };
        diagnostics.push(d);
        if (!(r instanceof RegionRef)) return void (d.message = `${param}: ${String(r)} is not a profile of a sketch`);
        if (r.sketch !== sketch.name) return void (d.message = `${param}: ${String(r)} is a profile of ${r.sketch}, not of ${sketch.name}`);
        const res = resolveRegion(regions, r);
        const code = (indices: number[]) => indices.map((k) => String(regionCode(sketch.name, regions, k))).join(", ");
        if ("ok" in res) {
          d.status = "ok";
          d.matches = res.ok;
          for (const k of res.ok) out.add(k);
        } else if ("ambiguous" in res) {
          Object.assign(d, { status: "ambiguous", matches: res.ambiguous, message: res.why, suggestion: code(res.suggestion) });
        } else {
          d.message = res.missing;
          if (res.suggestion) d.suggestion = code(res.suggestion);
        }
      });
      const broken = diagnostics.filter((d) => d.param === param && d.status !== "ok");
      if (broken.length) throw new FeatureError(broken.map((d) => d.message).join("; "), diagnostics);
      return [...out].sort((a, b) => a - b);
    },
  };
}

export interface FeatureDefinition<P extends Record<string, unknown>, R> {
  /** Function name in code, e.g. "extrude". */
  type: string;
  label: string;
  icon: string;
  params: { [K in keyof P]-?: ParamSpec };
  /** What hovering it shows in an editor (`FeatureSchema.hover`); every feature has to choose. */
  hover: "faces" | "difference";
  /** Bodies this call consumes; one of them is passed through when the feature fails in a lenient build. */
  inputs?(params: P): (Body | undefined)[];
  /** The result in a lenient build when the feature fails and has no input body to pass through. */
  fallback?(params: P, name: string, message: string, meta: FeatureMeta): R;
  build(params: P, ctx: FeatureContext, meta: FeatureMeta): R;
}

export type Feature<P extends Record<string, unknown>, R> = ((params: P, meta?: FeatureMeta) => R) & { readonly definition: FeatureDefinition<P, R> };

export function defineFeature<P extends Record<string, unknown>, R extends Body | Sketch | Record<string, Body>>(def: FeatureDefinition<P, R>): Feature<P, R> {
  const call = (params: P, meta: FeatureMeta = {}): R => {
    const count = (context.counts.get(def.type) ?? 0) + 1;
    context.counts.set(def.type, count);
    const name = meta.name ?? `${def.type}${meta.line !== undefined ? `@L${meta.line}` : ""}#${count}`;
    const entry: TraceEntry = { name, type: def.type, variable: meta.variable ?? false, status: "ok", refs: [], before: [...context.live], inputs: [], sketches: Object.values(params ?? {}).filter((v): v is Sketch => v instanceof Sketch), results: [], after: [], ms: 0, namingMs: 0 };
    if (meta.line !== undefined) entry.line = meta.line;
    if (meta.destructured) entry.names = Object.values(meta.destructured);
    context.trace.push(entry);
    const { onFeature } = context;
    onFeature?.(entry, false);
    const inputs = (def.inputs?.(params) ?? []).filter((b): b is Body => b instanceof Body);
    entry.inputs = inputs;
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
      onFeature?.(entry, true);
      if (!context.lenient || !passThrough) throw error;
      return passThrough as R;
    }
    if (result instanceof Sketch) {
      entry.sketch = result;
      if (result.profile.kind === "paths" && result.profile.warnings.length) entry.warnings = [...result.profile.warnings];
    }
    const bodies = result instanceof Body ? [result] : result instanceof Sketch ? [] : Object.values(result);
    if (bodies.length > 0) {
      entry.result = bodies[0]!;
      entry.results = bodies;
      context.live = [...context.live.filter((b) => !inputs.includes(b)), ...bodies];
    }
    entry.after = [...context.live];
    onFeature?.(entry, true);
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
