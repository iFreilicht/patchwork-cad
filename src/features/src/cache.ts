/**
 * Reusing features' results across builds (research/24-feature-caching.md). A feature call is
 * reused when the previous build (or one of the last few) made a call of the same definition, in
 * the same place, with the same arguments, and printed the same names: its result is then the
 * very same object, and so are its own users' inputs. Bodies and sketches don't change once made,
 * so a reused one is what a new build would make.
 */
import { Body, isExposed, Sketch, type RefDiagnostic } from "./feature.ts";
import { RegionRef } from "./profile.ts";
import { Named, Ref } from "./refs.ts";

/** What a call gave: its status and diagnostics, and the value it returned, its result or, failed, what it passed through. */
export interface Outcome {
  status: "ok" | "broken" | "failed";
  message?: string;
  refs: RefDiagnostic[];
  value: unknown;
  failed: boolean;
}

export interface CacheRecord {
  definition: object;
  /** The arguments, as `argsKey` wrote them when the call ran. */
  key: string;
  /** The feature names the call printed, e.g. in a reference's code, and how; a later build must print them the same. */
  printed: [string, string][];
  outcome: Outcome;
  /** Milliseconds the call took when it ran. */
  cost: number;
  /** The build that last made or reused it. */
  used: number;
}

/**
 * The results of the last builds' feature calls, by place: a call's name and, as names repeat
 * (`const rib = …` in a loop), how many calls of that name came before it in the build. The tool
 * keeps one for all builds in a kernel, and passes it to `beginBuild`.
 */
export class FeatureCache {
  readonly #generations: number;
  #build = 0;
  #readOnly = false;
  readonly #records = new Map<string, CacheRecord[]>();
  /** How many calls of the current build were reused and how many ran. */
  readonly stats = { reused: 0, ran: 0 };

  /** `generations`: how many builds a result is kept for after the last build that used it; 2 also covers a build that stopped early, or switching back and forth. */
  constructor({ generations = 2 }: { generations?: number } = {}) {
    this.#generations = Math.max(1, generations);
  }

  /** Starts a build; a read-only one, e.g. a trial build, reuses results but keeps none and changes nothing. */
  begin(readOnly: boolean): void {
    this.#readOnly = readOnly;
    this.stats.reused = 0;
    this.stats.ran = 0;
    if (readOnly) return;
    this.#build++;
    for (const [slot, records] of this.#records) {
      const kept = records.filter((r) => r.used > this.#build - 1 - this.#generations);
      if (kept.length) this.#records.set(slot, kept);
      else this.#records.delete(slot);
    }
  }

  /** The record of an earlier call at `slot` that this one may reuse; `print` prints a feature name as the build does now. */
  find(slot: string, definition: object, key: string, print: (feature: string) => string): CacheRecord | undefined {
    const record = this.#records.get(slot)?.find((r) => r.definition === definition && r.key === key && r.printed.every(([feature, printed]) => print(feature) === printed) && !madeExposed(r.outcome));
    if (record && !this.#readOnly) record.used = this.#build;
    return record;
  }

  add(slot: string, record: Omit<CacheRecord, "used">): void {
    if (this.#readOnly) return;
    const records = this.#records.get(slot) ?? [];
    this.#records.set(slot, [{ ...record, used: this.#build }, ...records.filter((r) => r.key !== record.key || r.definition !== record.definition)]);
  }

  /** A sketch an earlier call at `slot` made that is the same as `sketch`, to be used instead of it, so that its users can be reused too ("early cutoff"). */
  same(slot: string, sketch: Sketch): Sketch | undefined {
    const key = sketchKey(sketch);
    if (key === undefined) return undefined;
    for (const r of this.#records.get(slot) ?? []) if (r.outcome.value instanceof Sketch && r.outcome.value !== sketch && !isExposed(r.outcome.value) && sketchKey(r.outcome.value) === key) return r.outcome.value;
    return undefined;
  }

  /** How many results it keeps, for tests and measurements. */
  get size(): number {
    let n = 0;
    for (const records of this.#records.values()) n += records.length;
    return n;
  }

  clear(): void {
    this.#records.clear();
  }
}

/** Whether a result is a body or sketch whose shapes may have been changed since, e.g. by a replicad boolean (`isExposed`). */
const madeExposed = (o: Outcome): boolean => {
  const v = o.value;
  if (v instanceof Body || v instanceof Sketch) return isExposed(v);
  return v !== null && typeof v === "object" && Object.values(v).some((x) => x instanceof Body && isExposed(x));
};

/** Ids of bodies and sketches, which are compared by identity. */
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

/**
 * A call's arguments as a string that is the same exactly when they are: numbers, strings and the
 * like by value (`Object.is`), arrays and plain objects by their elements and keys in order,
 * references by what they name, bodies and sketches by identity. Written when the call runs, it
 * keeps what the arguments were even if the model changes them afterwards. Undefined if an
 * argument is anything else, e.g. a function or a replicad shape, which can't be compared, or a
 * body or sketch whose shapes may have changed (`isExposed`). Every body and sketch among them is added to `uses`.
 */
export function argsKey(value: unknown, uses: Set<Body | Sketch>): string | undefined {
  let ok = true;
  const path = new Set<object>();
  const visit = (v: unknown): string => {
    switch (typeof v) {
      case "undefined":
        return "u";
      case "boolean":
        return v ? "T" : "F";
      case "number":
        return Object.is(v, -0) ? "#-0" : `#${v}`;
      case "bigint":
        return `n${v}`;
      case "string":
        return JSON.stringify(v);
      case "symbol":
      case "function":
        ok = false;
        return "?";
    }
    if (v === null) return "N";
    if (v instanceof Body) {
      uses.add(v);
      if (isExposed(v)) ok = false;
      return `B${idOf(v)}`;
    }
    if (v instanceof Sketch) {
      uses.add(v);
      if (isExposed(v)) ok = false;
      return `S${idOf(v)}`;
    }
    if (path.has(v as object)) {
      ok = false;
      return "?";
    }
    path.add(v as object);
    try {
      if (Array.isArray(v)) return `[${Array.from({ length: v.length }, (_, i) => (i in v ? visit(v[i]) : "_")).join(",")}]`;
      if (v instanceof Ref) return `R(${visit(v.kind)},${visit(v.names)},${visit(v.near)})`;
      if (v instanceof RegionRef) return `G(${visit(v.sketch)},${visit(v.loops)},${visit(v.near)})`;
      if (v instanceof Named) return `M(${visit(v.name)},${visit([...v.via])})`;
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        ok = false;
        return "?";
      }
      return `{${Object.keys(v as object).map((k) => `${JSON.stringify(k)}:${visit((v as Record<string, unknown>)[k])}`).join(",")}}`;
    } finally {
      path.delete(v as object);
    }
  };
  const key = visit(value);
  return ok ? key : undefined;
}

/** A sketch's value, for comparing two sketches; undefined if it can't be written. */
const sketchKey = (s: Sketch): string | undefined => argsKey([s.name, s.frame, s.profile, s.broken], new Set());
