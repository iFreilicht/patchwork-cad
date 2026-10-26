import * as A from "@automerge/automerge";
import { expect, test } from "vitest";
import { UndoManager } from "../src/index.ts";
import { Peer, sync } from "./peers.ts";

type Doc = {
  alice: string;
  bob: string;
};

const append = (peer: Peer<Doc>, key: keyof Doc, text: string) =>
  peer.change((d) => A.splice(d, [key], d[key].length, 0, text));

test("the scenario from research/16: each user undoes only their own steps, and undo runs are steps", () => {
  const base = A.from<Doc>({ alice: "", bob: "" });
  const alice = new Peer(base);
  const bob = new Peer(base);
  const ua = new UndoManager(alice, { groupDelayMs: 0 });
  const ub = new UndoManager(bob, { groupDelayMs: 0 });
  const state = () => {
    sync(alice, bob);
    expect(alice.doc()).toEqual(bob.doc());
    return `${alice.doc().alice}|${alice.doc().bob}`;
  };

  append(alice, "alice", "a"); // 1. A
  state();
  append(bob, "bob", "b"); // 2. B
  state();
  append(alice, "alice", "c"); // 3. C
  state();
  append(bob, "bob", "d"); // 4. D
  state();
  append(alice, "alice", "e"); // 5. E
  state();
  append(bob, "bob", "f"); // 6. F
  expect(state()).toBe("ace|bdf");

  ua.undo(); // 7. G: undoes E …
  expect(state()).toBe("ac|bdf");
  ua.undo(); // … and C
  expect(state()).toBe("a|bdf");

  append(bob, "bob", "h"); // 8. H
  expect(state()).toBe("a|bdfh");
  append(alice, "alice", "i"); // 9. I, on top of A
  expect(state()).toBe("ai|bdfh");
  ub.undo(); // 10. J: undoes H
  expect(state()).toBe("ai|bdf");

  ua.undo(); // 11. K: undoes I …
  expect(state()).toBe("a|bdf");
  ua.undo(); // … G, which redoes C and E …
  expect(state()).toBe("ace|bdf");
  ua.undo(); // … and E
  expect(state()).toBe("ac|bdf");

  append(bob, "bob", "l"); // 12. L
  expect(state()).toBe("ac|bdfl");

  // Alice's history: A, C, E, G (two undos), I, and the current run K.
  expect(ua.steps.map((s) => s.length)).toEqual([1, 1, 1, 2, 1]);
  // Bob's: B, D, F, H, and the run J that L ended.
  expect(ub.steps.map((s) => s.length)).toEqual([1, 1, 1, 1, 1, 1]);
});

test("redo inside a run; a run back to its start leaves no step", () => {
  const alice = new Peer(A.from<Doc>({ alice: "", bob: "" }));
  const ua = new UndoManager(alice, { groupDelayMs: 0 });
  append(alice, "alice", "a");
  append(alice, "alice", "b");
  ua.undo();
  ua.undo();
  expect(alice.doc().alice).toBe("");
  expect(ua.canRedo()).toBe(true);
  ua.redo();
  expect(alice.doc().alice).toBe("a");
  ua.redo();
  expect(alice.doc().alice).toBe("ab");
  expect(ua.canRedo()).toBe(false);
  append(alice, "alice", "c");
  expect(ua.steps.length).toBe(3);
  expect(ua.canRedo()).toBe(false);
});

test("changes within the group delay form one step", () => {
  let now = 0;
  const alice = new Peer(A.from<Doc>({ alice: "", bob: "" }));
  const ua = new UndoManager(alice, { groupDelayMs: 500, now: () => now });
  for (const ch of "hello") {
    append(alice, "alice", ch);
    now += 100;
  }
  now += 1000;
  append(alice, "alice", "!");
  expect(ua.steps.map((s) => s.length)).toEqual([5, 1]);
  ua.undo();
  ua.undo();
  expect(alice.doc().alice).toBe("");
});
