import * as A from "@automerge/automerge";
import { invertChanges, type ConflictPolicy, type InvertReport } from "./invert.ts";

/** A value with sorted keys: a document's keys come in the order of the patches that made them. */
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Uint8Array)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)]))
      : v;

/** The part of automerge-repo's `DocHandle` the manager uses. */
export interface UndoableHandle<T> {
  doc(): A.Doc<T>;
  change(fn: A.ChangeFn<T>): void;
  on(event: "change", fn: (payload: { scopeReplaced?: boolean }) => void): unknown;
  off(event: "change", fn: (payload: { scopeReplaced?: boolean }) => void): unknown;
}

export interface UndoOptions {
  /** Local changes less than this apart form one step, unless `checkpoint()` was called in between. */
  groupDelayMs?: number;
  /** Text edits join a step only next to its last edit, as in CodeMirror's history (default true). */
  adjacentOnly?: boolean;
  conflict?: ConflictPolicy;
  /** Paths that are not undoable; changes only to them neither form steps nor end an undo run. */
  ignore?: (path: A.Prop[]) => boolean;
  now?: () => number;
}

/** One undo step: local changes, oldest first. */
interface Step {
  changes: string[];
  at: number;
  /** The text ranges the last change touched, after it, by sequence path. */
  touched?: Map<string, [number, number][]>;
}

/** The ranges of sequences a change's patches touch, before it (`before`) or after it. */
function ranges(patches: A.Patch[], before: boolean): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const p of patches) {
    const at = p.path.at(-1);
    if (typeof at !== "number") continue;
    const size = p.action === "splice" ? p.value.length : p.action === "insert" ? p.values.length : p.action === "del" ? (p.length ?? 1) : 0;
    const inserted = p.action === "splice" || p.action === "insert";
    const key = JSON.stringify(p.path.slice(0, -1));
    out.set(key, [...(out.get(key) ?? []), [at, at + (inserted === !before ? size : 0)]]);
  }
  return out;
}

const touching = (a: Map<string, [number, number][]>, b: Map<string, [number, number][]>) =>
  [...b].some(([key, rs]) => a.get(key)?.some(([f, t]) => rs.some(([f2, t2]) => f <= t2 && f2 <= t)));

/** Consecutive undo/redo presses; they become one step when the user changes the document again. */
interface Run {
  /** Steps from `pointer` to `start` are undone. */
  start: number;
  pointer: number;
  changes: string[];
  /** The changes that undid each step, innermost last, for redo. */
  inverses: string[][];
}

/**
 * Per-tab, per-document undo over an Automerge handle: undoes only this tab's changes
 * (those of the document's actor), as new changes. Undo runs are steps themselves, so
 * nothing is ever lost from the history (research/16-undo-redo.md).
 */
export class UndoManager<T> {
  readonly #handle: UndoableHandle<T>;
  readonly #opts: Required<Omit<UndoOptions, "ignore">> & Pick<UndoOptions, "ignore">;
  #stack: Step[] = [];
  #run: Run | undefined;
  #heads: A.Heads;
  #actor: string;
  #closed = true;
  #applying: string[] | undefined;
  readonly #redirect = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #applied = new Set<(patches: A.Patch[], kind: "undo" | "redo") => void>();
  lastReport: InvertReport | undefined;

