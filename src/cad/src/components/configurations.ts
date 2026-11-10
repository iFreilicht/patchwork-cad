import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { addConfiguration, configurations, isLinked, removeConfiguration, renameConfiguration, setConfigurationValues } from "../model/configurations.ts";
import { freeName, nameProblem, newId } from "../model/views.ts";
import type { CadModelDoc, Configuration, LinkedValue, ParamValue } from "../types.ts";

/** A linked value as read from its document: a number, or why there is none (research/17, "Values from other documents"). */
export type Resolved = { value: number; problem?: undefined } | { value?: undefined; problem: string };

export interface Configurations {
  list: Accessor<Configuration[]>;
  /** Adds a configuration of `params`, named `base` or numbered after it, and returns it. */
  add(base: string, params: Configuration["params"]): Configuration;
  /** Renames configuration `id`, or says why it can't. */
  rename(id: string, name: string): string | undefined;
  /** Sets values of configuration `id`; `undefined` makes one the default again. */
  setValues(id: string, values: Record<string, ParamValue | LinkedValue | undefined>): void;
  remove(id: string): void;
  /** A linked value, as its document has it now. */
  resolve(link: AutomergeUrl): Resolved;
  /** The values configuration `id` builds with, links read, and why some aren't there. */
  values(id: string | undefined): { values: Record<string, ParamValue>; problems: string[] };
}

/** A number in text, e.g. a cursor range into a note: digits, with a sign and a decimal point. */
const NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** A linked value from what its URL resolves to. */
export function resolvedFrom(value: unknown): Resolved {
  if (typeof value === "number" && Number.isFinite(value)) return { value };
  if (typeof value === "string" && NUMBER.test(value)) return { value: Number(value) };
  if (value === undefined) return { problem: "isn't there any more" };
  if (value === "") return { problem: "its text was deleted" };
  return { problem: `is ${JSON.stringify(value).slice(0, 40)}, not a number` };
}

/**
 * The configurations of a model (research/17-parameters.md), following its document, and the values
 * they link to in other documents, which are read as those change.
 */
export function createConfigurations(handle: DocHandle<CadModelDoc>): Configurations {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));
  // Edits of the code mustn't look like a change of the configurations.
  const list = createMemo(() => configurations(doc()), [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  const [resolved, setResolved] = createSignal(new Map<string, Resolved>());
  const watched = new Map<string, () => void>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const stop of watched.values()) stop();
  });
  const set = (url: string, r: Resolved) => setResolved((m) => new Map(m).set(url, r));
  const watch = (url: AutomergeUrl) => {
    if (watched.has(url)) return;
    // Called while values are computed: answers arrive later, and "is loading" until then.
    watched.set(url, () => {});
    const repo = globalThis.repo;
    if (!repo) return void queueMicrotask(() => set(url, { problem: "can't be read outside Patchwork" }));
    repo.find<unknown>(url).then(
      (linked) => {
        if (disposed) return;
        const read = () => set(url, resolvedFrom(linked.doc()));
        linked.on("change", read);
        watched.set(url, () => linked.off("change", read));
        read();
      },
      (error: unknown) => set(url, { problem: `can't be loaded: ${String((error as Error)?.message ?? error)}` }),
    );
  };
  const resolve = (link: AutomergeUrl): Resolved => {
    watch(link);
    return resolved().get(link) ?? { problem: "is loading" };
  };

  return {
    list,
    add(base, params) {
      const configuration = { id: newId(), name: freeName(base, configurations(handle.doc())), params };
      handle.change((d) => addConfiguration(d, configuration));
      return configuration;
    },
    rename(id, name) {
      const why = nameProblem(configurations(handle.doc()), id, name, "configuration");
      if (!why) handle.change((d) => renameConfiguration(d, id, name));
      return why;
    },
    setValues: (id, values) => handle.change((d) => setConfigurationValues(d, id, values)),
    remove: (id) => handle.change((d) => removeConfiguration(d, id)),
    resolve,
    values(id) {
      const c = list().find((x) => x.id === id);
      const values: Record<string, ParamValue> = {};
      const problems: string[] = [];
      for (const [key, value] of Object.entries(c?.params ?? {})) {
        if (!isLinked(value)) values[key] = value as ParamValue;
        else {
          const r = resolve(value.link);
          if (r.problem === undefined) values[key] = r.value;
          else problems.push(`${key}: its linked value ${r.problem}`);
        }
      }
      return { values, problems };
    },
  };
}
