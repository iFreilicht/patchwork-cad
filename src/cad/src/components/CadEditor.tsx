import { createSignal, onCleanup, Show } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { Engine, type BuildResult } from "../kernel/engine.ts";
import type { InitTimings, MeshedShape, ModelError } from "../kernel/protocol.ts";
import type { CadModelDoc } from "../types.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Viewer } from "./Viewer.tsx";

const ms = (value: number) => `${Math.round(value)} ms`;

export function CadEditor(props: { handle: DocHandle<CadModelDoc> }) {
  const [shapes, setShapes] = createSignal<MeshedShape[]>();
  const [error, setError] = createSignal<ModelError>();
  const [init, setInit] = createSignal<InitTimings>();
  const [initError, setInitError] = createSignal<string>();
  const [last, setLast] = createSignal<BuildResult>();
  const [building, setBuilding] = createSignal(false);

  let latest = props.handle.doc()?.source ?? "";
  const engine = new Engine((result) => {
    setLast(result);
    if (result.ok) {
      setShapes(result.shapes);
      setError(undefined);
    } else setError(result.error);
    setBuilding(result.source !== latest);
  });
  engine.ready.then(setInit, (e: unknown) => setInitError(String((e as Error).message)));

  const rebuild = () => {
    const source = props.handle.doc()?.source ?? "";
    if (source === latest && last()) return;
    latest = source;
    setBuilding(true);
    engine.build(source);
  };
  rebuild();
  props.handle.on("change", rebuild);
  onCleanup(() => {
    props.handle.off("change", rebuild);
    engine.dispose();
  });

  const state = () => (initError() ? "init-failed" : !init() ? "loading" : building() ? "building" : error() ? "error" : "ready");

  return (
    <div
      class="cad-model"
      data-state={state()}
      data-builds-requested={String(last() ? engine.stats.requested : 0)}
      data-builds-executed={String(last() ? engine.stats.executed : 0)}
      data-init={init() ? JSON.stringify(init()) : undefined}
      data-build={last() ? JSON.stringify(last()!.timings) : undefined}
    >
      <CodeEditor handle={props.handle} errorLine={error()?.line} />
      <Viewer shapes={shapes()} />
      <div class="cad-model__status" role="status">
        <Show when={initError()}>{(message) => <span class="cad-model__error">Kernel failed to load: {message()}</span>}</Show>
        <Show when={error()}>
          {(e) => (
            <span class="cad-model__error">
              {e().kind} error{e().line !== undefined ? ` on line ${e().line}` : ""}: {e().message}
            </span>
          )}
        </Show>
        <span class="cad-model__timings">
          {!init() && !initError() ? "Loading OCCT…" : ""}
          {init() ? `OCCT: compile ${ms(init()!.compile)}, init ${ms(init()!.instantiate)}` : ""}
          {last() ? ` · build ${ms(last()!.timings.total)}` : ""}
          {building() ? " · building…" : ""}
        </span>
      </div>
    </div>
  );
}
