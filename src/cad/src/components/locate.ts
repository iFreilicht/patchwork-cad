import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import type { Model } from "./createModel.ts";

/** Where a reference's faces or edges are in the shown bodies. */
export type Located = { body: string; indices: number[] }[];

/**
 * Resolves references to faces and edges against the bodies a view shows, in the worker (the
 * feature library's `resolve`), so that they apply across builds and rollback states: a
 * collaborator's pick (research/13) or a comment's face or edge. Each item comes back with its
 * entities, none if its reference resolves to nothing. The worker is asked only when the items or
 * the bodies change.
 */
export function createLocated<T extends { ref: RefData }>(model: Model, shown: Accessor<MeshedShape[]>, items: Accessor<T[]>): Accessor<{ item: T; found: Located }[]> {
  const key = createMemo(() => JSON.stringify(items()));
  const [located, setLocated] = createSignal<{ item: T; found: Located }[]>([]);
  let request = 0;
  createEffect(() => {
    const wanted = JSON.parse(key()) as T[];
    const bodies = [...new Set(shown().flatMap((s) => (s.body ? [s.body] : [])))];
    const id = ++request;
    if (!wanted.length || !bodies.length) {
      setLocated(wanted.map((item) => ({ item, found: [] })));
      return;
    }
    model.engine.locate(
      bodies,
      wanted.map((w) => w.ref),
    ).then(
      (found) => id === request && setLocated(wanted.map((item, i) => ({ item, found: found[i] ?? [] }))),
      () => undefined,
    );
  });
  return located;
}
