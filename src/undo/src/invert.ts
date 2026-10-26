import * as A from "@automerge/automerge";

/**
 * Selective inversion of Automerge changes at the level of their operations, in the
 * manner of Yjs's UndoManager: the inverse deletes the elements the changes inserted,
 * inserts copies of the elements they deleted and restores the map values they set.
 * Concurrent and later changes of other actors stay (research/16-undo-redo.md).
 */

export type Backend = ReturnType<typeof A.getBackend>;
type Heads = A.Heads;
type ObjId = string;
type OpId = string;
type FullValue = NonNullable<ReturnType<Backend["getWithType"]>>;

/** What to do with a value that someone else set after the change being inverted. */
export type ConflictPolicy = "skip" | "force";

/** An operation as `getDecodedChangeByHash` returns it (the published `Op` type lacks `elemId` and `insert`). */
interface DecodedOp {
  action: string;
  obj: ObjId;
  key?: string;
  elemId?: OpId;
  insert?: boolean;
  value?: unknown;
  datatype?: string;
  pred: OpId[];
}

interface StepOp {
  id: OpId;
  op: DecodedOp;
  deps: Heads;
  /** Position of the op in the step, for ordering. */
  seq: number;
}

export interface InvertOptions {
  /** The heads before the running change. Never call `getHeads()` inside a change: it commits the pending ops as a change of their own, which the resulting document doesn't show. */
  heads: Heads;
  /**
   * Original op/object/element id → id of its copy. Inverses that restore a deleted element
   * or value create new ids; later inversions follow this map to find them. Updated in place.
   */
  redirect: Map<OpId, OpId>;
  conflict: ConflictPolicy;
  /** Paths whose operations are never inverted, e.g. comments. */
  ignore?: (path: A.Prop[]) => boolean;
}

export interface InvertReport {
  applied: number;
  /** Values someone else changed since, by path; skipped under the "skip" policy, overwritten under "force". */
  conflicts: A.Prop[][];
  /** Operations whose target no longer exists, e.g. inside a deleted object. */
  unreachable: number;
  /** Operations not supported (rich-text marks). */
  unsupported: number;
}

const OBJ_TYPES = new Set(["map", "list", "text", "table"]);
const MAKE_ACTIONS = new Set(["makeMap", "makeList", "makeText", "makeTable"]);

const isObject = (v: FullValue): boolean => OBJ_TYPES.has(v[0]);
/** The id of the op that wrote a value as returned by `getAll`: objects carry it as their id. */
const opIdOf = (v: readonly unknown[]): OpId => String(isObject(v as FullValue) ? v[1] : v[2]);

export const follow = (redirect: Map<OpId, OpId>, id: OpId): OpId => {
  let next = redirect.get(id);
  while (next !== undefined) {
    id = next;
    next = redirect.get(id);
  }
  return id;
};

