import { createMemo, type Accessor } from "solid-js";
import { splice } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { BuildParams } from "../../kernel/protocol.ts";
import { analyze, type Analysis, type FeatureCall } from "../../model/analyze.ts";
import { isLinked, renameParamInConfigurations } from "../../model/configurations.ts";
import { addDerived, addParam, nameProblem, parameters, quantities, removeDerived, removeParam, renameDerived, renameParam, setDefault, setDerived, type ParamEdit, type Parameters, type Quantity } from "../../model/params.ts";
import { applyToText, freshName, setProp, type Edit } from "../../model/splice.ts";
import type { CadModelDoc, Configuration, LinkedValue, ParamValue } from "../../types.ts";
import type { Configurations } from "../configurations.ts";
import type { UiState } from "../uiState.ts";

/**
 * The editor's side of a model's parameters (research/17-parameters.md): the parameters entry's
 * edits of the code, the configurations, and what this user shows the model with: a configuration
 * and values they try over it.
 */
export interface ParamsController {
  /** The parameters as the code has them, while it parses. */
  info: Accessor<Parameters | undefined>;
  quantities: Accessor<Map<string, Quantity>>;
  configurations: Configurations;
  /** The configuration this user shows the model with. */
  selected: Accessor<Configuration | undefined>;
  /** Values this user tries, over the configuration or the defaults; a link tries another document's value. */
  tried: Accessor<Record<string, ParamValue | LinkedValue>>;
  /** What the view builds with over the defaults: the configuration's values and the tried ones. */
  shown: Accessor<BuildParams | undefined>;
  /** Linked values that can't be read. */
  problems: Accessor<string[]>;
  select(id: string | undefined): void;
  /** Tries `value` for parameter `key`; `undefined` stops trying one. */
  tryValue(key: string, value: ParamValue | LinkedValue | undefined): void;
  reset(): void;
  /** Writes the tried values to configuration `id`, else to the selected one, else to the code's defaults, and shows it; says why not, if not. */
  apply(id?: string): string | undefined;
  /** Saves the shown values as a new configuration and shows it. */
  saveAs(): Configuration;
  setDefault(key: string, text: string): boolean;
  /** Adds a parameter, and says its name or why not. */
  add(): { name: string } | { error: string };
  rename(from: string, to: string): Promise<string | undefined>;
  remove(key: string): string | undefined;
  setDerived(name: string, text: string): boolean;
  addDerived(): { name: string } | { error: string };
  renameDerived(from: string, to: string): Promise<string | undefined>;
  removeDerived(name: string): string | undefined;
  /** Makes a parameter of argument `key` of `call`, with its value as the default; says why not, if not. */
  promote(call: FeatureCall, key: string): string | undefined;
}

/** The parameters of `source`, or nothing while it doesn't parse. */
function read(source: string): { analysis: Analysis; p: Parameters } | undefined {
  try {
    const analysis = analyze(source);
    return { analysis, p: parameters(source, analysis) };
  } catch {
    return undefined;
  }
}

const parses = (source: string) => read(source) !== undefined;

/** A value as code: JSON is a JS expression. */
export const asCode = (value: ParamValue) => JSON.stringify(value);

