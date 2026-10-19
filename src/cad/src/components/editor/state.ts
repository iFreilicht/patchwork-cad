/**
 * State of the WYSIWYG editor. Everything is derived from the document's source text and the last
 * build's trace; the editor owns no model state of its own (research/02, "The timeline is a
 * view"). The open feature is anchored with an automerge cursor, so that it stays open while others
 * edit the code around it, or rename it.
 */
import { getCursor, getCursorPosition } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { schemas, type FeatureType } from "@patchwork-cad/features/schema";
import { analyze, type Analysis, type FeatureCall } from "../../model/analyze.ts";
import { allowedRange, canMove, graph, inputOf, relations, type Graph, type Relation } from "../../model/deps.ts";
import { apply, applyToText, appendElement, deleteFeature, elements, ensureImports, freshName, insertFeatureAt, lastOf, moveEntry, removeElement, returnedVariables, setProp, usedFunctions, type Edit } from "../../model/splice.ts";
import { deleteScript, rename, unwrapBody, wrapInBody, type Refactoring } from "../../model/refactor.ts";
import { markerPosition, ownerNames, ownersOf, timeline, type Entry, type FeatureEntry, type Timeline } from "../../model/timeline.ts";
import type { CadModelDoc, TimelineMarker } from "../../types.ts";
import type { Model } from "../createModel.ts";
import type { UiState } from "../uiState.ts";
import type { Entity, EntityKind } from "../Viewer.tsx";

export interface PickTarget {
  /** The parameter that a picked entity fills. */
  param: string;
  kind: EntityKind;
  /** Whether picks are added to a list (edges) or replace the value (a sketch plane). */
  multi: boolean;
}

export interface Editor {
  source: Accessor<string>;
  /** The last source that parsed, with its timeline; forms are read-only while the code doesn't parse. */
  analysis: Accessor<Analysis | undefined>;
  timeline: Accessor<Timeline>;
  syntaxError: Accessor<string | undefined>;
  /** The feature whose dialog is open. */
  open: Accessor<FeatureEntry | undefined>;
  openFeature(entry: FeatureEntry | undefined): void;
  pickTarget: Accessor<PickTarget | undefined>;
  setPickTarget(target: PickTarget | undefined): void;
  /**
   * Edits the open feature's call; `edit` gets the call as it is in the current source. An edit
   * after which the code wouldn't parse, e.g. a field's `01`, isn't made: whether it was is returned.
   */
  editOpen(edit: (call: FeatureCall, analysis: Analysis, source: string) => Edit[]): boolean;
  /** Adds a feature with default parameters and opens it. */
  insert(type: InsertableType): void;
  deleteOpen(): void;
  /** Fills the pick target with the picked entity's reference. */
  pick(entity: Entity): Promise<void>;
  /** Variables of features before the open one that produce a body or a sketch. */
  variablesBefore(kind: "body" | "sketch"): string[];
  /** The dependencies between the timeline's entries. */
  graph: Accessor<Graph | undefined>;
  /** The timeline marker: entries from this index on are rolled back; `entries.length` is the end. */
  marker: Accessor<number>;
  setMarker(position: number): void;
  /** Where another marker, e.g. a collaborator's, is in the timeline. */
  markerOf(marker: TimelineMarker | undefined): number;
  /** The entry being hovered or dragged in the timeline. */
  hovered: Accessor<number | undefined>;
  setHovered(index: number | undefined): void;
  setDragging(index: number | undefined): void;
  dragging: Accessor<number | undefined>;
  /** The entry whose dependencies are highlighted: the dragged, else the hovered, else the open one. */
  focused: Accessor<number | undefined>;
  /** The focused entry's dependencies and dependents, by entry index. */
  related: Accessor<Map<number, Relation>>;
  /** The code position under the pointer in the code pane. */
  setCodeHover(offset: number | undefined): void;
  /** The cursor's position in the code pane while it has focus. */
  setCodeCursor(offset: number | undefined): void;
  /** The features of the timeline entry being hovered or dragged, else of the code under the pointer or at the cursor (whichever moved last), by owner name (`ownersOf`); the 3D view highlights what they made. */
  hoveredFeatures: Accessor<string[]>;
  /** The owner names of the face or edge hovered in the 3D view. */
  setViewHover(features: string[]): void;
  /** Entries whose features are hovered in the 3D view, or in the code or at its cursor, by entry index. */
  crossHovered: Accessor<Set<number>>;
  /** Why the last action in the timeline didn't happen, e.g. a drop or a rename; the status bar shows it. */
  notice: Accessor<string | undefined>;
  setNotice(message: string | undefined): void;
  /** Renames variable `from` of entry `index` to `to`; resolves to why not. */
  rename(index: number, from: string, to: string): Promise<string | undefined>;
  /** Wraps the Custom Script at `index` in body() if a trial build allows it (research/11); resolves to why not. */
  wrap(index: number): Promise<string | undefined>;
  /** Unwraps the body() at `index`; resolves to why not. */
  unwrap(index: number): Promise<string | undefined>;
  /** Deletes the entry at `index`: a feature, rewiring its users, or a Custom Script nothing uses; resolves to why not. */
  remove(index: number): Promise<string | undefined>;
  /** Why entry `index` can't move to `position` (before entry `position`), or undefined if it can. */
  blocked(index: number, position: number): string | undefined;
  /**
   * Moves entry `index` before entry `position`, and before or after the marker if that is where it
   * is (`pastMarker`); resolves to why it didn't, if it didn't.
   */
  move(index: number, position: number, pastMarker: boolean): Promise<string | undefined>;
}

