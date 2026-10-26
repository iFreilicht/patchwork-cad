import * as A from "@automerge/automerge";
import type { UndoableHandle } from "../src/index.ts";

type Listener = (payload: { scopeReplaced?: boolean }) => void;

/** An in-memory stand-in for a DocHandle in one tab. */
export class Peer<T> implements UndoableHandle<T> {
  #doc: A.Doc<T>;
  #listeners = new Set<Listener>();

  constructor(doc: A.Doc<T>) {
    // Each tab loads the document with its own actor; A.clone would keep the actor.
    this.#doc = A.load<T>(A.save(doc));
  }

  doc() {
    return this.#doc;
  }

  change(fn: A.ChangeFn<T>) {
    const before = this.#doc;
    this.#doc = A.change(this.#doc, fn);
    if (this.#doc !== before) this.#emit();
  }

  /** Receives everything `other` has. */
  pull(other: Peer<T>) {
    const before = A.getHeads(this.#doc);
    this.#doc = A.merge(this.#doc, other.doc());
    if (A.getHeads(this.#doc).join() !== before.join()) this.#emit();
  }

  on(_: "change", fn: Listener) {
    this.#listeners.add(fn);
  }

  off(_: "change", fn: Listener) {
    this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) fn({});
  }
}

export const sync = <T>(...peers: Peer<T>[]) => {
  for (const p of peers) for (const q of peers) if (p !== q) p.pull(q);
};