export function createParams(handle: DocHandle<CadModelDoc>, source: Accessor<string>, configurations: Configurations, ui: Pick<UiState, "params" | "setParams">): ParamsController {
  const current = createMemo(() => read(source()));
  const info = () => current()?.p;
  const qs = createMemo(() => {
    const c = current();
    return c ? quantities(c.analysis, c.p) : new Map<string, Quantity>();
  });
  const selected = () => configurations.list().find((c) => c.id === ui.params().configuration);
  const tried = () => ui.params().values ?? {};
  const configured = createMemo(() => configurations.values(selected()?.id, tried()));
  const shown = createMemo(
    () => {
      const values = configured().values;
      return Object.keys(values).length ? values : undefined;
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  /** Applies the edits `make` computes against the current code, in one change with `also`, if the code still parses with them. */
  const edit = (make: (text: string, a: Analysis, p: Parameters) => ParamEdit, also?: (d: CadModelDoc) => void): string | undefined => {
    const text = handle.doc()?.source ?? "";
    const c = read(text);
    if (!c) return "The code doesn't parse";
    const result = make(text, c.analysis, c.p);
    if ("error" in result) return result.error;
    if (!parses(applyToText(text, result.edits))) return "That would break the code";
    handle.change((d) => {
      for (const e of [...result.edits].sort((a, b) => b.start - a.start)) splice(d, ["source"], e.start, e.end - e.start, e.text);
      also?.(d);
    });
    return undefined;
  };
  const free = (p: Parameters, a: Analysis, text: string, base: string) => (nameProblem(a, p, base) ? freshName(text, base) : base);
  const tryValue = (key: string, value: ParamValue | LinkedValue | undefined) => {
    const values = { ...tried() };
    if (value === undefined) delete values[key];
    else values[key] = value;
    ui.setParams({ ...ui.params(), values });
  };

  return {
    info,
    quantities: qs,
    configurations,
    selected,
    tried,
    shown,
    problems: () => configured().problems,
    select: (id) => ui.setParams({ configuration: id }),
    tryValue,
    reset: () => ui.setParams({ configuration: ui.params().configuration }),
    apply(id) {
      const values = tried();
      const configuration = id ? configurations.list().find((c) => c.id === id) : selected();
      if (configuration) configurations.setValues(configuration.id, values);
      else {
        const why = edit((text, _, p) => {
          const edits: Edit[] = [];
          for (const [key, value] of Object.entries(values)) {
            if (isLinked(value)) return { error: `${key} links to another document's value, which only a configuration can keep` };
            const r = setDefault(text, p, key, asCode(value));
            if ("error" in r) return r;
            edits.push(...r.edits);
          }
          return { edits };
        });
        if (why) return why;
      }
      ui.setParams({ configuration: configuration?.id });
      return undefined;
    },
    saveAs() {
      const base = selected();
      const configuration = configurations.add(base ? base.name : "Configuration", { ...(base?.params ?? {}), ...tried() });
      ui.setParams({ configuration: configuration.id });
      return configuration;
    },
    setDefault: (key, text) => edit((t, _, p) => setDefault(t, p, key, text)) === undefined,
    add() {
      let name = "";
      const why = edit((text, a, p) => addParam(text, a, p, (name = free(p, a, text, "param")), "10"));
      return why ? { error: why } : { name };
    },
    async rename(from, to) {
      const why = edit(
        (_, a, p) => renameParam(a, p, from, to),
        (d) => renameParamInConfigurations(d, from, to),
      );
      if (why) return why;
      const values = { ...tried() };
      if (from in values) {
        values[to] = values[from]!;
        delete values[from];
        ui.setParams({ ...ui.params(), values });
      }
      return undefined;
    },
    remove(key) {
      const why = edit((_, a, p) => removeParam(a, p, key));
      if (!why && key in tried()) tryValue(key, undefined);
      return why;
    },
    setDerived(name, text) {
      return (
        edit((_, __, p) => {
          const d = p.derived.find((x) => x.name === name);
          return d ? { edits: setDerived(d, text) } : { error: `there is no derived parameter ${name}` };
        }) === undefined
      );
    },
    addDerived() {
      let name = "";
      const why = edit((text, a, p) => addDerived(text, a, p, (name = free(p, a, text, "value")), "0"));
      return why ? { error: why } : { name };
    },
    renameDerived: async (from, to) => edit((_, a, p) => renameDerived(a, p, from, to)),
    removeDerived: (name) => edit((text, a, p) => removeDerived(text, a, p, name)),
    promote(open, key) {
      return edit((text, a, p) => {
        // The call in the code as it is now.
        const call = a.calls.find((c) => c.span.start === open.span.start && c.type === open.type);
        const prop = call?.props?.find((x) => x.key === key);
        if (!call) return { error: "the feature has changed" };
        if (!prop) return { error: `${key} has no value` };
        const name = free(p, a, text, key);
        const added = addParam(text, a, p, name, text.slice(prop.value.start, prop.value.end));
        if ("error" in added) return added;
        return { edits: [...setProp(call, key, name), ...added.edits] };
      });
    },
  };
}
