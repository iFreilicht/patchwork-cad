import { createSignal, For, Index, Show, type JSX } from "solid-js";
import type { ParamValues } from "../../kernel/protocol.ts";
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
function rangeProblem(value: unknown, config: ParamConfig | undefined): string | undefined {
  if (typeof value !== "number" || !config) return undefined;
  if (config.minimum !== undefined && value < config.minimum) return `less than the minimum, ${config.minimum}`;
  if (config.maximum !== undefined && value > config.maximum) return `more than the maximum, ${config.maximum}`;
  if (config.multipleOf !== undefined && Math.abs(value / config.multipleOf - Math.round(value / config.multipleOf)) > 1e-9) return `not a multiple of ${config.multipleOf}`;
  return undefined;
}

/**
 * A parameter's override in a configuration: JSON, or an automerge URL that resolves to a number. It
 * applies on Enter or when the field is left; an empty field takes the default.
 */
function OverrideInput(props: { label: string; value: string | undefined; onCommit: (value: ParamValue | LinkedValue | undefined) => void; problem: string | undefined }) {
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
      title={props.problem ?? "This configuration's value: JSON, or an automerge URL of another document's number; empty for the default"}
      value={props.value ?? ""}
      spellcheck={false}
      onKeyDown={(event) => event.key === "Enter" && commit(event.currentTarget)}
      onBlur={(event) => commit(event.currentTarget)}
    />
  );
}

/** A value the build computed, as text: numbers to six significant digits, which the column fits; "–" when there is none. */
function formatValue(value: unknown, digits = 6): string {
  if (value === undefined) return "–";
  if (typeof value === "number") return String(Number(value.toPrecision(digits)));
  return JSON.stringify(value);
}

/** A final value, marked when it is outside what paramConfig allows. */
function FinalValue(props: { value: unknown; problem: string | undefined }): JSX.Element {
  return (
    <td class="cad-editor__param-final" data-problem={props.problem ? "true" : undefined} title={props.problem ? `${formatValue(props.value, 15)} is ${props.problem}` : formatValue(props.value, 15)}>
      {formatValue(props.value)}
    </td>
  );
}

/** A parameter's or derived value's name: renamed with F2 or a double click while the defaults are shown. */
function NameCell(props: { name: string; title: string | undefined; editable: boolean; renaming: boolean; onRename: () => void; rename: (to: string) => Promise<string | undefined>; onNotice: (why: string | undefined) => void; onDone: () => void }) {
  return (
    <td title={props.title ? `${props.name}: ${props.title}` : props.name}>
      <Show when={!props.renaming} fallback={<NameField from={props.name} rename={props.rename} onNotice={props.onNotice} onDone={props.onDone} />}>
        <Show
          when={props.editable}
          fallback={
            <span class="cad-editor__param-name">
              <code>{props.name}</code>
              <Show when={props.title}>{(title) => <span class="cad-editor__muted">{title()}</span>}</Show>
            </span>
          }
        >
          <button class="cad-editor__param-name" title={`Rename ${props.name} (F2 or double click)`} onDblClick={() => props.onRename()} onKeyDown={(e) => e.key === "F2" && props.onRename()}>
            <code>{props.name}</code>
            <Show when={props.title}>{(title) => <span class="cad-editor__muted">{title()}</span>}</Show>
          </button>
        </Show>
      </Show>
    </td>
  );
}

/**
 * The parameters entry's dialog (research/17-parameters.md, "The parameters entry"). With the defaults
 * shown, it edits the code: each parameter's default, the derived values' expressions, and which
 * there are. With a configuration shown, it edits that configuration's overrides, next to each
 * parameter's default and final value; derived values follow from them and show their final value.
 */
