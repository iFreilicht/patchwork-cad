import { createMemo, type Accessor } from "solid-js";
import { splice } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { BuildParams } from "../../kernel/protocol.ts";
import { analyze, type Analysis, type FeatureCall } from "../../model/analyze.ts";
import { renameParamInConfigurations } from "../../model/configurations.ts";
import { addDerived, addParam, nameProblem, parameters, quantities, removeDerived, removeParam, renameDerived, renameParam, setDefault, setDerived, type ParamEdit, type Parameters, type Quantity } from "../../model/params.ts";
import { applyToText, freshName, setProp } from "../../model/splice.ts";
import type { CadModelDoc, Configuration, LinkedValue, ParamValue } from "../../types.ts";
import type { Configurations } from "../configurations.ts";
import type { UiState } from "../uiState.ts";

/**
 * The editor's side of a model's parameters (research/17-parameters.md): the parameters entry's
 * edits of the code, the configurations and their values, and the configuration this user shows
 * the model with.
 */
export interface ParamsController {
  /** The parameters as the code has them, while it parses. */
  info: Accessor<Parameters | undefined>;
  quantities: Accessor<Map<string, Quantity>>;
  configurations: Configurations;
  /** The configuration this user shows the model with. */
  selected: Accessor<Configuration | undefined>;
  /** What the view builds with over the defaults: the selected configuration's values. */
  shown: Accessor<BuildParams | undefined>;
  /** Linked values that can't be read. */
  problems: Accessor<string[]>;
  /** Shows the model with configuration `id`, or with the defaults, only for this user. */
  select(id: string | undefined): void;
  /** Sets parameter `key`'s value in the selected configuration: JSON, or a link to another document's number; `undefined` makes it the default again. */
  setValue(key: string, value: ParamValue | LinkedValue | undefined): void;
  /** Adds a configuration with the shown one's overrides, none from the defaults, and shows it. */
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
  const configured = createMemo(() => configurations.values(selected()?.id));
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
  return {
    info,
    quantities: qs,
    configurations,
    selected,
    shown,
    problems: () => configured().problems,
    select: (id) => ui.setParams({ configuration: id }),
    setValue(key, value) {
      const configuration = selected();
      if (configuration) configurations.setValues(configuration.id, { [key]: value });
    },
    saveAs() {
      // A copy of the shown configuration's overrides; from the defaults, none.
      const base = selected();
      const configuration = configurations.add(base ? base.name : "Configuration", { ...(base?.params ?? {}) });
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
      return why;
    },
    remove: (key) => edit((_, a, p) => removeParam(a, p, key)),
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
