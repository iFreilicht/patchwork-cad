// Locks of followed documents (research/21, "Following and pinning"): comparing two builds' errors,
// when a lock advances or holds back, and that writing one is never an undo step.
import { splice } from "@automerge/automerge";
import { initSubduction, Repo } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { UndoManager } from "@patchwork-cad/undo";
import { decide, errorKeys, errorTexts, newErrors, UNDO_IGNORE, writeLocks, type Followed } from "../src/model/locks.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

test("two builds' errors compare by kind and line, or by feature and status, never by message", () => {
  const before = errorKeys({ error: { kind: "runtime", line: 7, message: "width is 8" }, failures: [{ name: "fillet1", status: "failed", message: "radius 1 too large" }] });
  const after = errorKeys({ error: { kind: "runtime", line: 7, message: "width is 10" }, failures: [{ name: "fillet1", status: "failed", message: "radius 2 too large" }, { name: "extrude2", status: "broken" }] });
  expect(before).toEqual(["failed fillet1", "runtime error on line 7"]);
  expect(newErrors(after, before)).toEqual(["broken extrude2"]);
  // A runtime error without a line is the kernel's; meshing isn't compared.
  expect(errorKeys({ error: { kind: "runtime", line: undefined }, failures: [] })).toEqual(["kernel error"]);
  expect(errorKeys({ error: { kind: "mesh", line: undefined }, failures: [] })).toEqual([]);
  expect(errorTexts({ error: { kind: "import", line: 2, message: "automerge:x can't be imported: its content isn't valid JSON" }, failures: [] })).toEqual({
    "import error on line 2": "import error on line 2: automerge:x can't be imported: its content isn't valid JSON",
  });
});

const doc = (latest: string[], locked?: string[], hasLocked = true): Followed => ({ doc: `automerge:${latest[0]}`, latest, locked, hasLocked });

test("a lock advances when the newer version brings no errors, and holds back when it does", () => {
  const a = { doc: "automerge:a", latest: ["a2"], locked: ["a1"], hasLocked: true };
  // No errors: advance.
  expect(decide([a], [], undefined, true)).toEqual({ show: "latest", held: [], write: { "automerge:a": ["a2"] } });
  // The errors the locked version had too: advance.
  expect(decide([a], ["failed fillet1"], ["failed fillet1"], true)).toMatchObject({ show: "latest", write: { "automerge:a": ["a2"] } });
  // A new error: hold back, write nothing.
  expect(decide([a], ["failed fillet1", "import error on line 2"], ["failed fillet1"], true)).toEqual({ show: "locked", held: [{ doc: "automerge:a", errors: ["import error on line 2"] }], write: {} });
  // Unchanged: nothing to write.
  expect(decide([{ ...a, latest: ["a1"] }], [], undefined, true).write).toEqual({});
});

test("documents that moved at once are held back together", () => {
  const a = { doc: "automerge:a", latest: ["a2"], locked: ["a1"], hasLocked: true };
  const b = { doc: "automerge:b", latest: ["b2"], locked: ["b1"], hasLocked: true };
  const decision = decide([a, b], ["runtime error on line 4"], [], true);
  expect(decision.show).toBe("locked");
  expect(decision.held.map((h) => h.doc)).toEqual(["automerge:a", "automerge:b"]);
  expect(decision.write).toEqual({});
});

test("the first lock is written with the first build, whatever its errors: later versions are compared with it", () => {
  const fresh = doc(["n1"]);
  expect(decide([fresh], [], undefined, true).write).toEqual({ "automerge:n1": ["n1"] });
  expect(decide([fresh], ["failed extrude1"], undefined, true)).toEqual({ show: "latest", held: [], write: { "automerge:n1": ["n1"] } });
  // Next to a document held back, a new one gets its lock too.
  const a = { doc: "automerge:a", latest: ["a2"], locked: ["a1"], hasLocked: true };
  expect(decide([a, fresh], ["failed extrude1"], [], true)).toMatchObject({ show: "locked", write: { "automerge:n1": ["n1"] } });
  expect(decide([a, fresh], ["failed extrude1", "failed fillet1"], ["failed fillet1"], true)).toMatchObject({ show: "locked", write: { "automerge:n1": ["n1"] } });
});

test("an editor that is behind the lock, or that may not write, writes nothing", () => {
  // The stored lock has heads this copy of the document doesn't: another editor synced a newer version.
  const behind = { doc: "automerge:a", latest: ["a1"], locked: ["a2"], hasLocked: false };
  expect(decide([behind], [], undefined, true)).toEqual({ show: "latest", held: [], write: {} });
  // Nor does it hold back on a version it can't build.
  expect(decide([behind], ["failed extrude1"], [], true).show).toBe("latest");
  // Read-only, or the viewer: the same decision, nothing written.
  const a = { doc: "automerge:a", latest: ["a2"], locked: ["a1"], hasLocked: true };
  expect(decide([a, doc(["n1"])], [], undefined, false)).toEqual({ show: "latest", held: [], write: {} });
  expect(decide([a], ["failed extrude1"], [], false)).toMatchObject({ show: "locked", write: {} });
});

test("writing locks and removing those of documents no longer followed", () => {
  const model: CadModelDoc = { title: "", content: "", mimeType: "application/javascript" };
  writeLocks(model, { "automerge:a": ["a1"], "automerge:b": ["b1"] });
  writeLocks(model, { "automerge:a": ["a2"] }, new Set(["automerge:a"]));
  expect(model.cad?.locks).toEqual({ "automerge:a": ["a2"] });
});

test("a lock write is never an undo step and doesn't end an undo run", () => {
  const repo = new Repo();
  const handle = repo.create<CadModelDoc>({ title: "", content: "abc", mimeType: "application/javascript" });
  const undo = new UndoManager(handle, { groupDelayMs: 0, ignore: UNDO_IGNORE });
  handle.change((d) => splice(d, ["content"], 3, 0, "d"));
  // The first lock also creates the `cad` field.
  handle.change((d) => writeLocks(d, { "automerge:a": ["a1"] }));
  expect(undo.steps).toHaveLength(1);
  undo.undo();
  expect(handle.doc().content).toBe("abc");
  expect(handle.doc().cad?.locks).toEqual({ "automerge:a": ["a1"] });
  // Within the run: redo still redoes.
  handle.change((d) => writeLocks(d, { "automerge:a": ["a2"] }));
  expect(undo.canRedo()).toBe(true);
  undo.redo();
  expect(handle.doc().content).toBe("abcd");
  expect(handle.doc().cad?.locks).toEqual({ "automerge:a": ["a2"] });
  // A named view next to the locks stays undoable.
  handle.change((d) => (d.cad!.home = { direction: [0, 0, 1], target: [0, 0, 0], extent: [1, 1], projection: "perspective" }));
  expect(undo.steps).toHaveLength(2);
  undo.destroy();
});
