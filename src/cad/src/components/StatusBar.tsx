import { createSignal, Show } from "solid-js";
import type { Model } from "./createModel.ts";

const ms = (value: number) => `${Math.round(value)} ms`;

/** The reference code of the hovered or selected face or edge (research/12). */
export interface Reference {
  code: string;
  /** Selected by a click: it stays while the pointer moves to the status bar, where it can be copied. */
  selected: boolean;
}

/** Kernel and build state: errors with their kind and line, OCCT load and build times, the editor's last refused action, and the reference of the hovered or selected face or edge. */
export function StatusBar(props: { model: Model; notice?: string | undefined; reference?: Reference | undefined }) {
  const { init, initError, error, last, building } = props.model;
  const [copied, setCopied] = createSignal<string>();
  const copy = (code: string) =>
    navigator.clipboard.writeText(code).then(
      () => setCopied(code),
      (error: unknown) => console.warn("[cad-model] couldn't copy the reference", error),
    );
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
      <Show when={props.reference}>
        {(reference) => (
          <span class="cad-model__reference" data-selected={reference().selected ? "true" : "false"}>
            <code title={reference().code}>{reference().code}</code>
            <Show when={reference().selected}>
              <button class="cad-model__copy" onClick={() => void copy(reference().code)}>
                {copied() === reference().code ? "Copied" : "Copy"}
              </button>
            </Show>
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
  );
}
