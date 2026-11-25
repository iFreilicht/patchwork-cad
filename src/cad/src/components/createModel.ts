import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { DocHandle, UrlHeads } from "@automerge/automerge-repo";
import { Engine, type BuildEvent, type BuildResult } from "../kernel/engine.ts";
import { estimate, loadTimes, PROGRESS_DELAY_MS, PROGRESS_MIN_MS, SLOW_BUILD_MS, storeTimes, timesOf, type FeatureTimes, type RunningFeature } from "./progress.ts";
import type { Imports } from "../kernel/imports.ts";
import { createImports, headsOf, type ImportedDocument, type ReadImports } from "./imports.ts";
import type { BuildParams, ParamValues, FeatureTrace, InitTimings, MeshedShape, ModelError, ShownSketch } from "../kernel/protocol.ts";
import { parse } from "acorn";
import { decide, errorKeys, errorTexts, locksOf, moved, writeLocks, type BuildErrors, type Decision, type Followed } from "../model/locks.ts";
import type { CadModelDoc } from "../types.ts";
import type { FaceRefs } from "./Viewer.tsx";

/** The model's worker turning faces into references and back, for close-ups (research/20, "Close-ups"). */
export const faceRefs = (model: Model): FaceRefs => ({ refs: (faces) => model.engine.refs(faces), locate: (bodies, refs) => model.engine.locate(bodies, refs) });

export type ModelStatus = "loading" | "init-failed" | "building" | "error" | "ready";

/** A followed document whose newer version the model is held back from, at its lock (research/21, "Following and pinning"). */
export interface HeldDocument {
  doc: string;
  /** The version the model is shown with, and the newer one. */
  locked: UrlHeads;
  latest: UrlHeads;
  /** The errors the newer version brought, with their messages. */
  errors: string[];
}

/** A running build's progress, once it has run for `PROGRESS_DELAY_MS` (research/23-build-progress.md). */
export interface BuildProgress {
  elapsed: number;
  /** How far it is by the previous build's feature times; undefined without them. Never moves back. */
  fraction: number | undefined;
  remaining: number | undefined;
  /** The feature that runs, or between two the last one that started. */
  running: RunningFeature | undefined;
  /** The result arrived: the bar is full while it stays for the rest of `PROGRESS_MIN_MS`. */
  finished: boolean;
}

/** What each feature of a running build is doing, once its progress shows. Features of the last build that aren't in either are waiting. */
export interface BuildStates {
  running: RunningFeature | undefined;
  /** Features that are done in this build, with their new status. */
  done: ReadonlyMap<string, FeatureTrace>;
}

/** A model document built by one kernel worker: the shared core of every tool that shows the model. */
export interface Model {
  engine: Engine;
  /** The shapes of the last successful build; they stay while later builds fail. */
  shapes: Accessor<MeshedShape[] | undefined>;
  /** The sketches main returned in the last successful build. */
  sketches: Accessor<ShownSketch[]>;
  error: Accessor<ModelError | undefined>;
  /** The feature trace of the last build, successful or not. */
  trace: Accessor<FeatureTrace[]>;
  init: Accessor<InitTimings | undefined>;
  initError: Accessor<string | undefined>;
  last: Accessor<BuildResult | undefined>;
  building: Accessor<boolean>;
  progress: Accessor<BuildProgress | undefined>;
  buildStates: Accessor<BuildStates | undefined>;
  /** Stops the running build (`Engine.abort`); nothing builds until the next change. */
  abort(): void;
  status: Accessor<ModelStatus>;
  /** The values of parameters it builds with over the model's defaults, if any. */
  params: Accessor<BuildParams | undefined>;
  /** What the last successful build's parameters and derived parameters were. */
  paramValues: Accessor<ParamValues | undefined>;
  /** The documents `source` imports, at the versions the model is shown with, e.g. for a trial build of it. */
  imports(source: string): Promise<Imports>;
  /** The documents the shown build imported, directly or through imported JS, at the versions it read. */
  documents: Accessor<ImportedDocument[]>;
  /** The followed documents held back at their locks. */
  held: Accessor<HeldDocument[]>;
}

/** The same values of parameters, whichever order their keys are in. */
const paramsKey = (params: BuildParams | undefined) => (params ? JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))) : "");

/** A build's errors, as locks compare them. */
const errorsOf = (result: BuildResult): BuildErrors => ({ error: result.ok ? undefined : result.error, failures: result.trace.flatMap((t) => (t.status === "ok" ? [] : [{ name: t.name, status: t.status, message: t.message }])) });

