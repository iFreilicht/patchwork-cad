import { createSignal, For, Index, Show } from "solid-js";
import { isLinked } from "../../model/configurations.ts";
import { unitOf, usesOf, type ParamConfig } from "../../model/params.ts";
import type { LinkedValue, ParamValue } from "../../types.ts";
import { ExpressionInput } from "./FeatureDialog.tsx";
import { NameField } from "./NameField.tsx";
import { asCode, type ParamsController } from "./parameters.ts";
import type { Editor } from "./state.ts";

/** A value as the dialog shows it: code, or the link it reads. */
const shown = (value: ParamValue | LinkedValue | undefined) => (value === undefined ? undefined : isLinked(value) ? value.link : asCode(value));

/** What a typed value is: nothing, a link to another document's value, JSON, or not a value. */
function parseValue(text: string): { value: ParamValue | LinkedValue | undefined } | undefined {
  const t = text.trim();
  if (t === "") return { value: undefined };
  if (t.startsWith("automerge:")) return { value: { link: t as LinkedValue["link"] } };
  try {
    return { value: JSON.parse(t) as ParamValue };
  } catch {
    return undefined;
  }
}

/** Why `value` is outside what `config` allows, if it is. */
function rangeProblem(value: ParamValue | undefined, config: ParamConfig | undefined): string | undefined {
  if (typeof value !== "number" || !config) return undefined;
  if (config.minimum !== undefined && value < config.minimum) return `less than the minimum, ${config.minimum}`;
  if (config.maximum !== undefined && value > config.maximum) return `more than the maximum, ${config.maximum}`;
  if (config.multipleOf !== undefined && Math.abs(value / config.multipleOf - Math.round(value / config.multipleOf)) > 1e-9) return `not a multiple of ${config.multipleOf}`;
  return undefined;
}

/**
 * A value this user tries for a parameter: JSON, or an automerge URL that resolves to a number.
 * It applies on Enter or when the field is left; an empty field stops trying it.
 */
function TryInput(props: { label: string; value: string | undefined; placeholder: string; onCommit: (value: ParamValue | LinkedValue | undefined) => void; problem: string | undefined }) {
  const [invalid, setInvalid] = createSignal(false);
  const commit = (input: HTMLInputElement) => {
    const parsed = parseValue(input.value);
    setInvalid(!parsed);
    if (parsed && shown(parsed.value) !== props.value) props.onCommit(parsed.value);
  };
  return (
    <input
      class="cad-editor__input"
      classList={{ "cad-editor__input--invalid": invalid() || !!props.problem }}
      aria-label={props.label}
      aria-invalid={invalid() || !!props.problem}
      title={props.problem ?? "A value to try, only for you: JSON, or an automerge URL of another document's number"}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      spellcheck={false}
      onKeyDown={(event) => event.key === "Enter" && commit(event.currentTarget)}
      onBlur={(event) => commit(event.currentTarget)}
    />
  );
}

/**
 * The parameters entry's dialog (research/17-parameters.md, "The parameters entry"): each parameter's
 * name, default in the code, the value this user shows the model with, and unit; the derived
 * parameters; and the configurations, which this user picks, tries values over, and saves.
 */
