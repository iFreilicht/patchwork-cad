import * as A from "@automerge/automerge";
import { describe, expect, test } from "vitest";
import { UndoManager, type UndoOptions } from "../src/index.ts";
import { Peer, sync } from "./peers.ts";

const pair = <T>(init: T, opts: UndoOptions = {}) => {
  const base = A.from<any>(init as any) as A.Doc<T>;
  const alice = new Peer(base);
  const bob = new Peer(base);
  return {
    alice,
    bob,
    ua: new UndoManager(alice, { groupDelayMs: 0, ...opts }),
    ub: new UndoManager(bob, { groupDelayMs: 0, ...opts }),
  };
};

describe("text both edit", () => {
  test("undo removes only one's own characters, wherever the other typed", () => {
    const { alice, bob, ua } = pair({ t: "" });
    alice.change((d) => A.splice(d, ["t"], 0, 0, "hello world"));
    sync(alice, bob);
    bob.change((d) => A.splice(d, ["t"], 5, 0, ","));
    bob.change((d) => A.splice(d, ["t"], 0, 0, ">"));
    sync(alice, bob);
    expect(alice.doc().t).toBe(">hello, world");
    ua.undo();
    sync(alice, bob);
    expect(bob.doc().t).toBe(">,");
  });

  test("undoing a deletion re-inserts the text around what the other inserted into it concurrently", () => {
    const { alice, bob, ua } = pair({ t: "<hello world>" });
    alice.change((d) => A.splice(d, ["t"], 1, 11));
    bob.change((d) => A.splice(d, ["t"], 6, 0, "X"));
    sync(alice, bob);
    expect(alice.doc().t).toBe("<X>");
    ua.undo();
    sync(alice, bob);
    expect(alice.doc().t).toBe("<helloX world>");
  });

  test("deletions by Delete and by Backspace, one step, come back in order", () => {
    let now = 0;
    const { alice, ua } = pair({ t: "xabcy" }, { groupDelayMs: 500, now: () => now });
    for (let i = 0; i < 3; i++) alice.change((d) => A.splice(d, ["t"], 1, 1)); // Delete ×3
    expect(alice.doc().t).toBe("xy");
    now += 1000;
    alice.change((d) => A.splice(d, ["t"], 0, 0, "abc"));
    now += 1000;
    for (let i = 3; i > 0; i--) alice.change((d) => A.splice(d, ["t"], i - 1, 1)); // Backspace ×3
    expect(alice.doc().t).toBe("xy");
    ua.undo();
    expect(alice.doc().t).toBe("abcxy");
    ua.undo();
    expect(alice.doc().t).toBe("xy");
    ua.undo();
    expect(alice.doc().t).toBe("xabcy");
  });

  test("text the other deleted stays deleted, also after redo", () => {
    const { alice, bob, ua } = pair({ t: "" });
    alice.change((d) => A.splice(d, ["t"], 0, 0, "abc"));
    sync(alice, bob);
    bob.change((d) => A.splice(d, ["t"], 1, 1));
    sync(alice, bob);
    ua.undo();
    expect(alice.doc().t).toBe("");
    ua.redo();
    expect(alice.doc().t).toBe("ac");
  });
});

describe("map values", () => {
  for (const conflict of ["skip", "force"] as const) {
    test(`a value the other set later: ${conflict}`, () => {
      const { alice, bob, ua } = pair({ x: 0, y: 0 }, { conflict });
      alice.change((d) => {
        d.x = 1;
        d.y = 1;
      });
      sync(alice, bob);
      bob.change((d) => (d.x = 2));
      sync(alice, bob);
      ua.undo();
      sync(alice, bob);
      expect(alice.doc()).toEqual({ x: conflict === "skip" ? 2 : 0, y: 0 });
      expect(ua.lastReport?.conflicts).toEqual([["x"]]);
    });
  }

  test("a value both set concurrently counts as a conflict", () => {
    const { alice, bob, ua } = pair({ x: 0 });
    alice.change((d) => (d.x = 1));
    bob.change((d) => (d.x = 2));
    sync(alice, bob);
    ua.undo();
    sync(alice, bob);
    expect(ua.lastReport?.conflicts).toEqual([["x"]]);
    expect(A.getConflicts(alice.doc(), "x")).toBeDefined();
  });

  test("counters", () => {
    const { alice, bob, ua } = pair({ n: new A.Counter(0) });
    alice.change((d) => d.n.increment(5));
    sync(alice, bob);
    bob.change((d) => d.n.increment(1));
    sync(alice, bob);
    ua.undo();
    expect(alice.doc().n.value).toBe(1);
  });
});

