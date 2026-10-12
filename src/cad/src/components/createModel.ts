import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { Engine, type BuildResult } from "../kernel/engine.ts";
import type { FeatureTrace, InitTimings, MeshedShape, ModelError } from "../kernel/protocol.ts";
import type { CadModelDoc } from "../types.ts";

export type ModelStatus = "loading" | "init-failed" | "building" | "error" | "ready";

/** A model document built by one kernel worker: the shared core of every tool that shows the model. */
export interface Model {
  engine: Engine;
  /** The shapes of the last successful build; they stay while later builds fail. */
  shapes: Accessor<MeshedShape[] | undefined>;
  error: Accessor<ModelError | undefined>;
  /** The feature trace of the last build, successful or not. */
  trace: Accessor<FeatureTrace[]>;
  init: Accessor<InitTimings | undefined>;
  initError: Accessor<string | undefined>;
  last: Accessor<BuildResult | undefined>;
  building: Accessor<boolean>;
  status: Accessor<ModelStatus>;
}

/** Builds the document's source on every change, one build at a time (see Engine). Disposed with the owner. */
export function createModel(handle: DocHandle<CadModelDoc>): Model {
  const [shapes, setShapes] = createSignal<MeshedShape[]>();
  const [error, setError] = createSignal<ModelError>();
  const [trace, setTrace] = createSignal<FeatureTrace[]>([]);
  const [init, setInit] = createSignal<InitTimings>();
  const [initError, setInitError] = createSignal<string>();
  const [last, setLast] = createSignal<BuildResult>();
  const [building, setBuilding] = createSignal(false);

  let latest = handle.doc()?.source ?? "";
  const engine = new Engine({
    onResult(result) {
      setLast(result);
      setTrace(result.trace);
      if (result.ok) {
        setShapes(result.shapes);
        setError(undefined);
      } else setError(result.error);
      setBuilding(result.source !== latest);
    },
    onReady: (timings) => setInit(timings),
    onInitFailed: setInitError,
  });

  const rebuild = () => {
    const source = handle.doc()?.source ?? "";
    if (source === latest && last()) return;
    latest = source;
    setBuilding(true);
    engine.build(source);
  };
  rebuild();
  handle.on("change", rebuild);
  onCleanup(() => {
    handle.off("change", rebuild);
    engine.dispose();
  });

  const status = (): ModelStatus => (initError() ? "init-failed" : !init() ? "loading" : building() ? "building" : error() ? "error" : "ready");
  return { engine, shapes, error, trace, init, initError, last, building, status };
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