const parses = (source: string) => {
  try {
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    return true;
  } catch {
    return false;
  }
};

/**
 * One rebuild: the documents at their latest versions, and, if some followed document moved on from
 * its lock, at the locked versions of those (research/21, "Following and pinning").
 */
interface Plan {
  source: string;
  params: BuildParams | undefined;
  latest: ReadImports;
  locked: ReadImports | undefined;
  followed: Followed[];
  writable: boolean;
  /** What was decided, once it needed another build to show, and the latest build's errors' messages. */
  decision?: Decision;
  texts?: Record<string, string>;
}

export interface ModelOptions {
  /**
   * Whether this tool writes the locks of followed documents: only the editor does, and never into a
   * document shown read-only, e.g. at an old version. The viewer and embeds read them.
   */
  writeLocks?: boolean;
}

/**
 * Builds the document's source on every change, one build at a time (see Engine), with `params`
 * over the model's defaults when given (research/17-parameters.md), and on every change of a
 * document it imports and follows. A followed document whose newer version breaks the model is held
 * back at its lock; a read-only document, e.g. an old version, builds with its locks as it was.
 * Disposed with the owner.
 */
export function createModel(handle: DocHandle<CadModelDoc>, params?: Accessor<BuildParams | undefined>, options: ModelOptions = {}): Model {
  const [shapes, setShapes] = createSignal<MeshedShape[]>();
  const [sketches, setSketches] = createSignal<ShownSketch[]>([]);
  const [error, setError] = createSignal<ModelError>();
  const [trace, setTrace] = createSignal<FeatureTrace[]>([]);
  const [init, setInit] = createSignal<InitTimings>();
  const [initError, setInitError] = createSignal<string>();
  const [last, setLast] = createSignal<BuildResult>();
  const [building, setBuilding] = createSignal(false);
  const [documents, setDocuments] = createSignal<ImportedDocument[]>([]);
  const [held, setHeld] = createSignal<HeldDocument[]>([]);
  const [progress, setProgress] = createSignal<BuildProgress>();
  const [buildStates, setBuildStates] = createSignal<BuildStates>();

  // Progress (research/23): the running build, its features, and the last build's feature times.
  let run: { started: number; done: Map<string, FeatureTrace>; running: (RunningFeature & { since: number }) | undefined; last: RunningFeature | undefined; fraction: number; changed: boolean } | undefined;
  /** When progress started to show, until it is hidden again. */
  let shownAt: number | undefined;
  let times: FeatureTimes | undefined = loadTimes(handle.url);
  let ticker: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const now = performance.now();
    if (!run) {
      if (shownAt !== undefined && now - shownAt < PROGRESS_MIN_MS) return;
      shownAt = undefined;
      setProgress(undefined);
      clearInterval(ticker);
      ticker = undefined;
      return;
    }
    const elapsed = now - run.started;
    if (shownAt === undefined && elapsed < PROGRESS_DELAY_MS) return;
    shownAt ??= now;
    const estimated = times && estimate(times, run.done, run.running, elapsed);
    if (estimated) run.fraction = Math.max(run.fraction, estimated.fraction);
    setProgress({ elapsed, fraction: estimated && run.fraction, remaining: estimated?.remaining, running: run.last, finished: false });
    if (run.changed || !buildStates()) setBuildStates({ running: run.running && run.last, done: new Map(run.done) });
    run.changed = false;
  };
  const onProgress = (event: BuildEvent) => {
    const now = performance.now();
    if (event.kind === "build") {
      run = { started: now, done: new Map(), running: undefined, last: undefined, fraction: 0, changed: true };
      ticker ??= setInterval(tick, 100);
    } else if (!run) return;
    else if (event.kind === "ended") {
      // Before the result: a waiting build may start right after.
      run = undefined;
      setBuildStates(undefined);
      const shown = progress();
      if (shown) setProgress({ ...shown, fraction: shown.fraction === undefined ? undefined : 1, remaining: 0, finished: true });
      tick();
    } else if (event.kind === "started") {
      run.last = { name: event.name, type: event.type, line: event.line, variable: event.variable };
      run.running = { ...run.last, since: now - run.started };
    }
    else {
      run.done.set(event.feature.name, event.feature);
      run.running = undefined;
    }
    if (run) run.changed = true;
  };
  /** A successful build's feature times predict the next build's progress. */
  const learn = (result: BuildResult) => {
    if (!result.ok) return;
    times = timesOf(result.trace, result.timings.total);
    if (result.timings.total >= SLOW_BUILD_MS) storeTimes(handle.url, times);
  };
  onCleanup(() => clearInterval(ticker));

  let latest = handle.doc()?.content ?? "";
  let latestParams = paramsKey(params?.());
  let latestImports = "";
  /** Counts rebuilds, so that only the newest one builds once its imports are read. */
  let requests = 0;
  /** The newest plan, and the plans of builds that may still answer, by the imports they were given. */
  let current: Plan | undefined;
  const plans = new WeakMap<Imports, Plan>();

  const show = (result: BuildResult) => {
    setLast(result);
    setTrace(result.trace);
    if (result.ok) {
      setShapes(result.shapes);
      setSketches(result.sketches);
      setError(undefined);
    } else setError(result.error);
    const plan = plans.get(result.imports);
    if (plan) setDocuments((plan.locked?.imports === result.imports ? plan.locked : plan.latest).documents);
  };
  /** Shows what was decided for the current plan, and writes its locks. */
  const finish = (plan: Plan, result: BuildResult, decision: Decision, texts: Record<string, string> = {}) => {
    show(result);
    setBuilding(false);
    setHeld(
      decision.held.map((h) => {
        const d = plan.followed.find((f) => f.doc === h.doc)!;
        return { doc: h.doc, locked: d.locked as UrlHeads, latest: d.latest as UrlHeads, errors: h.errors.map((key) => texts[key] ?? key) };
      }),
    );
    if (!plan.writable) return;
    const stored = locksOf(handle.doc());
    // A model without locks and nothing to lock costs nothing more.
    if (!Object.keys(decision.write).length && !Object.keys(stored).length) return;
    // Documents no longer followed lose their locks, once every imported document could be read: a JS file that can't hides what it imports.
    const prunable = parses(plan.source) && plan.latest.documents.every((d) => d.module.kind !== "problem");
    const keep = prunable ? new Set(plan.followed.map((f) => f.doc)) : undefined;
    const changes = Object.entries(decision.write).some(([doc, heads]) => stored[doc]?.join("|") !== heads.join("|")) || (keep !== undefined && Object.keys(stored).some((doc) => !keep.has(doc)));
    if (!changes) return;
    handle.change((d) => writeLocks(d, decision.write, keep));
    // The locks now say what this plan built with: nothing moved any more, unless it is held back.
    if (decision.show === "latest") latestImports = `${plan.latest.key}\n--\n`;
  };

  const onResult = async (result: BuildResult) => {
    learn(result);
    if (!result.ok && result.aborted) {
      show(result);
      setBuilding(false);
      return;
    }
    const plan = plans.get(result.imports);
    // A build for an older plan: shown while the newest builds, as before locks, unless it may be one to hold back.
    if (!plan || plan !== current) {
      if (!plan?.locked) {
        show(result);
        setBuilding(result.source !== latest || paramsKey(result.params) !== latestParams);
      }
      return;
    }
    const isLatest = result.imports === plan.latest.imports;
    if (plan.decision) return finish(plan, result, plan.decision, plan.texts);
    const errors = errorsOf(result);
    // Without a moved document, or with the latest versions and no errors, there is nothing to compare.
    if (!plan.locked || (isLatest && errorKeys(errors).length === 0)) return finish(plan, result, decide(plan.followed, errorKeys(errors), undefined, plan.writable));
    // A trial build of the other variant, without meshing, which leaves this build the worker's last one.
    const other = isLatest ? plan.locked : plan.latest;
    const trial = await engine.check(plan.source, plan.params, other.imports).catch(() => undefined);
    if (plan !== current) return;
    // Without the trial, e.g. when the kernel restarted, nothing is decided.
    if (!trial) return finish(plan, result, { show: isLatest ? "latest" : "locked", held: [], write: {} });
    const [latestErrors, lockedErrors] = isLatest ? [errors, trial] : [trial, errors];
    const decision = decide(plan.followed, errorKeys(latestErrors), errorKeys(lockedErrors), plan.writable);
    const texts = errorTexts(latestErrors);
    if ((decision.show === "latest") === isLatest) return finish(plan, result, decision, texts);
    plan.decision = decision;
    plan.texts = texts;
    engine.build(plan.source, plan.params, other.imports);
  };

  const engine = new Engine({
    onResult: (result) => void onResult(result),
    onProgress,
    onReady: (timings) => setInit(timings),
    onInitFailed: setInitError,
  });

  /** The followed documents of a read: each document once, with its version and lock. */
  const followedIn = (read: ReadImports): Followed[] => {
    const locks = locksOf(handle.doc());
    const out = new Map<string, Followed>();
    for (const d of read.documents) {
      if (!d.doc || headsOf(d.specifier) || !d.heads || out.has(d.doc)) continue;
      const locked = locks[d.doc];
      out.set(d.doc, { doc: d.doc, latest: d.heads, locked, hasLocked: !!locked && imports.has(d.doc, locked as UrlHeads) });
    }
    return [...out.values()];
  };
  /** The versions to read moved documents at: their locks. */
  const lockedAt = (docs: Followed[]) => Object.fromEntries(docs.map((d) => [d.doc, d.locked as UrlHeads]));

  const rebuild = async () => {
    const request = ++requests;
    const source = handle.doc()?.content ?? "";
    const values = params?.();
    const read = await imports.read(source);
    if (request !== requests) return;
    const followed = followedIn(read);
    // An old version rebuilds as it was: with its locks, and nothing to compare or write.
    const readOnly = handle.isReadOnly();
    const movedDocs = readOnly ? followed.filter((d) => d.locked && d.hasLocked) : moved(followed);
    const locked = movedDocs.length ? await imports.read(source, lockedAt(movedDocs)) : undefined;
    if (request !== requests) return;
    const importsKey = `${read.key}\n--\n${locked?.key ?? ""}`;
    if (source === latest && paramsKey(values) === latestParams && importsKey === latestImports && last()) return;
    latest = source;
    latestParams = paramsKey(values);
    latestImports = importsKey;
    const plan: Plan = { source, params: values, latest: readOnly && locked ? locked : read, locked: readOnly ? undefined : locked, followed: readOnly ? [] : followed, writable: !!options.writeLocks && !readOnly };
    current = plan;
    plans.set(plan.latest.imports, plan);
    if (plan.locked) plans.set(plan.locked.imports, plan);
    setBuilding(true);
    // While held back, the locked build is the likely one to show: it goes first.
    const stillHeld = plan.locked && held().length > 0 && movedDocs.every((d) => held().some((h) => h.doc === d.doc && h.latest.join("|") === d.latest.join("|")));
    engine.build(source, values, stillHeld ? plan.locked!.imports : plan.latest.imports);
  };
  const imports = createImports(() => void rebuild());
  void rebuild();
  const onChange = () => void rebuild();
  handle.on("change", onChange);
  if (params) createEffect(on(params, onChange, { defer: true }));
  onCleanup(() => {
    handle.off("change", onChange);
    imports.dispose();
    engine.dispose();
  });

  const status = (): ModelStatus => (initError() ? "init-failed" : !init() ? "loading" : building() ? "building" : error() ? "error" : "ready");
  const paramValues = () => {
    const result = last();
    return result?.ok ? result.paramValues : undefined;
  };
  /** The documents of `source` at the versions shown: held-back ones at their locks. */
  const shownImports = async (source: string) => {
    const at = Object.fromEntries(held().map((h) => [h.doc, h.locked]));
    return (await imports.read(source, at)).imports;
  };
  const model: Model = { engine, shapes, sketches, error, trace, init, initError, last, building, progress, buildStates, abort: () => engine.abort(), status, params: () => params?.(), paramValues, imports: shownImports, documents, held };
  return model;
}

/** The data attributes the e2e specs read from a tool's root element, as getters so that a JSX spread tracks them. */
export function modelAttributes(model: Model) {
  const { last, init, engine } = model;
  return {
    get "data-state"() {
      return model.status();
    },
    get "data-builds-requested"() {
      return String(last() ? engine.stats.requested : 0);
    },
    get "data-builds-executed"() {
      return String(last() ? engine.stats.executed : 0);
    },
    get "data-kernel-restarts"() {
      return String(last() ? engine.stats.restarts : 0);
    },
    get "data-init"() {
      return init() ? JSON.stringify(init()) : undefined;
    },
    get "data-build"() {
      return last() ? JSON.stringify(last()!.timings) : undefined;
    },
    /** Summed feature times of the last build: all features, and the part spent naming. */
    get "data-features"() {
      const trace = last()?.trace ?? [];
      const sum = (f: (t: (typeof trace)[number]) => number) => trace.reduce((a, t) => a + f(t), 0);
      return last() ? JSON.stringify({ count: trace.length, ms: sum((t) => t.ms), namingMs: sum((t) => t.namingMs) }) : undefined;
    },
  };
}