describe("records (tldraw's document shape)", () => {
  type Rec = { id: string; x: number; y: number; props: { text: string; tags: string[] } };
  type Store = { store: Record<string, Rec> };
  const shape = (id: string): Rec => ({ id, x: 0, y: 0, props: { text: "hi", tags: ["a"] } });

  test("create, move, delete; undo all and undo the undo run", () => {
    const { alice, ua } = pair<Store>({ store: {} });
    alice.change((d) => (d.store["s1"] = shape("s1")));
    alice.change((d) => (d.store["s1"]!.x = 10));
    alice.change((d) => A.splice(d, ["store", "s1", "props", "text"], 2, 0, " there"));
    alice.change((d) => delete d.store["s1"]);
    const snaps = [{}, { s1: shape("s1") }, { s1: { ...shape("s1"), x: 10 } }];
    ua.undo();
    expect(alice.doc().store["s1"]).toEqual({ ...shape("s1"), x: 10, props: { text: "hi there", tags: ["a"] } });
    ua.undo();
    expect(alice.doc().store).toEqual(snaps[2]);
    ua.undo();
    expect(alice.doc().store).toEqual(snaps[1]);
    ua.undo();
    expect(alice.doc().store).toEqual(snaps[0]);
    alice.change((d) => (d.store["s2"] = shape("s2")));
    ua.undo(); // s2
    // The run ended where it began, with s1 deleted: undoing it has no effect and is skipped.
    ua.undo(); // the run and the delete
    expect(alice.doc().store["s1"]?.props.text).toBe("hi there");
    ua.undo();
    ua.undo(); // the move
    expect(alice.doc().store).toEqual(snaps[1]);
  });

  test("undoing a creation deletes the other's edits inside it", () => {
    const { alice, bob, ua } = pair<Store>({ store: {} });
    alice.change((d) => (d.store["s1"] = shape("s1")));
    sync(alice, bob);
    bob.change((d) => (d.store["s1"]!.y = 5));
    sync(alice, bob);
    ua.undo();
    sync(alice, bob);
    expect(bob.doc().store).toEqual({});
  });

  test("undoing a move of a record the other deleted does nothing", () => {
    const { alice, bob, ua } = pair<Store>({ store: { s1: shape("s1") } });
    alice.change((d) => (d.store["s1"]!.x = 10));
    sync(alice, bob);
    bob.change((d) => delete d.store["s1"]);
    sync(alice, bob);
    ua.undo();
    expect(ua.lastReport?.unreachable).toBe(1);
    expect(alice.doc().store).toEqual({});
  });
});

test("rich-text marks are left alone", () => {
  const { alice, ua } = pair({ t: "hello" });
  alice.change((d) => A.mark(d, ["t"], { start: 0, end: 2, expand: "none" }, "bold", true));
  ua.undo();
  expect(alice.doc().t).toBe("hello");
  expect(ua.lastReport?.unsupported).toBe(2);
});

test("ignored paths are neither undone nor end an undo run", () => {
  const { alice, ua } = pair<{ t: string; meta: { n: number } }>(
    { t: "", meta: { n: 0 } },
    { ignore: (path) => path[0] === "meta" },
  );
  alice.change((d) => A.splice(d, ["t"], 0, 0, "a"));
  alice.change((d) => A.splice(d, ["t"], 1, 0, "b"));
  ua.undo();
  alice.change((d) => (d.meta.n = 1));
  expect(ua.canRedo()).toBe(true);
  ua.undo();
  expect(alice.doc()).toEqual({ t: "", meta: { n: 1 } });
  expect(ua.steps.length).toBe(2);
});
