import * as A from "@automerge/automerge";
import { expect, test } from "vitest";
import { UndoManager } from "../src/index.ts";
import { Peer, sync } from "./peers.ts";

type Section = { t: string; m: Record<string, unknown>; l: number[]; r: Record<string, { text: string; n: number }> };
type Doc = { alice: Section; bob: Section };

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

const edit = (rand: () => number, s: Section, overwrite: boolean) => {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const keys = ["a", "b", "c"];
  switch (pick(["text", "text", "map", "list", "rec"])) {
    case "text": {
      const at = Math.floor(rand() * (s.t.length + 1));
      if (rand() < 0.6 || !s.t.length) A.splice(s, ["t"], at, 0, pick(["x", "yz", "hello "]));
      else A.splice(s, ["t"], Math.min(at, s.t.length - 1), 1 + Math.floor(rand() * 3));
      break;
    }
    case "map": {
      const k = pick(keys);
      if (rand() < 0.3) delete s.m[k];
      else {
        const v = rand() < 0.3 ? { v: Math.floor(rand() * 9) } : Math.floor(rand() * 9);
        // Writing an equal value is a change with an effect for Automerge (a put patch; a new object), not for the oracle's JSON comparison.
        if (!same(s.m[k], v)) s.m[k] = v;
      }
      break;
    }
    case "list": {
      if (rand() < 0.5 || !s.l.length) s.l.splice(Math.floor(rand() * (s.l.length + 1)), 0, Math.floor(rand() * 9));
      else if (rand() < 0.5 || !overwrite) s.l.splice(Math.floor(rand() * s.l.length), 1);
      else {
        const i = Math.floor(rand() * s.l.length);
        const v = Math.floor(rand() * 9);
        if (s.l[i] !== v) s.l[i] = v;
      }
      break;
    }
    case "rec": {
      const k = pick(keys);
      const rec = s.r[k];
      if (!rec) s.r[k] = { text: "r", n: 0 };
      else if (rand() < 0.2) delete s.r[k];
      else if (rand() < 0.5) {
        const n = Math.floor(rand() * 9);
        if (rec.n !== n) rec.n = n;
      }
      else A.splice(rec, ["text"], Math.floor(rand() * (rec.text.length + 1)), 0, "q");
    }
  }
};

/** JSON equality regardless of key order: the order of a doc's keys follows the order of patches. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, canonical(x)])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The expected history of one user: snapshots of their section, Emacs-style. */
class Oracle {
  states: unknown[];
  run: { start: number; pointer: number } | undefined;
  constructor(initial: unknown) {
    this.states = [initial];
  }
  get current() {
    return this.run ? this.states[this.run.pointer] : this.states.at(-1);
  }
  edited(state: unknown, newStep: boolean) {
    if (this.run) {
      if (this.run.pointer < this.run.start) this.states.push(this.states[this.run.pointer]);
      this.run = undefined;
      newStep = true;
    }
    if (newStep) this.states.push(state);
    else this.states[this.states.length - 1] = state;
  }
  // Steps without net effect are skipped.
  undo() {
    const run = (this.run ??= { start: this.states.length - 1, pointer: this.states.length - 1 });
    if (run.pointer === 0) return;
    do run.pointer--;
    while (run.pointer > 0 && same(this.states[run.pointer], this.states[run.pointer + 1]));
  }
  redo() {
    const run = this.run;
    if (!run || run.pointer === run.start) return;
    do run.pointer++;
    while (run.pointer < run.start && same(this.states[run.pointer], this.states[run.pointer - 1]));
  }
}

const empty = (): Section => ({ t: "", m: {}, l: [], r: {} });
const snapshot = (s: Section) => JSON.parse(JSON.stringify(s));

for (const overwrite of [false, true])
// FUZZ_SEEDS and FUZZ_STEPS run a longer fuzz.
for (let seed = 1; seed <= Number(process.env["FUZZ_SEEDS"] ?? 40); seed++) {
  test(`two users, own sections, random edits, undos and redos (seed ${seed}${overwrite ? ", list elements overwritten" : ""})`, () => {
    const rand = rng(seed);
    let now = 0;
    const base = A.from<Doc>({ alice: empty(), bob: empty() });
    const peers = { alice: new Peer(base), bob: new Peer(base) } as const;
    const undo = {
      alice: new UndoManager(peers.alice, { groupDelayMs: 500, adjacentOnly: false, now: () => now }),
      bob: new UndoManager(peers.bob, { groupDelayMs: 500, adjacentOnly: false, now: () => now }),
    };
    const lastEdit = { alice: -Infinity, bob: -Infinity };
    const oracle = { alice: new Oracle(snapshot(empty())), bob: new Oracle(snapshot(empty())) };
    for (let i = 0; i < Number(process.env["FUZZ_STEPS"] ?? 150); i++) {
      const who = rand() < 0.5 ? "alice" : "bob";
      const r = rand();
      // Steps group changes less than 500 ms apart.
      now += rand() < 0.3 ? 100 : 1000;
      if (r < 0.6) {
        const before = A.getHeads(peers[who].doc()).join();
        peers[who].change((d) => edit(rand, d[who], overwrite));
        // An edit without effect (e.g. deleting a missing key) makes no change.
        if (A.getHeads(peers[who].doc()).join() !== before) {
          oracle[who].edited(snapshot(peers[who].doc()[who]), now - lastEdit[who] >= 500);
          lastEdit[who] = now;
        }
      } else if (r < 0.85) {
        undo[who].undo();
        oracle[who].undo();
      } else {
        undo[who].redo();
        oracle[who].redo();
      }
      if (rand() < 0.4) sync(peers.alice, peers.bob);
      for (const u of ["alice", "bob"] as const) expect(snapshot(peers[u].doc()[u]), `${u} after step ${i}`).toEqual(oracle[u].current);
    }
    sync(peers.alice, peers.bob);
    expect(peers.alice.doc()).toEqual(peers.bob.doc());
  });
}