const sameSet = (a: OpId[], b: OpId[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Inverts the changes `hashes` (chronological, all by one actor) inside a running `A.change` whose backend is `b`. */
export function invertChanges(b: Backend, hashes: string[], opts: InvertOptions): InvertReport {
  const report: InvertReport = { applied: 0, conflicts: [], unreachable: 0, unsupported: 0 };
  const { redirect } = opts;
  const fw = (id: OpId) => follow(redirect, id);

  const ops: StepOp[] = [];
  for (const hash of hashes) {
    const change = b.getDecodedChangeByHash(hash);
    if (!change) continue;
    (change.ops as unknown as DecodedOp[]).forEach((op, i) =>
      ops.push({ id: `${change.startOp + i}@${change.actor}`, op, deps: change.deps, seq: ops.length }),
    );
  }

  const pathOf = (obj: ObjId, heads?: Heads): A.Prop[] | undefined => (obj === "_root" ? [] : b.objInfo(obj, heads).path);
  const reachable = (obj: ObjId) => pathOf(obj) !== undefined;

  // Inner ops of objects the step created vanish with the object's own inverse.
  const created = new Set(ops.filter((s) => MAKE_ACTIONS.has(s.op.action)).map((s) => s.id));
  const insertedByStep = new Set(ops.filter((s) => s.op.insert).map((s) => s.id));

  /** A map key or a list element whose value the step set or deleted: first and last op on it. */
  interface Slot {
    obj: ObjId;
    key?: string;
    elem?: OpId;
    first: StepOp;
    last: StepOp;
  }
  const slots = new Map<string, Slot>();
  const inserted = new Map<OpId, StepOp>();
  const deleted: StepOp[] = [];
  const incs = new Map<string, { obj: ObjId; key?: string; elem?: OpId; by: number }>();

  for (const s of ops) {
    const { op } = s;
    if (created.has(op.obj)) continue;
    if (opts.ignore) {
      const base = pathOf(op.obj, s.deps) ?? pathOf(op.obj);
      if (base && opts.ignore(op.key !== undefined ? [...base, op.key] : base)) continue;
    }
    // Rich-text marks are elements of the sequence (`markBegin`, `markEnd`).
    if (op.action.startsWith("mark")) {
      report.unsupported++;
      continue;
    }
    if (op.key !== undefined) {
      const id = `${op.obj}/${op.key}`;
      if (op.action === "inc") {
        const inc = incs.get(id) ?? { obj: op.obj, key: op.key, by: 0 };
        inc.by += Number(op.value);
        incs.set(id, inc);
        continue;
      }
      const slot = slots.get(id);
      if (slot) slot.last = s;
      else slots.set(id, { obj: op.obj, key: op.key, first: s, last: s });
    } else if (op.insert) {
      inserted.set(s.id, s);
    } else if (op.action === "del") {
      if (insertedByStep.has(op.elemId!)) inserted.delete(op.elemId!);
      else deleted.push(s);
    } else if (op.action === "inc") {
      const id = `${op.obj}/${op.elemId}`;
      const inc = incs.get(id) ?? { obj: op.obj, elem: op.elemId!, by: 0 };
      inc.by += Number(op.value);
      incs.set(id, inc);
    } else {
      const id = `${op.obj}/${op.elemId}`;
      const slot = slots.get(id);
      if (slot) slot.last = s;
      else slots.set(id, { obj: op.obj, elem: op.elemId!, first: s, last: s });
    }
  }

  // An element the step deleted and then restored as a copy (an undo and its redo within one run) is unchanged.
  for (let i = deleted.length - 1; i >= 0; i--) {
    for (let id: OpId | undefined = deleted[i]!.op.elemId; id !== undefined; id = redirect.get(id)) {
      if (inserted.delete(id)) {
        deleted.splice(i, 1);
        break;
      }
    }
  }

  const isText = (obj: ObjId, heads?: Heads) => b.objInfo(obj, heads).type === "text";

  /**
   * Where a (possibly deleted) text character is or was. Automerge 3.4.1 throws "cursor … is invalid"
   * at historic heads for a tombstone without visible successor once the document has changed since;
   * such a tombstone resolves to the end.
   */
  const positionAt = (obj: ObjId, elem: OpId, heads: Heads): number => {
    try {
      return b.getCursorPosition(obj, elem, heads);
    } catch (e) {
      if (b.objInfo(obj, heads).path === undefined && obj !== "_root") throw e;
      return b.length(obj, heads);
    }
  };

  // Automerge 3.4.1 has cursors only for text. List elements are found by the ids of the ops that
  // wrote their values (an element's insert op, unless it was overwritten), and positions are
  // carried from one state to another through the patches between them.
  const scan = (obj: ObjId, ids: OpId[], heads?: Heads): number | undefined => {
    const n = b.length(obj, heads);
    for (let i = 0; i < n; i++) if (b.getAll(obj, i, heads).some((v) => ids.includes(opIdOf(v)))) return i;
    return undefined;
  };
  const carry = (obj: ObjId, index: number, from: Heads, to: Heads): number => {
    for (const p of b.diffPath(obj, from, to)) {
      const at = p.path.at(-1);
      if (typeof at !== "number") continue;
      if (p.action === "insert" && at <= index) index += p.values.length;
      else if (p.action === "del" && at < index) index -= Math.min(p.length ?? 1, index - at);
    }
    return index;
  };
  /** Where an element deleted by `s` was, at `heads` (default: now; ignores this transaction's inserts). */
  const tombstone = (obj: ObjId, s: StepOp, heads?: Heads): number => {
    if (isText(obj)) return heads ? positionAt(obj, s.op.elemId!, heads) : b.getCursorPosition(obj, s.op.elemId!);
    // The values it had: the deleted ones, or, if the same change wrote them, the ones before.
    const overwritten = slots.get(`${obj}/${s.op.elemId}`)?.first.op.pred ?? [];
    const i = scan(obj, [...s.op.pred, ...overwritten, s.op.elemId!], s.deps) ?? 0;
    return carry(obj, i, s.deps, heads ?? opts.heads);
  };

  const elemAt = (obj: ObjId, i: number, heads?: Heads): OpId =>
    isText(obj, heads) ? b.getCursor(obj, i, heads) : opIdOf(b.getAll(obj, i, heads).at(-1)!);
  /** Where an element was visible at `heads`, if it was. */
  const visibleAt = (obj: ObjId, elem: OpId, heads: Heads): number | undefined => {
    if (!isText(obj, heads)) return scan(obj, [elem], heads);
    const pos = positionAt(obj, elem, heads);
    return pos < b.length(obj, heads) && b.getCursor(obj, pos, heads) === elem ? pos : undefined;
  };
  /** Copy → the ids it stands for (an element and the ops that overwrote it; each possibly a copy). */
  const copiedFrom = new Map<OpId, OpId[]>();
  for (const [from, to] of redirect) copiedFrom.set(to, [...(copiedFrom.get(to) ?? []), from]);
  /** Where any original of a copy was visible at `heads`. */
  const originalAt = (obj: ObjId, copy: OpId, heads: Heads): number | undefined => {
    const seen = new Set<OpId>();
    for (let queue = [...(copiedFrom.get(copy) ?? [])]; queue.length; ) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const at = visibleAt(obj, id, heads);
      if (at !== undefined) return at;
      queue.push(...(copiedFrom.get(id) ?? []));
    }
    return undefined;
  };

  /** Index of a visible element, or undefined if it is deleted. */
  const indexOf = (obj: ObjId, elem: OpId): number | undefined => {
    if (!isText(obj)) return scan(obj, [elem]);
    let pos: number;
    try {
      pos = b.getCursorPosition(obj, elem);
    } catch {
      return undefined;
    }
    if (pos >= b.length(obj)) return undefined;
    return b.getCursor(obj, pos) === elem ? pos : undefined;
  };

  // Copies a value of the historic state at `heads` into `dst`, recording id redirects.
  const copyChildren = (src: ObjId, dst: ObjId, heads: Heads) => {
    const type = b.objInfo(src, heads).type;
    if (type === "text") {
      const text = b.text(src, heads);
      b.splice(dst, 0, 0, text);
      for (let i = 0; i < text.length; i++) redirect.set(b.getCursor(src, i, heads), b.getCursor(dst, i));
    } else if (type === "list") {
      const n = b.length(src, heads);
      for (let i = 0; i < n; i++) {
        const v = b.getWithType(src, i, heads);
        if (v) redirect.set(opIdOf(b.getAll(src, i, heads).at(-1)!), writeValue(dst, i, v, heads, true));
      }
    } else {
      for (const key of b.keys(src, heads)) {
        const v = b.getWithType(src, key, heads);
        if (v) redirect.set(opIdOf(b.getAll(src, key, heads).at(-1)!), writeValue(dst, key, v, heads, false));
      }
    }
  };
  /** Writes a copy of `v`; returns the new op id (for inserts: the new element id). */
  const writeValue = (dst: ObjId, prop: A.Prop, v: FullValue, heads: Heads, insert: boolean): OpId => {
    if (isObject(v)) {
      const empty = v[0] === "text" ? "" : v[0] === "list" ? [] : {};
      const obj = insert ? b.insertObject(dst, prop as number, empty) : b.putObject(dst, prop, empty);
      redirect.set(String(v[1]), obj);
      copyChildren(String(v[1]), obj, heads);
      return obj;
    }
    const datatype = v[0] as Parameters<Backend["put"]>[3];
    if (insert) {
      b.insert(dst, prop as number, v[1] as A.ScalarValue, datatype);
      return opIdOf(b.getAll(dst, prop).at(-1)!);
    }
    b.put(dst, prop, v[1] as A.ScalarValue, datatype);
    return opIdOf(b.getAll(dst, prop).at(-1)!);
  };

  // 1. Insert copies of deleted elements, per object in document order, so that a run of them keeps its order.
  const reinsert = (obj: ObjId, dels: StepOp[]): boolean => {
    const cur = fw(obj);
    if (!reachable(cur)) return false;
    // At the later deletion's deps, the earlier-deleted element is a tombstone that resolves
    // to the index of the next visible element: it precedes the other iff that index is ≤ the other's.
    dels.sort((x, y) => {
      const [early, late] = x.seq <= y.seq ? [x, y] : [y, x];
      if (early.deps === late.deps) return tombstone(obj, x, x.deps) - tombstone(obj, y, y.deps);
      const earlyFirst = tombstone(obj, early, late.deps) <= tombstone(obj, late, late.deps);
      return early === x ? (earlyFirst ? -1 : 1) : earlyFirst ? 1 : -1;
    });
    const text = isText(cur);
    let inserts = 0;
    for (const s of dels) {
      const elem = fw(s.op.elemId!);
      if (indexOf(cur, elem) !== undefined) continue;
      // An element the step overwrote before deleting it comes back with its value from before the step.
      const overwritten = slots.get(`${obj}/${s.op.elemId}`);
      slots.delete(`${obj}/${s.op.elemId}`);
      const old = overwritten
        ? b.getWithType(obj, scan(obj, overwritten.first.op.pred, overwritten.first.deps) ?? 0, overwritten.first.deps)
        : b.getWithType(obj, tombstone(obj, s, s.deps), s.deps);
      if (!old) continue;
      let pos: number;
      if (cur === obj) {
        pos = tombstone(obj, s);
        if (!text) pos = Math.min(pos + inserts++, b.length(cur));
      } else {
        // The object was copied after the deletion: insert after the nearest earlier element that has a copy.
        pos = 0;
        for (let j = tombstone(obj, s, s.deps) - 1; j >= 0; j--) {
          const at = indexOf(cur, fw(elemAt(obj, j, s.deps)));
          if (at !== undefined) {
            pos = at + 1;
            break;
          }
        }
      }
      // Index-based inserts go right after the preceding visible element, so an earlier copy can
      // precede tombstones its original followed: step back over copies whose originals came after.
      if (cur === obj) {
        const own = tombstone(obj, s, s.deps);
        while (pos > 0) {
          const was = originalAt(obj, elemAt(cur, pos - 1), s.deps);
          if (was === undefined || was <= own) break;
          pos--;
        }
      }
      if (text) {
        b.splice(cur, pos, 0, String(old[1]));
        redirect.set(elem, b.getCursor(cur, pos));
      } else {
        const id = writeValue(cur, pos, old, s.deps, true);
        redirect.set(elem, id);
        // Overwrites of the element are found by their value ops.
        for (const v of s.op.pred) if (fw(v) !== id) redirect.set(fw(v), id);
      }
      report.applied++;
    }
    return true;
  };

  // 2. Restore the values the step set or deleted, unless someone else changed them since.
  const restore = (slot: Slot): boolean => {
    // An element the step inserted goes anyway.
    if (slot.elem !== undefined && inserted.has(slot.elem)) return true;
    const cur = fw(slot.obj);
    if (!reachable(cur)) return false;
    let prop: A.Prop;
    let before: FullValue | null;
    let beforeId: OpId | undefined;
    if (slot.key !== undefined) {
      prop = slot.key;
      before = b.getWithType(slot.obj, slot.key, slot.first.deps);
      const all = b.getAll(slot.obj, slot.key, slot.first.deps);
      beforeId = all.length ? opIdOf(all.at(-1)!) : undefined;
    } else {
      const pos = indexOf(cur, fw(slot.last.id));
      if (pos === undefined) {
        report.conflicts.push([...(pathOf(cur) ?? []), slot.elem!]);
        return true;
      }
      prop = pos;
      const oldPos = scan(slot.obj, slot.first.op.pred, slot.first.deps);
      before = oldPos === undefined ? null : b.getWithType(slot.obj, oldPos, slot.first.deps);
      beforeId = slot.first.op.pred.at(-1);
    }
    const expected = slot.last.op.action === "del" ? [] : [fw(slot.last.id)];
    const current = b.getAll(cur, prop).map(opIdOf);
    if (!sameSet(current, expected)) {
      report.conflicts.push([...(pathOf(cur) ?? []), prop]);
      if (opts.conflict === "skip") return true;
    }
    if (before) {
      const from = beforeId === undefined ? undefined : fw(beforeId);
      const id = writeValue(cur, prop, before, slot.first.deps, false);
      if (from !== undefined && from !== id) redirect.set(from, id);
    } else if (current.length) {
      b.delete(cur, prop);
    }
    report.applied++;
    return true;
  };

  // A copy restored by one of them can make the target of another reachable again, so repeat while that happens.
  let dels = new Map<ObjId, StepOp[]>();
  for (const s of deleted) dels.set(s.op.obj, [...(dels.get(s.op.obj) ?? []), s]);
  // Newest first, so that a restored object exists before the values inside it are restored.
  let pending = [...slots.values()].sort((x, y) => y.last.seq - x.last.seq);
  for (let progress = true; progress && (dels.size || pending.length); ) {
    const before = dels.size + pending.length;
    dels = new Map([...dels].filter(([obj, ds]) => !reinsert(obj, ds)));
    pending = pending.filter((slot) => slots.has(`${slot.obj}/${slot.key ?? slot.elem}`) && !restore(slot));
    progress = dels.size + pending.length < before;
  }
  for (const ds of dels.values()) report.unreachable += ds.length;
  report.unreachable += pending.length;


  for (const inc of incs.values()) {
    const cur = fw(inc.obj);
    const prop = inc.key ?? (reachable(cur) ? indexOf(cur, fw(inc.elem!)) : undefined);
    if (prop === undefined || !reachable(cur) || b.getWithType(cur, prop)?.[0] !== "counter") {
      report.unreachable++;
      continue;
    }
    b.increment(cur, prop, -inc.by);
    report.applied++;
  }

  // 3. Delete the elements the step inserted, if they are still there.
  for (const s of [...inserted.values()].reverse()) {
    const cur = fw(s.op.obj);
    if (!reachable(cur)) continue;
    // A list element the step overwrote is found by its last value.
    const last = slots.get(`${s.op.obj}/${s.id}`)?.last.id;
    const pos = indexOf(cur, fw(s.id)) ?? (last === undefined || isText(cur) ? undefined : scan(cur, [fw(last)]));
    if (pos === undefined) continue;
    if (b.objInfo(cur).type === "text") b.splice(cur, pos, 1);
    else b.delete(cur, pos);
    report.applied++;
  }

  return report;
}
