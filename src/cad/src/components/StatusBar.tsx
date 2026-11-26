import { createSignal, For, Show } from "solid-js";
import type { Model } from "./createModel.ts";
import { duration, featureLabel, REMAINING_FROM_MS, remainingText, SLOW_BUILD_MS } from "./progress.ts";

const ms = (value: number) => `${Math.round(value)} ms`;

/** The reference code of the hovered or selected face or edge (research/12). */
export interface Reference {
  code: string;
  /** Selected by a click: it stays while the pointer moves to the status bar, where it can be copied. */
  selected: boolean;
}

/**
 * Kernel and build state: errors with their kind and line, failures of entries without a dialog, OCCT
 * load and build times, the editor's last refused action, what a drop where a document is dragged
 * would do, and the reference of the hovered or selected face or edge.
 */
export function StatusBar(props: { model: Model; notice?: string | undefined; problems?: string[]; reference?: Reference | undefined; context?: string | undefined; action?: string | undefined }) {
  const { init, initError, error, last, building, progress } = props.model;
  /** After a slow build, its slowest feature, the diagnosis CAD systems give in a panel of their own (research/23). */
  const slowest = () => {
    const result = last();
    if (!result?.ok || result.timings.total < SLOW_BUILD_MS || !result.trace.length) return undefined;
    return result.trace.reduce((a, t) => (t.ms > a.ms ? t : a));
  };
  const [copied, setCopied] = createSignal<string>();
  /** Values main returned that the evaluator dropped, e.g. a string. */
  const dropped = () => {
    const result = last();
    return result?.ok ? result.dropped : 0;
  };
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
      <Show when={dropped()}>{(n) => <span class="cad-model__warning">main returned {n() === 1 ? "a value that isn't a shape; it isn't" : `${n()} values that aren't shapes; they aren't`} shown</span>}</Show>
      <For each={props.problems ?? []}>{(problem) => <span class="cad-model__error">{problem}</span>}</For>
      <Show when={props.context}>{(context) => <span class="cad-model__context">{context()}</span>}</Show>
      <Show when={props.action}>{(action) => <span class="cad-model__action">{action()}</span>}</Show>
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
      <Show when={progress()}>
        {(p) => (
          <span class="cad-model__progress" data-finished={p().finished ? "true" : undefined}>
            <Show when={p().running}>{(f) => <span class="cad-model__progress-feature">{featureLabel(f())}</span>}</Show>
            <span
              class="cad-model__bar"
              role="progressbar"
              aria-label="Build progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={p().fraction === undefined ? undefined : Math.round(100 * p().fraction!)}
              data-indeterminate={p().fraction === undefined ? "true" : undefined}
            >
              <span class="cad-model__bar-fill" style={{ width: `${100 * (p().fraction ?? 1)}%` }} />
            </span>
            <span class="cad-model__elapsed">
              {duration(p().elapsed)}
              {p().elapsed >= REMAINING_FROM_MS && p().remaining !== undefined && !p().finished ? ` · ${remainingText(p().remaining!)}` : ""}
            </span>
            <button class="cad-model__abort" disabled={p().finished} onClick={() => props.model.abort()}>
              Abort
            </button>
          </span>
        )}
      </Show>
      <span class="cad-model__timings">
        {!init() && !initError() ? "Loading OCCT…" : ""}
        {init() ? `OCCT: compile ${ms(init()!.compile)}, init ${ms(init()!.instantiate)}` : ""}
        {building() ? " · Building…" : last() ? ` · build ${duration(last()!.timings.total)}` : ""}
        {!building() && slowest() ? `, slowest ${featureLabel(slowest()!)} ${duration(slowest()!.ms)}` : ""}
      </span>
    </div>
  );
}