  constructor(handle: UndoableHandle<T>, opts: UndoOptions = {}) {
    this.#handle = handle;
    this.#opts = { groupDelayMs: 500, adjacentOnly: true, conflict: "skip", now: Date.now, ...opts };
    const doc = handle.doc();
    this.#heads = A.getHeads(doc);
    this.#actor = A.getActorId(doc);
    handle.on("change", this.#onChange);
  }

  destroy() {
    this.#handle.off("change", this.#onChange);
    this.#listeners.clear();
    this.#applied.clear();
  }

  /** Called whenever canUndo/canRedo may have changed. */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Called after an undo or redo with its patches, e.g. to move the selection to what changed (as Loro's `onPop`). */
  onApplied(fn: (patches: A.Patch[], kind: "undo" | "redo") => void): () => void {
    this.#applied.add(fn);
    return () => this.#applied.delete(fn);
  }

  /** Ends the current step: the next local change starts a new one. */
  checkpoint() {
    this.#closed = true;
  }

  canUndo(): boolean {
    return (this.#run?.pointer ?? this.#stack.length) > 0;
  }

  canRedo(): boolean {
    return this.#run !== undefined && this.#run.pointer < this.#run.start;
  }

  /** Steps as lists of change hashes, oldest first; for tests and inspection. */
  get steps(): readonly (readonly string[])[] {
    return this.#stack.map((s) => s.changes);
  }

  undo(): boolean {
    this.#run ??= { start: this.#stack.length, pointer: this.#stack.length, changes: [], inverses: [] };
    const run = this.#run;
    if (run.pointer === 0) return false;
    // A step without net effect (e.g. typing and deleting a character) is skipped, so that every press changes something.
    const start = A.getHeads(this.#handle.doc());
    let effect: boolean;
    do {
      run.pointer--;
      const heads = A.getHeads(this.#handle.doc());
      const inverse = this.#apply(this.#stack[run.pointer]!.changes);
      run.changes.push(...inverse);
      run.inverses.push(inverse);
      effect = this.#changed(heads);
    } while (!effect && run.pointer > 0);
    this.#emit();
    this.#emitApplied(start, "undo");
    return true;
  }

  redo(): boolean {
    const run = this.#run;
    if (!run || run.pointer === run.start) return false;
    const start = A.getHeads(this.#handle.doc());
    let effect: boolean;
    do {
      const heads = A.getHeads(this.#handle.doc());
      const inverse = run.inverses.pop()!;
      if (inverse.length) run.changes.push(...this.#apply(inverse));
      run.pointer++;
      effect = this.#changed(heads);
    } while (!effect && run.pointer < run.start);
    this.#emit();
    this.#emitApplied(start, "redo");
    return true;
  }

  /**
   * Whether the document looks different than at `heads`. Not just whether the diff is empty: writing
   * an equal value, or a copy of a deleted object, has patches, though nothing visible changes.
   */
  #changed(heads: A.Heads): boolean {
    const doc = this.#handle.doc();
    const before = A.view(doc, heads);
    const at = (d: unknown, path: A.Prop[]) => JSON.stringify(sorted(path.reduce<any>((v, p) => v?.[p], d)));
    return A.diff(doc, heads, A.getHeads(doc)).some((p) => {
      const path = typeof p.path.at(-1) === "number" ? p.path.slice(0, -1) : p.path;
      return at(before, path) !== at(doc, path);
    });
  }

  #apply(changes: string[]): string[] {
    this.#applying = [];
    try {
      const heads = A.getHeads(this.#handle.doc());
      this.#handle.change((d) => {
        this.lastReport = invertChanges(A.getBackend(d as A.Doc<unknown>), changes, {
          heads,
          redirect: this.#redirect,
          conflict: this.#opts.conflict,
          ...(this.#opts.ignore ? { ignore: this.#opts.ignore } : {}),
        });
      });
      this.#sync();
      return this.#applying;
    } finally {
      this.#applying = undefined;
    }
  }

  #endRun() {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    // A run that ends where it started has no net effect.
    if (run.pointer < run.start && run.changes.length) this.#stack.push({ changes: run.changes, at: this.#opts.now() });
    this.#closed = true;
  }

  #onChange = (payload: { scopeReplaced?: boolean }) => {
    if (payload?.scopeReplaced) {
      this.#stack = [];
      this.#run = undefined;
      this.#redirect.clear();
      const doc = this.#handle.doc();
      this.#heads = A.getHeads(doc);
      this.#actor = A.getActorId(doc);
      this.#emit();
      return;
    }
    this.#sync();
  };

  /** Records local changes since the last call. */
  #sync() {
    const doc = this.#handle.doc();
    const local = A.getChangesMetaSince(doc, this.#heads).filter((c) => c.actor === this.#actor);
    this.#heads = A.getHeads(doc);
    if (!local.length) return;
    if (this.#applying) {
      this.#applying.push(...local.map((c) => c.hash));
      return;
    }
    const now = this.#opts.now();
    for (const { hash } of local) {
      if (this.#ignoredOnly(hash)) continue;
      this.#endRun();
      const last = this.#stack.at(-1);
      const patches = this.#opts.adjacentOnly ? this.#patchesOf(hash) : [];
      const before = ranges(patches, true);
      const joins = last && !this.#closed && now - last.at < this.#opts.groupDelayMs && (!before.size || !last.touched?.size || touching(last.touched, before));
      if (joins) {
        last.changes.push(hash);
        last.at = now;
        last.touched = ranges(patches, false);
      } else {
        this.#stack.push({ changes: [hash], at: now, touched: ranges(patches, false) });
      }
      this.#closed = false;
    }
    this.#emit();
  }

  #patchesOf(hash: string): A.Patch[] {
    const doc = this.#handle.doc();
    const change = A.getBackend(doc).getDecodedChangeByHash(hash);
    return change ? A.diff(doc, change.deps, [hash]) : [];
  }

  #ignoredOnly(hash: string): boolean {
    const { ignore } = this.#opts;
    if (!ignore) return false;
    const b = A.getBackend(this.#handle.doc());
    const change = b.getDecodedChangeByHash(hash);
    if (!change) return false;
    return change.ops.every((op) => {
      const path = op.obj === "_root" ? [] : (b.objInfo(op.obj).path ?? b.objInfo(op.obj, change.deps).path);
      return path !== undefined && ignore("key" in op && op.key !== undefined ? [...path, op.key] : path);
    });
  }

  #emitApplied(start: A.Heads, kind: "undo" | "redo") {
    if (!this.#applied.size) return;
    const doc = this.#handle.doc();
    const patches = A.diff(doc, start, A.getHeads(doc));
    for (const fn of this.#applied) fn(patches, kind);
  }

  #emit() {
    for (const fn of this.#listeners) fn();
  }
}