export function ParamsDialog(props: { params: ParamsController; editor: Editor; values: () => ParamValues | undefined; onClose: () => void; onEditCode: (section: "params" | "derived") => void }) {
  const info = () => props.params.info();
  const readOnly = () => info()?.readOnly;
  const selected = () => props.params.selected();
  /** The code is edited only while the defaults are shown, and only if the editor can write it. */
  const editable = () => !selected() && !readOnly();
  const [renaming, setRenaming] = createSignal<string>();
  const notice = (why: string | undefined) => props.editor.setNotice(why);
  /** Adds a parameter or derived value, and starts renaming it. */
  const add = (made: { name: string } | { error: string }, kind: "param" | "derived") => {
    if ("error" in made) return notice(made.error);
    queueMicrotask(() => setRenaming(`${kind}:${made.name}`));
  };
  const unit = (name: string, key: string) => info()?.config[key]?.unit ?? unitOf(props.params.quantities().get(name));
  /** A table's buttons: adding to it and its code with the defaults shown, else back to the defaults; its code. */
  const actions = (section: "params" | "derived") => (
    <div class="cad-editor__params-actions">
      <Show when={editable()}>
        <button class="cad-editor__button" onClick={() => (section === "params" ? add(props.params.add(), "param") : add(props.params.addDerived(), "derived"))}>
          {section === "params" ? "Add parameter" : "Add derived value"}
        </button>
      </Show>
      <Show when={selected() && !readOnly()}>
        <button class="cad-editor__button" onClick={() => props.params.select(undefined)}>
          Switch back to Defaults to edit
        </button>
      </Show>
      <button class="cad-editor__button" aria-label={section === "params" ? "Edit code of the parameters" : "Edit code of the derived values"} onClick={() => props.onEditCode(section)}>
        Edit code
      </button>
    </div>
  );
  const uses = (name: string) => {
    const analysis = props.editor.analysis();
    return analysis ? usesOf(analysis, name) : 0;
  };
  return (
    <section class="cad-editor__dialog cad-editor__params" aria-label="Parameters" data-feature="parameters" data-configuration={selected()?.name ?? ""}>
      <header class="cad-editor__dialog-header">
        <strong>Parameters</strong>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <Show when={readOnly()}>{(why) => <p class="cad-editor__muted">Only shown here: {why()}.</p>}</Show>
      <div class="cad-editor__params-shown">
        <label>
          <span class="cad-editor__muted">Configuration</span>{" "}
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
        <button class="cad-editor__button" onClick={() => props.params.saveAs()} title="Keep the values the model is shown with as a new configuration of the model">
          Save as new configuration
        </button>
      </div>
      <table class="cad-editor__params-table" aria-label="Parameters">
        <thead>
          <tr>
            <th class="cad-editor__param-name-column">Name</th>
            <th title="defaultParams in the code">Default</th>
            <Show when={selected()}>
              <th class="cad-editor__param-field" title={`What ${selected()?.name} sets; empty: the default`}>
                Override
              </th>
            </Show>
            <th class="cad-editor__param-final">Final value</th>
            <th class="cad-editor__param-unit">Unit</th>
            <th class="cad-editor__param-remove" />
          </tr>
        </thead>
        <tbody>
          {/* By position: the parameters are read anew on every edit, and a row's fields must keep the focus while typed in. */}
          <Index each={info()?.params ?? []}>
            {(param) => {
              const config = () => info()?.config[param().key];
              /** Its override in the shown configuration, if it sets one. */
              const value = () => selected()?.params[param().key];
              const linked = () => {
                const v = value();
                return isLinked(v) ? props.params.configurations.resolve(v.link) : undefined;
              };
              const final = () => props.values()?.params[param().key];
              return (
                <tr data-param={param().key} data-configured={value() !== undefined ? "true" : undefined} title={config()?.description}>
                  <NameCell
                    name={param().key}
                    title={config()?.title}
                    editable={editable()}
                    renaming={renaming() === `param:${param().key}`}
                    onRename={() => setRenaming(`param:${param().key}`)}
                    rename={(to) => props.params.rename(param().key, to)}
                    onNotice={notice}
                    onDone={() => setRenaming(undefined)}
                  />
                  <Show when={editable()} fallback={<td class="cad-editor__param-default"><code>{param().value ?? "–"}</code></td>}>
                    <td>
                      <ExpressionInput label={`Default of ${param().key}`} value={param().value ?? ""} onCommit={(text) => props.params.setDefault(param().key, text)} />
                    </td>
                  </Show>
                  {/* Read directly, not through an accessor of the Show, which throws when read after switching back to the defaults. */}
                  <Show when={selected()}>
                    <td>
                      <OverrideInput label={`${param().key} in ${selected()?.name ?? ""}`} value={shown(value())} problem={linked()?.problem ? `Its linked value ${linked()!.problem}` : undefined} onCommit={(v) => props.params.setValue(param().key, v)} />
                    </td>
                  </Show>
                  <FinalValue value={final()} problem={rangeProblem(final(), config())} />
                  <td class="cad-editor__muted cad-editor__param-unit">{unit(param().local, param().key) ?? ""}</td>
                  <Show when={editable()} fallback={<td />}>
                    <td>
                      <button class="cad-editor__link" aria-label={`Remove ${param().key}`} disabled={uses(param().local) > 0} title={uses(param().local) > 0 ? `${param().key} is used in the model` : `Remove ${param().key}`} onClick={() => notice(props.params.remove(param().key))}>
                        ×
                      </button>
                    </td>
                  </Show>
                </tr>
              );
            }}
          </Index>
        </tbody>
      </table>
      {actions("params")}
      <h3 class="cad-editor__params-heading">Derived values</h3>
      <Show when={(info()?.derived.length ?? 0) > 0}>
        <table class="cad-editor__params-table cad-editor__params-table--derived" aria-label="Derived values">
          <thead>
            <tr>
              <th class="cad-editor__param-name-column">Name</th>
              <th>Expression</th>
              <th class="cad-editor__param-final">Final value</th>
              <th class="cad-editor__param-unit">Unit</th>
              <th class="cad-editor__param-remove" />
            </tr>
          </thead>
          <tbody>
            <Index each={info()?.derived ?? []}>
              {(d) => {
                const final = () => props.values()?.derived[d().name];
                return (
                  <tr data-derived={d().name} title={info()?.config[d().name]?.description}>
                    <NameCell
                      name={d().name}
                      title={info()?.config[d().name]?.title}
                      editable={editable()}
                      renaming={renaming() === `derived:${d().name}`}
                      onRename={() => setRenaming(`derived:${d().name}`)}
                      rename={(to) => props.params.renameDerived(d().name, to)}
                      onNotice={notice}
                      onDone={() => setRenaming(undefined)}
                    />
                    <Show when={editable()} fallback={<td class="cad-editor__param-default"><code>{d().text}</code></td>}>
                      <td>
                        <ExpressionInput label={`Expression of ${d().name}`} value={d().text} onCommit={(text) => props.params.setDerived(d().name, text)} />
                      </td>
                    </Show>
                    <FinalValue value={final()} problem={rangeProblem(final(), info()?.config[d().name])} />
                    <td class="cad-editor__muted cad-editor__param-unit">{unit(d().name, d().name) ?? ""}</td>
                    <Show when={editable()} fallback={<td />}>
                      <td>
                        <button class="cad-editor__link" aria-label={`Remove ${d().name}`} disabled={uses(d().name) > 0} title={uses(d().name) > 0 ? `${d().name} is used in the model` : `Remove ${d().name}`} onClick={() => notice(props.params.removeDerived(d().name))}>
                          ×
                        </button>
                      </td>
                    </Show>
                  </tr>
                );
              }}
            </Index>
          </tbody>
        </table>
      </Show>
      {actions("derived")}
    </section>
  );
}
