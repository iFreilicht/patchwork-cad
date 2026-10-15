import { Show } from "solid-js";
import type { Model } from "./createModel.ts";

const ms = (value: number) => `${Math.round(value)} ms`;

/** Kernel and build state: errors with their kind and line, OCCT load and build times, and the editor's last refused action. */
export function StatusBar(props: { model: Model; notice?: string | undefined }) {
  const { init, initError, error, last, building } = props.model;
  return (
    <div class="cad-model__status" role="status">
      <Show when={initError()}>{(message) => <span class="cad-model__error">Kernel failed to load: {message()}</span>}</Show>
      <Show when={error()}>
        {(e) => (
          <span class="cad-model__error">
            {e().kind} error{e().line !== undefined ? ` on line ${e().line}` : ""}: {e().message}
          </span>
        )}
      </Show>
      <Show when={props.notice}>{(message) => <span class="cad-model__error cad-model__notice">{message()}</span>}</Show>
      <span class="cad-model__timings">
        {!init() && !initError() ? "Loading OCCT…" : ""}
        {init() ? `OCCT: compile ${ms(init()!.compile)}, init ${ms(init()!.instantiate)}` : ""}
        {last() ? ` · build ${ms(last()!.timings.total)}` : ""}
        {building() ? " · building…" : ""}
      </span>
    </div>
  );
}