function tryAnalyze(source: string): { analysis?: Analysis; error?: string } {
  try {
    return { analysis: analyze(source) };
  } catch (error) {
    return { error: String((error as Error).message) };
  }
}

/** Default code of a new feature; `body` is the body it works on, `sketch` the last sketch. */
/** The features the toolbar adds; body() adopts code, so it is written, not added. */
export type InsertableType = Exclude<FeatureType, "body">;

const DEFAULTS: Record<InsertableType, (d: { sketch: string; body: string }) => string> = {
  sketch: () => `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`,
  extrude: ({ sketch }) => `extrude({ sketch: ${sketch}, distance: 10 })`,
  fillet: ({ body }) => `fillet({ body: ${body}, edges: [], radius: 1 })`,
  chamfer: ({ body }) => `chamfer({ body: ${body}, edges: [], distance: 1 })`,
};

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A label of an entry for messages. */
const labelOf = (entry: Entry | undefined) => (!entry ? "the end" : entry.kind === "feature" ? entry.names.join(", ") : `the Custom Script at lines ${entry.lines.join("–")}`);

export function createEditor(handle: DocHandle<CadModelDoc>, model: Model, ui: Pick<UiState, "marker" | "setMarker">): Editor {
  const [source, setSource] = createSignal(handle.doc()?.source ?? "");
  const onChange = () => setSource(handle.doc()?.source ?? "");
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));

  const parsed = createMemo(() => tryAnalyze(source()));
  let lastGood: { source: string; analysis: Analysis } | undefined;
  const analysis = createMemo(() => {
    const p = parsed();
    if (p.analysis) lastGood = { source: source(), analysis: p.analysis };
    return lastGood?.analysis;
  });
  const syntaxError = () => parsed().error;
  const tl = createMemo(() => {
    const a = analysis();
    return a && lastGood ? timeline(lastGood.source, a, model.trace()) : { entries: [], returned: undefined };
  });

  // The open feature: an automerge cursor at its call, which survives renames and edits around it,
  // and its variable name as a fallback for when the whole text was replaced, which loses cursors.
  const [cursor, setCursor] = createSignal<string>();
  const [openName, setOpenName] = createSignal<string>();
  const [pickTarget, setPickTarget] = createSignal<PickTarget>();
  const doc = () => handle.doc()!;

  /** Where the open feature's call starts now: at its cursor, or else at its variable. */
  const openOffset = (a: Analysis | undefined): number | undefined => {
    const c = cursor();
    if (!c || !a) return undefined;
    try {
      const offset = getCursorPosition(doc(), ["source"], c);
      if (a.calls.some((x) => x.span.start === offset)) return offset;
    } catch {
      // The cursor's text is gone.
    }
    return a.calls.find((x) => x.variable === openName())?.span.start;
  };

  const open = createMemo(() => {
    if (syntaxError()) return undefined;
    const offset = openOffset(analysis());
    return tl().entries.find((e): e is FeatureEntry => e.kind === "feature" && e.call.span.start === offset);
  });

  // Follow renames, so that the fallback name stays current.
  createEffect(() => {
    const name = open()?.name;
    if (name && name !== openName()) setOpenName(name);
  });

  const openFeature = (entry: FeatureEntry | undefined) => {
    setPickTarget(undefined);
    setCursor(entry ? getCursor(doc(), ["source"], entry.call.span.start) : undefined);
    setOpenName(entry?.name);
  };

  /** The open feature's call, re-analyzed from the document as it is now. */
  const current = (): { call: FeatureCall; analysis: Analysis; source: string } | undefined => {
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    const offset = openOffset(a);
    const call = a?.calls.find((x) => x.span.start === offset);
    return call && a ? { call, analysis: a, source: text } : undefined;
  };

  const editOpen = (edit: (call: FeatureCall, analysis: Analysis, source: string) => Edit[]) => {
    const c = current();
    if (!c) return false;
    const edits = edit(c.call, c.analysis, c.source);
    if (tryAnalyze(applyToText(c.source, edits)).error !== undefined) return false;
    apply(handle, edits);
    return true;
  };

  const insert = (type: InsertableType) => {
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return;
    const name = freshName(text, type);
    const tl = timeline(text, a, []);
    // New features go to the marker; before it, the timeline is what the model is up to there.
    const position = markerIn(tl, ui.marker());
    const before: Timeline = { ...tl, entries: tl.entries.slice(0, position) };
    // At the end, a new fillet or chamfer works on the visible result, which may come from a Custom
    // Script; before the end, on the body that the next feature after the marker works on, e.g. what a loop made.
    const returned = position === tl.entries.length ? returnedVariables(a) : [];
    const deps = graph(a, tl);
    const declaredBefore = (name: string) => (deps.declaredBy.get(name) ?? Infinity) < position;
    const nextInput = tl.entries
      .slice(position)
      .map((_, i) => inputOf(deps, position + i)?.name)
      .find((name) => name !== undefined && declaredBefore(name));
    const body = (returned.length === 1 ? returned[0] : undefined) ?? nextInput ?? lastOf(before, "body") ?? "undefined";
    const sketch = lastOf(before, "sketch");
    const code = DEFAULTS[type]({ sketch: sketch ?? "undefined", body });
    const consumes = type === "fillet" || type === "chamfer" ? body : undefined;
    const hides = type === "extrude" ? sketch : undefined;
    apply(handle, insertFeatureAt(text, a, tl, name, code, position, { shows: true, ...(consumes ? { consumes } : {}), ...(hides ? { hides } : {}) }));
    const after = tryAnalyze(doc().source).analysis;
    const call = after?.calls.find((x) => x.variable === name);
    if (!call) return;
    setCursor(getCursor(doc(), ["source"], call.span.start));
    setOpenName(name);
    setPickTarget(type === "fillet" || type === "chamfer" ? { param: "edges", kind: "edge", multi: true } : undefined);
  };

  const deleteOpen = () => {
    const entry = open();
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    if (!entry || !a) return;
    const fresh = timeline(text, a, []).entries.find((e): e is FeatureEntry => e.kind === "feature" && e.name === entry.name);
    if (!fresh) return;
    openFeature(undefined);
    apply(handle, deleteFeature(text, a, fresh));
  };

  const pick = async (entity: Entity) => {
    const target = pickTarget();
    if (!target) return;
    const { code } = await model.engine.pick(entity.body, entity.kind, entity.index);
    const bodyIsVariable = model.trace().some((t) => t.variable && t.result === entity.body);
    editOpen((call, a, text) => {
      const edits: Edit[] = [...ensureImports(a, usedFunctions(code))];
      if (target.multi) {
        const existing = elements(call, target.param).findIndex((s) => text.slice(s.start, s.end) === code);
        edits.push(...(existing >= 0 ? removeElement(call, target.param, existing) : appendElement(call, target.param, code)));
      } else edits.push(...setProp(call, target.param, code));
      // The feature works on the body the user picked from.
      const bodyParam = call.type === "sketch" || call.type === "fillet" || call.type === "chamfer" ? "body" : undefined;
      const currentBody = call.props?.find((p) => p.key === bodyParam);
      if (bodyParam && bodyIsVariable && (!currentBody || text.slice(currentBody.value.start, currentBody.value.end) !== entity.body)) edits.push(...setProp(call, bodyParam, entity.body));
      return edits;
    });
    if (!target.multi) setPickTarget(undefined);
  };

  const variablesBefore = (kind: "body" | "sketch") => {
    const entries = tl().entries;
    const index = entries.findIndex((e) => e === open());
    return entries
      .slice(0, index < 0 ? entries.length : index)
      .filter((e): e is FeatureEntry => e.kind === "feature" && (kind === "sketch") === (e.type === "sketch"))
      .map((e) => e.name);
  };

  const g = createMemo(() => {
    const a = analysis();
    return a ? graph(a, tl()) : undefined;
  });

  /** A marker's position in a timeline of the document's current source; undefined is at the end. */
  function markerIn(t: Timeline, m: TimelineMarker | undefined): number {
    if (!m) return t.entries.length;
    let offset: number | undefined;
    try {
      offset = getCursorPosition(doc(), ["source"], m.cursor);
    } catch {
      // The cursor's text was replaced as a whole.
    }
    return markerPosition(t, offset, m.next || undefined);
  }
  // While the code doesn't parse, the timeline is the last valid one and offsets don't match it: keep the marker.
  const marker = createMemo<number>((previous) => {
    source();
    return syntaxError() && previous !== undefined ? previous : markerIn(tl(), ui.marker());
  });
  /** Puts the marker before entry `position` of `t`, a timeline of the document's current source. */
  const setMarkerIn = (t: Timeline, position: number) => {
    const entry = t.entries[position];
    if (!entry) return ui.setMarker(undefined);
    ui.setMarker({ cursor: getCursor(doc(), ["source"], entry.span.start, "after"), next: entry.kind === "feature" ? entry.name : "" });
  };
  const setMarker = (position: number) => (syntaxError() ? undefined : setMarkerIn(tl(), position));

  const [notice, setNotice] = createSignal<string>();
  const [hovered, setHovered] = createSignal<number>();
  const [dragging, setDragging] = createSignal<number>();
  const focused = () => {
    const d = dragging() ?? hovered();
    if (d !== undefined) return d;
    const index = tl().entries.findIndex((e) => e === open());
    return index < 0 ? undefined : index;
  };
  const related = createMemo(() => {
    const index = focused();
    const graph = g();
    return new Map(index === undefined || !graph ? [] : relations(graph, index).map((r) => [r.index, r]));
  });

  const [codeHover, setCodeHoverOffset] = createSignal<number>();
  const [codeCursor, setCodeCursorOffset] = createSignal<number>();
  /** Which of the two moved last: it wins while both are in the code pane, e.g. typing with the pointer parked over other code. */
  const [codeLast, setCodeLast] = createSignal<"hover" | "cursor">("hover");
  const setCodeHover = (offset: number | undefined) => {
    setCodeHoverOffset(offset);
    if (offset !== undefined) setCodeLast("hover");
  };
  const setCodeCursor = (offset: number | undefined) => {
    setCodeCursorOffset(offset);
    if (offset !== undefined) setCodeLast("cursor");
  };
  /** The features at a code position: its feature statement's, or in a Custom Script those that ran on its line, e.g. each rib of a loop. */
  const featuresAt = (offset: number): string[] => {
    const entry = tl().entries.find((e) => e.span.start <= offset && offset < e.span.end);
    if (entry?.kind !== "script") return ownersOf(entry);
    const line = source().slice(0, offset).split("\n").length;
    return entry.features.filter((f) => f.line === line).flatMap(ownerNames);
  };
  /** The features of the code under the pointer or at the cursor of the focused code pane, whichever moved last. */
  const codeFeatures = createMemo(
    () => {
      const offset = codeLast() === "hover" ? (codeHover() ?? codeCursor()) : (codeCursor() ?? codeHover());
      return offset === undefined || syntaxError() ? [] : featuresAt(offset);
    },
    [],
    { equals: sameNames },
  );
  const hoveredFeatures = createMemo(
    () => {
      const index = dragging() ?? hovered();
      return index !== undefined ? ownersOf(tl().entries[index]) : codeFeatures();
    },
    [],
    { equals: sameNames },
  );
  const [viewHover, setViewHover] = createSignal<string[]>([], { equals: sameNames });
  const crossHovered = createMemo(() => {
    const names = new Set([...viewHover(), ...codeFeatures()]);
    return new Set(tl().entries.flatMap((e, i) => (ownersOf(e).some((n) => names.has(n)) ? [i] : [])));
  });

  const blocked = (index: number, position: number): string | undefined => {
    const graph = g();
    const entries = tl().entries;
    if (!graph || syntaxError()) return "The code doesn't parse.";
    if (position === index || position === index + 1) return undefined;
    if (canMove(graph, index, position)) return undefined;
    const range = allowedRange(graph, index);
    const name = labelOf(entries[index]);
    if (position < range.min) return `${name} can't move before ${labelOf(entries[range.minBy ?? 0])}, which it uses.`;
    return `${name} can't move after ${labelOf(entries[range.maxBy ?? entries.length])}, which uses it.`;
  };

  /**
   * Why `edits` of `text` would break the model, from a trial build without meshing (`check`): it
   * fails where the current build doesn't, or more features fail. `doing` starts the message.
   */
  const breaks = async (doing: string, text: string, edits: Edit[]): Promise<string | undefined> => {
    let changed = text;
    for (const e of [...edits].sort((x, y) => y.start - x.start)) changed = changed.slice(0, e.start) + e.text + changed.slice(e.end);
    const result = await model.engine.check(changed);
    if (result.error && !model.error()) return `${doing} breaks the model: ${result.error.message}`;
    const problems = model.trace().filter((t) => t.status !== "ok").length;
    const broken = result.problems - problems;
    return broken > 0 ? `${doing} breaks ${broken} feature${broken === 1 ? "" : "s"}.` : undefined;
  };

  /**
   * Applies a refactoring of entry `index` of the shown timeline, computed on the document as it is
   * now; with `trial`, only if a trial build says it doesn't break the model. `doing` starts the
   * message of why not, which it resolves to.
   */
  const refactorEntry = async (index: number, make: (text: string, a: Analysis, fresh: Timeline, i: number) => Refactoring, doing: string, trial = false): Promise<string | undefined> => {
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return "The code doesn't parse.";
    const fresh = timeline(text, a, []);
    const i = freshIndex(fresh, index);
    if (i < 0) return "The timeline changed meanwhile.";
    const r = make(text, a, fresh, i);
    if ("error" in r) return `${doing} doesn't work: ${r.error}.`;
    if (trial) {
      const why = await breaks(doing, text, r.edits);
      if (why) return why;
      if (doc().source !== text) return "The model changed meanwhile; try again.";
    }
    apply(handle, r.edits);
    return undefined;
  };

  const renameEntry = (index: number, from: string, to: string) => refactorEntry(index, (_, a, fresh, i) => rename(a, fresh, i, from, to), `Renaming ${from} to ${to}`);
  const wrap = (index: number) => refactorEntry(index, wrapInBody, `Wrapping ${labelOf(tl().entries[index])} in body()`, true);
  const unwrap = (index: number) => refactorEntry(index, unwrapBody, `Unwrapping ${labelOf(tl().entries[index])}`);
  const remove = (index: number) => {
    const entry = tl().entries[index];
    if (entry?.kind === "feature" && open() === entry) openFeature(undefined);
    return refactorEntry(
      index,
      (text, a, fresh, i) => {
        const e = fresh.entries[i]!;
        return e.kind === "feature" ? { edits: deleteFeature(text, a, e) } : deleteScript(text, a, fresh, i);
      },
      `Deleting ${labelOf(entry)}`,
    );
  };

  /** The entry in a fresh timeline that is entry `index` of the shown one. */
  const freshIndex = (fresh: Timeline, index: number): number => {
    const shown = tl().entries[index];
    if (!shown) return fresh.entries.length;
    if (shown.kind === "feature") return fresh.entries.findIndex((e) => e.kind === "feature" && e.name === shown.name);
    return fresh.entries[index]?.kind === "script" ? index : -1;
  };

  const move = async (index: number, position: number, pastMarker: boolean): Promise<string | undefined> => {
    const m = marker();
    const past = position === m ? pastMarker : position > m;
    // After the move, the marker is after the same other entries as before, and the moved entry on the side it was dropped.
    const markerGap = m - (index < m ? 1 : 0) + (past ? 0 : 1);
    if (position === index || position === index + 1) {
      if (past !== index >= m) setMarker(markerGap);
      return undefined;
    }
    const why = blocked(index, position);
    if (why) return why;
    const entry = tl().entries[index];
    // Custom Script code is opaque: try the move in the background first and keep it only if the model still builds as well as before.
    if (entry?.kind === "script") {
      const text = doc().source;
      const { analysis: a } = tryAnalyze(text);
      if (!a) return "The code doesn't parse.";
      const fresh = timeline(text, a, []);
      const edits = moveEntry(text, a, fresh, freshIndex(fresh, index), freshIndex(fresh, position));
      const target = tl().entries[position];
      const why = await breaks(`Moving ${labelOf(entry)} ${target ? `before ${labelOf(target)}` : "to the end"}`, text, edits);
      if (why) return why;
    }
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return "The code doesn't parse.";
    const fresh = timeline(text, a, []);
    const from = freshIndex(fresh, index);
    const to = freshIndex(fresh, position);
    if (from < 0 || to < 0) return "The timeline changed meanwhile.";
    if (!canMove(graph(a, fresh), from, to)) return blocked(index, position) ?? "The timeline changed meanwhile.";
    apply(handle, moveEntry(text, a, fresh, from, to));
    const after = tryAnalyze(doc().source).analysis;
    if (after) setMarkerIn(timeline(doc().source, after, []), markerGap);
    return undefined;
  };

  return {
    source,
    analysis,
    timeline: tl,
    syntaxError,
    open,
    openFeature,
    pickTarget,
    setPickTarget,
    editOpen,
    insert,
    deleteOpen,
    pick,
    variablesBefore,
    graph: g,
    marker,
    markerOf: (m: TimelineMarker | undefined) => (syntaxError() ? tl().entries.length : markerIn(tl(), m)),
    setMarker,
    hovered: () => dragging() ?? hovered(),
    setHovered,
    setDragging,
    dragging,
    focused,
    related,
    setCodeHover,
    setCodeCursor,
    hoveredFeatures,
    setViewHover,
    crossHovered,
    blocked,
    notice,
    setNotice,
    move,
    rename: renameEntry,
    wrap,
    unwrap,
    remove,
  };
}

export const schemaOf = (type: FeatureType) => schemas[type];
