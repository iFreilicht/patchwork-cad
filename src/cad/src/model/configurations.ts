import type { CadModelDoc, Configuration, LinkedValue, ParamValue } from "../types.ts";

/**
 * Configurations (research/17-parameters.md, "Configurations and named views in the model
 * document"): named sets of values of the model's parameters, kept in its document next to the
 * code, under `cad.configurations`, as named views are. The edits run inside a `change` of it.
 */

export const configurations = (doc: CadModelDoc | undefined): Configuration[] => doc?.cad?.configurations ?? [];

export const isLinked = (value: ParamValue | LinkedValue | undefined): value is LinkedValue => typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { link?: unknown }).link === "string";

/** A copy that shares nothing with `value`, which may be another document's. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function addConfiguration(doc: CadModelDoc, configuration: Configuration): void {
  // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
  if (!doc.cad) doc.cad = {};
  if (!doc.cad.configurations) doc.cad.configurations = [];
  doc.cad.configurations.push({ id: configuration.id, name: configuration.name, params: copy(configuration.params) });
}

export function renameConfiguration(doc: CadModelDoc, id: string, name: string): void {
  const c = doc.cad?.configurations?.find((x) => x.id === id);
  if (c && c.name !== name) c.name = name;
}

/** Sets the values of configuration `id`: `undefined` removes a parameter's value, which then is the default. */
export function setConfigurationValues(doc: CadModelDoc, id: string, values: Record<string, ParamValue | LinkedValue | undefined>): void {
  const c = doc.cad?.configurations?.find((x) => x.id === id);
  if (!c) return;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete c.params[key];
    else c.params[key] = copy(value);
  }
}

export function removeConfiguration(doc: CadModelDoc, id: string): void {
  const list = doc.cad?.configurations;
  const at = list?.findIndex((x) => x.id === id) ?? -1;
  if (list && at >= 0) list.splice(at, 1);
}

/** Moves every configuration's value of parameter `from` to `to`, as renaming it in the code does. */
export function renameParamInConfigurations(doc: CadModelDoc, from: string, to: string): void {
  for (const c of doc.cad?.configurations ?? []) {
    const value = c.params[from];
    if (value === undefined) continue;
    delete c.params[from];
    c.params[to] = copy(value);
  }
}