export function ParamsDialog(props: { params: ParamsController; editor: Editor; onClose: () => void; onEditCode: () => void }) {
  const info = () => props.params.info();
  const readOnly = () => info()?.readOnly;
  const [renaming, setRenaming] = createSignal<string>();
  const tried = () => props.params.tried();
  const selected = () => props.params.selected();
  const notice = (why: string | undefined) => props.editor.setNotice(why);
  /** Adds a parameter or derived one, and starts renaming it. */
  const add = (made: { name: string } | { error: string }, kind: "param" | "derived") => {
    if ("error" in made) return notice(made.error);
    queueMicrotask(() => setRenaming(`${kind}:${made.name}`));
  };
  const unit = (name: string, key: string) => info()?.config[key]?.unit ?? unitOf(props.params.quantities().get(name));
  const uses = (name: string) => {
    const analysis = props.editor.analysis();
    return analysis ? usesOf(analysis, name) : 0;
  };
  return (
    <section class="cad-editor__dialog cad-editor__params" aria-label="Parameters" data-feature="parameters">
      <header class="cad-editor__dialog-header">
        <strong>Parameters</strong> <code>main</code>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <Show when={readOnly()}>{(why) => <p class="cad-editor__muted">Only shown here: {why()}.</p>}</Show>
      <div class="cad-editor__params-shown">
        <label>
          <span class="cad-editor__muted">Show with</span>{" "}
          <select class="cad-editor__input" aria-label="Configuration" onChange={(event) => props.params.select(event.currentTarget.value || undefined)}>
            <option value="" selected={!selected()}>
              Defaults
            </option>
            <For each={props.params.configurations.list()}>
              {(c) => (
                <option value={c.id} selected={c.id === selected()?.id}>
                  {c.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={Object.keys(tried()).length > 0}>
          <button class="cad-editor__button" onClick={() => notice(props.params.apply())} title={selected() ? `Keep the values you try in ${selected()!.name}` : "Write the values you try into defaultParams"}>
            {selected() ? `Update ${selected()!.name}` : "Apply to defaults"}
          </button>
          <button class="cad-editor__button" onClick={() => props.params.reset()}>
            Reset
          </button>
        </Show>
        <button class="cad-editor__button" onClick={() => props.params.saveAs()} title="Keep the values the model is shown with as a configuration of the model">
          Save as configuration
        </button>
      </div>
      <table class="cad-editor__params-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Default</th>
            <th title="What the model is shown with, only for you">Shown</th>
            <th>Unit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {/* By position: the parameters are read anew on every edit, and a row's fields must keep the focus while typed in. */}
          <Index each={info()?.params ?? []}>
            {(param) => {
              const config = () => info()?.config[param().key];
              const value = () => tried()[param().key];
              const fromConfiguration = () => selected()?.params[param().key];
              const linked = () => {
                const v = value() ?? fromConfiguration();
                return isLinked(v) ? props.params.configurations.resolve(v.link) : undefined;
              };
              const effective = () => {
                const v = value() ?? fromConfiguration();
                return isLinked(v) ? linked()?.value : (v ?? param().literal);
              };
              const problem = () => (linked()?.problem ? `Its linked value ${linked()!.problem}` : rangeProblem(effective() ?? undefined, config()));
              return (
                <tr data-param={param().key} data-tried={value() !== undefined ? "true" : undefined} title={config()?.description}>
                  <td>
                    <Show
                      when={renaming() !== `param:${param().key}`}
                      fallback={<NameField from={param().key} rename={(to) => props.params.rename(param().key, to)} onNotice={notice} onDone={() => setRenaming(undefined)} />}
                    >
                      <button class="cad-editor__param-name" disabled={!!readOnly()} title={readOnly() ? param().key : `Rename ${param().key} (F2 or double click)`} onDblClick={() => setRenaming(`param:${param().key}`)} onKeyDown={(e) => e.key === "F2" && setRenaming(`param:${param().key}`)}>
                        <code>{param().key}</code>
                        <Show when={config()?.title}>{(title) => <span class="cad-editor__muted">{title()}</span>}</Show>
                      </button>
                    </Show>
                  </td>
                  <td>
                    <ExpressionInput label={`Default of ${param().key}`} value={param().value ?? ""} disabled={!!readOnly()} onCommit={(text) => props.params.setDefault(param().key, text)} />
                  </td>
                  <td>
                    <TryInput
                      label={`Value of ${param().key}`}
                      value={shown(value())}
                      placeholder={linked()?.value !== undefined ? `${linked()!.value} (linked)` : (shown(fromConfiguration()) ?? param().value ?? "")}
                      problem={problem()}
                      onCommit={(v) => props.params.tryValue(param().key, v)}
                    />
                  </td>
                  <td class="cad-editor__muted">{unit(param().local, param().key) ?? ""}</td>
                  <td>
                    <button class="cad-editor__link" aria-label={`Remove ${param().key}`} disabled={!!readOnly() || uses(param().local) > 0} title={uses(param().local) > 0 ? `${param().key} is used in the model` : `Remove ${param().key}`} onClick={() => notice(props.params.remove(param().key))}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            }}
          </Index>
          <Index each={info()?.derived ?? []}>
            {(d) => (
              <tr data-derived={d().name} title={info()?.config[d().name]?.description}>
                <td>
                  <Show when={renaming() !== `derived:${d().name}`} fallback={<NameField from={d().name} rename={(to) => props.params.renameDerived(d().name, to)} onNotice={notice} onDone={() => setRenaming(undefined)} />}>
                    <button class="cad-editor__param-name" title={`Rename ${d().name} (F2 or double click)`} onDblClick={() => setRenaming(`derived:${d().name}`)} onKeyDown={(e) => e.key === "F2" && setRenaming(`derived:${d().name}`)}>
                      <code>{d().name}</code>
                      <Show when={info()?.config[d().name]?.title}>{(title) => <span class="cad-editor__muted">{title()}</span>}</Show>
                    </button>
                  </Show>
                </td>
                <td colSpan={2}>
                  <ExpressionInput label={`Expression of ${d().name}`} value={d().text} onCommit={(text) => props.params.setDerived(d().name, text)} />
                </td>
                <td class="cad-editor__muted">{unit(d().name, d().name) ?? ""}</td>
                <td>
                  <button class="cad-editor__link" aria-label={`Remove ${d().name}`} disabled={uses(d().name) > 0} title={uses(d().name) > 0 ? `${d().name} is used in the model` : `Remove ${d().name}`} onClick={() => notice(props.params.removeDerived(d().name))}>
                    ×
                  </button>
                </td>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" disabled={!!readOnly()} onClick={() => add(props.params.add(), "param")}>
          Add parameter
        </button>
        <button class="cad-editor__button" disabled={!!readOnly()} onClick={() => add(props.params.addDerived(), "derived")}>
          Add derived
        </button>
        <button class="cad-editor__button" onClick={() => props.onEditCode()}>
          Edit code
        </button>
      </footer>
    </section>
  );
}
