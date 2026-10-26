/**
 * The document's undo history against CodeMirror's own (`history()`), on the same edits at the same
 * times: one editor keeps CodeMirror's history, the other writes to an Automerge document, as
 * automerge-codemirror does, and undoes with the UndoManager.
 */
import * as A from "@automerge/automerge";
import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { expect, test } from "vitest";
import { markUndoBoundaries, UndoManager } from "../src/index.ts";
import { Peer } from "./peers.ts";

type Doc = { text: string };

/** An action at a time: a transaction spec computed from the current state, or a wait. */
type Action = { wait: number } | { at?: number; spec: (s: EditorState) => TransactionSpec; event: string };

const STEP = 50;
const type = (text: string): Action[] =>
  [...text].map((ch) => ({ event: "input.type", spec: (s) => s.replaceSelection(ch) }));
const backspace = (n: number): Action[] =>
  Array.from({ length: n }, () => ({ event: "delete.backward", spec: (s) => ({ changes: { from: s.selection.main.head - 1, to: s.selection.main.head }, selection: { anchor: s.selection.main.head - 1 } }) }));
const select = (anchor: number, head = anchor): Action => ({ event: "select", spec: () => ({ selection: { anchor, head } }) });
const paste = (text: string): Action => ({ event: "input.paste", spec: (s) => s.replaceSelection(text) });
const wait = (ms: number): Action => ({ wait: ms });

class Pair {
  time = 1000;
  cm: EditorState;
  am: EditorState;
  peer: Peer<Doc>;
  manager: UndoManager<Doc>;
  constructor(text: string) {
    this.cm = EditorState.create({ doc: text, extensions: [history()] });
    this.am = EditorState.create({ doc: text });
    this.peer = new Peer(A.from<Doc>({ text }));
    this.manager = new UndoManager(this.peer, { now: () => this.time });
    this.manager.onApplied((patches) => {
      // The cursor after an undo, as the CAD editor's code pane puts it.
      let at: number | undefined;
      for (const p of patches) if (typeof p.path[1] === "number") at = p.path[1] + (p.action === "splice" ? p.value.length : 0);
      this.am = this.am.update({ changes: { from: 0, to: this.am.doc.length, insert: this.peer.doc().text }, selection: { anchor: Math.min(at ?? 0, this.peer.doc().text.length) }, annotations: Transaction.remote.of(true) }).state;
    });
  }
  run(actions: Action[]) {
    for (const a of actions) {
      if ("wait" in a) {
        this.time += a.wait;
        continue;
      }
      this.time += STEP;
      const annotations = [Transaction.time.of(this.time), Transaction.userEvent.of(a.event)];
      this.cm = this.cm.update({ ...a.spec(this.cm), annotations }).state;
      const tr = this.am.update({ ...a.spec(this.am), annotations });
      this.am = tr.state;
      markUndoBoundaries(this.manager, tr);
      // As automerge-codemirror's codeMirrorToAm: the changes, last first.
      const changes: [number, number, string][] = [];
      tr.changes.iterChanges((from, to, _f, _t, text) => changes.push([from, to, text.toString()]));
      if (changes.length) this.peer.change((d) => changes.reverse().forEach(([from, to, text]) => A.splice(d, ["text"], from, to - from, text)));
    }
    expect(this.am.doc.toString()).toBe(this.cm.doc.toString());
  }
  /** Presses undo (or redo) in each until it changes nothing more; the texts and cursors after each press that changed the text. */
  press(kind: "undo" | "redo") {
    const cm: { text: string; cursor: number }[] = [];
    for (let i = 0; i < 50; i++) {
      this.time += 200;
      let did = false;
      (kind === "undo" ? undo : redo)({ state: this.cm, dispatch: (tr) => ((did = true), (this.cm = tr.state)) });
      if (!did) break;
      // CodeMirror also undoes selection changes on their own.
      if (this.cm.doc.toString() !== cm.at(-1)?.text) cm.push({ text: this.cm.doc.toString(), cursor: this.cm.selection.main.head });
    }
    const am: { text: string; cursor: number }[] = [];
    for (let i = 0; i < 50; i++) {
      this.time += 200;
      if (!(kind === "undo" ? this.manager.undo() : this.manager.redo())) break;
      am.push({ text: this.am.doc.toString(), cursor: this.am.selection.main.head });
    }
    return { cm, am };
  }
}

const sessions: { name: string; text: string; actions: Action[] }[] = [
  { name: "typing with a pause", text: "", actions: [...type("hello"), wait(1000), ...type(" world")] },
  { name: "typing without pause, slowly (300 ms per key)", text: "", actions: type("slow").flatMap((a) => [a, wait(250)]) },
  { name: "typing at two places within 500 ms", text: "", actions: [...type("abc"), select(0), ...type("X")] },
  { name: "backspace, then typing", text: "", actions: [...type("hello"), ...backspace(2), ...type("p!")] },
  { name: "a paste between typing", text: "", actions: [...type("ab"), paste("PASTE"), ...type("cd")] },
  { name: "replacing a selection by typing", text: "hello world", actions: [select(0, 5), ...type("bye")] },
  { name: "two cursors", text: "a\nb", actions: [{ event: "select", spec: () => ({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)], 1) }) }, ...type("xy")] },
  { name: "a click without moving the cursor", text: "", actions: [...type("ab"), select(2), ...type("cd")] },
];

for (const s of sessions) {
  test(`same steps as CodeMirror's history: ${s.name}`, () => {
    const pair = new Pair(s.text);
    pair.run(s.actions);
    const undos = pair.press("undo");
    expect(undos.am.map((u) => u.text)).toEqual(undos.cm.map((u) => u.text));
    const redos = pair.press("redo");
    expect(redos.am.map((u) => u.text)).toEqual(redos.cm.map((u) => u.text));
    // Cursors differ where CodeMirror restores the selection from before the change.
    const cursors = (p: typeof undos) => p.am.filter((u, i) => u.cursor !== p.cm[i]!.cursor).length;
    console.log(`${s.name}: ${undos.am.length} undos, ${redos.am.length} redos, cursor differs after ${cursors(undos) + cursors(redos)}`);
  });
}

test("by design unlike CodeMirror: an edit after undos keeps them reachable", () => {
  const pair = new Pair("");
  pair.run([...type("a"), wait(1000), ...type("b"), wait(1000)]);
  pair.press("undo");
  // Both are at "" now; CodeMirror drops its redo branch on the next edit, the document's history keeps it.
  pair.run(type("c"));
  const undos = pair.press("undo");
  expect(undos.cm.map((u) => u.text)).toEqual([""]);
  expect(undos.am.map((u) => u.text)).toEqual(["", "ab", "a", ""]);
});
