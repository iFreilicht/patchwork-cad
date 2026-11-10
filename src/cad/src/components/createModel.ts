import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { Engine, type BuildResult } from "../kernel/engine.ts";
import type { BuildParams, ParamValues, FeatureTrace, InitTimings, MeshedShape, ModelError, ShownSketch } from "../kernel/protocol.ts";
import type { CadModelDoc } from "../types.ts";

export type ModelStatus = "loading" | "init-failed" | "building" | "error" | "ready";

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
  status: Accessor<ModelStatus>;
  /** The values of parameters it builds with over the model's defaults, if any. */
  params: Accessor<BuildParams | undefined>;
  /** What the last successful build's parameters and derived parameters were. */
  paramValues: Accessor<ParamValues | undefined>;
}

/** The same values of parameters, whichever order their keys are in. */
const paramsKey = (params: BuildParams | undefined) => (params ? JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))) : "");

/**
 * Builds the document's source on every change, one build at a time (see Engine), with `params`
 * over the model's defaults when given (research/17-parameters.md). Disposed with the owner.
 */
export function createModel(handle: DocHandle<CadModelDoc>, params?: Accessor<BuildParams | undefined>): Model {
  const [shapes, setShapes] = createSignal<MeshedShape[]>();
  const [sketches, setSketches] = createSignal<ShownSketch[]>([]);
  const [error, setError] = createSignal<ModelError>();
  const [trace, setTrace] = createSignal<FeatureTrace[]>([]);
  const [init, setInit] = createSignal<InitTimings>();
  const [initError, setInitError] = createSignal<string>();
  const [last, setLast] = createSignal<BuildResult>();
  const [building, setBuilding] = createSignal(false);

  let latest = handle.doc()?.source ?? "";
  let latestParams = paramsKey(params?.());
  const engine = new Engine({
    onResult(result) {
      setLast(result);
      setTrace(result.trace);
      if (result.ok) {
        setShapes(result.shapes);
        setSketches(result.sketches);
        setError(undefined);
      } else setError(result.error);
      setBuilding(result.source !== latest || paramsKey(result.params) !== latestParams);
    },
    onReady: (timings) => setInit(timings),
    onInitFailed: setInitError,
  });

  const rebuild = () => {
    const source = handle.doc()?.source ?? "";
    const values = params?.();
    if (source === latest && paramsKey(values) === latestParams && last()) return;
    latest = source;
    latestParams = paramsKey(values);
    setBuilding(true);
    engine.build(source, values);
  };
  rebuild();
  handle.on("change", rebuild);
  if (params) createEffect(on(params, rebuild, { defer: true }));
  onCleanup(() => {
    handle.off("change", rebuild);
    engine.dispose();
  });

  const status = (): ModelStatus => (initError() ? "init-failed" : !init() ? "loading" : building() ? "building" : error() ? "error" : "ready");
  const paramValues = () => {
    const result = last();
    return result?.ok ? result.paramValues : undefined;
  };
  return { engine, shapes, sketches, error, trace, init, initError, last, building, status, params: () => params?.(), paramValues };
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
