/**
 * State of the WYSIWYG editor. Everything is derived from the document's source text and the last
 * build's trace; the editor owns no model state of its own (research/02, "The timeline is a
 * view"). The selected item is anchored with an automerge cursor, so that it stays selected while
 * others edit the code around it, or rename it.
 */
import { getCursor, getCursorPosition } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { batch, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { schemas, type FeatureType, type ParamSpec } from "@patchwork-cad/features/schema";
import { analyze, returnedOutputs, type Analysis, type FeatureCall } from "../../model/analyze.ts";
import { allowedRange, canMove, graph, inputOf, paramRole, relations, type Graph, type Relation } from "../../model/deps.ts";
import {
  addToReturn,
  apply,
  applyToText,
  appendElement,
  chainMode,
  deleteFeature,
  elements,
  ensureImports,
  freshName,
  insertFeatureAt,
  lastOf,
  moveEntry,
  removeElement,
  removeFromReturn,
  rebody,
  resketch,
  retarget,
  retool,
  returnEditable,
  outputKeys,
  returnedVariables,
  setChainMode,
  setProp,
  usedFunctions,
  type Edit,
} from "../../model/splice.ts";
import { lanes as lanesOf, type Lanes } from "../../model/lanes.ts";
import { deleteScript, rename, renameOutput, unwrapBody, wrapInBody, type Refactoring } from "../../model/refactor.ts";
import { markerPosition, ownerNames, ownersOf, timeline, type Entry, type FeatureEntry, type Timeline } from "../../model/timeline.ts";
import { documentStatements, usersOf, type DocumentStatement } from "../../model/documents.ts";
import type { CadModelDoc, TimelineMarker } from "../../types.ts";
import type { Model } from "../createModel.ts";
import type { UiState } from "../uiState.ts";
import type { Entity, EntityKind } from "../Viewer.tsx";

export interface PickTarget {
  /** The parameter that a picked entity fills. */
  param: string;
  /**
   * A face or edge of a body, or a body or sketch as a whole, which is picked as its variable
   * (research/15, "Availability"); `version` is either, e.g. for the return (`param: "return"`).
   */
  kind: EntityKind | "body" | "sketch" | "version";
  /** Whether picks are added to a list (edges, tools) or replace the value (a sketch plane, a target). */
  multi: boolean;
}

/** A hovered lineage: its lane, and the version of it a click there opens or picks (research/15, "The browser"). */
export interface LaneHover {
  lane: number;
  version: string;
}

export type SelectionKind = "feature" | "script" | "params" | "configuration" | "return" | "view" | "document" | "insert";
/** Where a selection was made: that pane doesn't scroll to it. */
export type SelectionFrom = "browser" | "timeline" | "code" | "view" | "dialog" | "toolbar";

/**
 * The selected item (research/19-selection.md, "The selection"). A timeline entry's `id` is an
 * automerge cursor at the start of its code; a configuration's or a view's is its own (`""` is
 * Defaults); a document's is its URL without heads and the type it is imported with
 * (`documentId`), or for a linked value's document its URL as a link; a pending insert's is a number
 * of this tab's (research/21, "Dropping, pasting, inserting"); the parameters and the return have none.
 */
export interface Selection {
  kind: SelectionKind;
  id: string;
  from: SelectionFrom;
}

/** What can be selected: a timeline entry by its index, or another item. */
export type Selectable = { kind: "entry"; index: number } | { kind: "params" | "return" } | { kind: "configuration" | "view" | "document" | "insert"; id: string };

/** A document the model's code imports (research/21, "The documents list"): its import statements, and what uses them. */
export interface ModelDocument {
  /** `documentId`: its URL without heads and the type it is imported with. */
  id: string;
  statements: DocumentStatement[];
  /** The timeline entries that use it, and whether the parameters do. */
  users: { entries: number[]; params: boolean };
}

export interface Editor {
  source: Accessor<string>;
  /** The last source that parsed, with its timeline; forms are read-only while the code doesn't parse. */
  analysis: Accessor<Analysis | undefined>;
  timeline: Accessor<Timeline>;
  syntaxError: Accessor<string | undefined>;
  /** The one selected item, whose dialog is open (research/19-selection.md); changes only when something else is selected. */
  selection: Accessor<Selection | undefined>;
  /** Selects an item, or nothing; ends picking. */
  select(item: Selectable | undefined, from: SelectionFrom): void;
  /** Whether `item` is the selected one, e.g. to close it with a click on it. */
  isSelected(item: Selectable): boolean;
  /** The selected timeline entry, a feature's or a Custom Script's, by index; kept while the code doesn't parse. */
  selectedIndex: Accessor<number | undefined>;
  /** The selection as `{ kind, id }` for collaborators, an entry's id being an automerge cursor at the start of its code; none for a pending insert. */
  shared: Accessor<{ kind: Exclude<SelectionKind, "insert">; id: string } | undefined>;
  /** The timeline entry a collaborator's selection `{ kind, id }` stands for, if it is one. */
  entryOf(selection: { kind: string; id: string } | undefined): number | undefined;
  /** The selected feature, if it has a dialog: not a body() (research/11). */
  open: Accessor<FeatureEntry | undefined>;
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
  /** Fills the pick target with the picked entity's reference, or with its body's variable. */
  pick(entity: Entity): Promise<void>;
  /**
   * While faces or edges are picked that decide the open feature's body, and it has some already:
   * that body, whose entities alone can be picked (research/15, "Availability").
   */
  boundBody: Accessor<string | undefined>;
  /** Fills a body or sketch pick target with a version, by its variable; a list gains or loses it. Resolves to why not. */
  pickVersion(name: string): string | undefined;
  /** Whether a version can fill the current body or sketch pick target: one of the right kind before the open feature. */
  pickable(name: string): boolean;
  /** While a body or sketch field or the return is picked, the versions it holds. */
  pickedVersions: Accessor<string[]>;
  /** Whether a body or sketch field is picked. */
  pickingVersion: Accessor<boolean>;
  /** The version of entry `index`, if it has exactly one, e.g. to pick it. */
  versionAt(index: number): string | undefined;
  /** While a face, edge, body or sketch is picked, the open feature's entry, before which the view is rolled back. */
  pickingAt: Accessor<number | undefined>;
  /** The lineages of bodies and their lanes (research/15). */
  lanes: Accessor<Lanes | undefined>;
  /** The lineage hovered in the browser or the timeline's lanes. */
  hoveredLane: Accessor<LaneHover | undefined>;
  setHoveredLane(hover: LaneHover | undefined): void;
  /** Whether the return entry, or its code, is hovered. */
  resultHovered: Accessor<boolean>;
  setResultHovered(hovered: boolean): void;
  /**
   * The lanes to highlight: the hovered lineage's, or those the hovered features write into or end
   * in, wherever they are hovered (research/15, "The timeline with lanes").
   */
  highlightedLanes: Accessor<Set<number>>;
  /** While a lineage is hovered: the entry a click opens or picks, and those of its other versions and the one it merges into. */
  lineage: Accessor<{ primary: number | undefined; entries: Set<number> } | undefined>;
  /** Whether the editor can edit what main returns. */
  returnEditable: Accessor<boolean>;
  /** What main returns, each version under its key (research/15, "Output"), if the editor can edit it. */
  outputs: Accessor<{ key: string; name: string }[]>;
  /** Renames output `from` to `to`; resolves to why not. */
  renameOutput(from: string, to: string): Promise<string | undefined>;
  /**
   * Renames a body as the browser lists it: a returned one by its key, `output`, else the variable
   * of its version `name`; resolves to why not.
   */
  renameBody(name: string, output: string | undefined, to: string): Promise<string | undefined>;
  /** Returns a version or makes it private. */
  setOutput(name: string, returned: boolean): void;
  /** Whether the open feature joins its input's chain or branches off it, if it has the choice. */
  chainMode: Accessor<"join" | "branch" | undefined>;
  setChainMode(mode: "join" | "branch"): void;
  /** The dependencies between the timeline's entries. */
  graph: Accessor<Graph | undefined>;
  /**
   * The timeline marker: entries from this index on are rolled back. `entries.length` is before the
   * return, where the view shows what exists after the last feature; `entries.length + 1`, the end,
   * is past it, where the view shows what main returns (research/15, "The timeline with lanes").
   */
  marker: Accessor<number>;
  setMarker(position: number): void;
  /** Where another marker, e.g. a collaborator's, is in the timeline. */
  markerOf(marker: TimelineMarker | undefined): number;
  /** The entry being hovered or dragged in the timeline. */
  hovered: Accessor<number | undefined>;
  /** Hovers entry `index`, or one of its versions by its node in the lanes. */
  setHovered(index: number | undefined, version?: string): void;
  /** The version a click on the hovered entry or node would pick: the node's, or the entry's only one. */
  hoveredVersion: Accessor<string | undefined>;
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
  /** Whether the return is hovered in the code or has its cursor. */
  returnCrossHovered: Accessor<boolean>;
  /** The documents the code imports, from its last valid state. */
  documents: Accessor<ModelDocument[]>;
  /** The document hovered in the documents list or the dialog, by id. */
  hoveredDocument: Accessor<string | undefined>;
  setHoveredDocument(id: string | undefined): void;
  /** The document whose users are highlighted: the hovered one, else the selected one (research/21, "The documents list"). */
  focusedDocument: Accessor<string | undefined>;
  /** The documents entry `index` uses, by id. */
  documentsOf(index: number): string[];
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
  combine: ({ body }) => `combine({ target: ${body}, tools: [] })`,
  sketch: () => `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`,
  extrude: ({ sketch }) => `extrude({ sketch: ${sketch}, distance: 10 })`,
  fillet: ({ body }) => `fillet({ body: ${body}, edges: [], radius: 1 })`,
  chamfer: ({ body }) => `chamfer({ body: ${body}, edges: [], distance: 1 })`,
  move: ({ body }) => `move({ body: ${body}, x: 20 })`,
};

/** A marker's `next` when it is before the return, for when its cursor is lost. */
const RETURN = "return";

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The body parameter of feature `type` that the faces or edges of parameter `param` decide (`from`), if any. */
export const derivedBody = (type: string, param: string): string | undefined =>
  Object.entries((schemas as Record<string, { params: Record<string, ParamSpec> }>)[type]?.params ?? {}).find(([, spec]) => spec.kind === "body" && spec.from === param)?.[0];

/** A label of an entry for messages. */
const labelOf = (entry: Entry | undefined) => (!entry ? "the end" : entry.kind === "feature" ? entry.names.join(", ") : `the Custom Script at lines ${entry.lines.join("–")}`);

export function createEditor(handle: DocHandle<CadModelDoc>, model: Model, ui: Pick<UiState, "marker" | "setMarker" | "renameVisibility">): Editor {
  const [source, setSource] = createSignal(handle.doc()?.content ?? "");
  const onChange = () => setSource(handle.doc()?.content ?? "");
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

  const [pickTarget, setPickTarget] = createSignal<PickTarget>();
  const doc = () => handle.doc()!;

  // The selection (research/19-selection.md). A timeline entry is anchored with an automerge cursor
  // at the start of its code, a feature's call, which survives renames and edits around it; and with
  // its variable name, or a Custom Script's index, for when the whole text was replaced, which loses
  // cursors, and while the code doesn't parse, when offsets don't match the timeline shown.
  const [selection, setSelection] = createSignal<Selection>();
  const [anchor, setAnchor] = createSignal<{ cursor: string | undefined; name: string | undefined; index: number }>();
  /** Where an entry's anchor is, from where its code starts. */
  const anchorAt = (entry: Entry) => (entry.kind === "feature" ? entry.call.span.start : entry.span.start);
  /** A cursor's offset in the document, unless its text is gone. */
  const offsetOf = (cursor: string | undefined): number | undefined => {
    if (!cursor) return undefined;
    try {
      return getCursorPosition(doc(), ["content"], cursor);
    } catch {
      return undefined;
    }
  };
  /** The entry of kind `kind` anchored at `offset`: a feature's call starts there, a Custom Script is the first entry that ends after it. */
  const entryAtOffset = (entries: Entry[], kind: string, offset: number): number => {
    if (kind === "feature") return entries.findIndex((e) => e.kind === "feature" && e.call.span.start === offset);
    const index = entries.findIndex((e) => e.span.end > offset);
    return entries[index]?.kind === "script" ? index : -1;
  };
  /** The entry an anchor stands for: by its cursor, else a feature by its name, a Custom Script by its index if the cursor is lost. */
  const resolve = (entries: Entry[], kind: SelectionKind, a: { cursor: string | undefined; name: string | undefined; index: number }, byOffset: boolean): number | undefined => {
    const offset = byOffset ? offsetOf(a.cursor) : undefined;
    if (offset !== undefined) {
      const index = entryAtOffset(entries, kind, offset);
      if (index >= 0) return index;
      if (kind === "script") return undefined;
    }
    if (kind === "feature") {
      const index = entries.findIndex((e) => e.kind === "feature" && e.name === a.name);
      return index < 0 ? undefined : index;
    }
    return entries[a.index]?.kind === "script" ? a.index : undefined;
  };
  /** The selection the selected entry was last resolved for, which it keeps while the code doesn't parse. */
  let resolvedFor: Selection | undefined;
  const selectedIndex = createMemo<number | undefined>((previous) => {
    const s = selection();
    const a = anchor();
    source();
    if (!s || !a || (s.kind !== "feature" && s.kind !== "script")) return undefined;
    const entries = tl().entries;
    // While the code doesn't parse, the timeline is the last valid one: the entry stays, or another is selected in it.
    if (syntaxError()) return resolvedFor === s && previous !== undefined ? previous : resolve(entries, s.kind, a, false);
    resolvedFor = s;
    return resolve(entries, s.kind, a, true);
  });
  // Follow renames, moves and lost cursors, so that the fallbacks stay current. A deleted entry is no
  // longer selected; a feature whose statement only stops being one for a while, e.g. while a
  // collaborator's `//` comments out the import above it, stays selected while its name is in the code.
  createEffect(() => {
    const s = selection();
    const index = selectedIndex();
    if (!s || (s.kind !== "feature" && s.kind !== "script") || syntaxError()) return;
    const a = untrack(anchor);
    if (index === undefined) {
      const name = s.kind === "feature" ? a?.name : undefined;
      if (!name || !new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}($|[^\\w$])`).test(source())) setSelection(undefined);
      return;
    }
    const entry = tl().entries[index]!;
    const name = entry.kind === "feature" ? entry.name : undefined;
    const lost = offsetOf(a?.cursor) === undefined;
    if (a && !lost && a.name === name && a.index === index) return;
    setAnchor({ cursor: lost ? getCursor(doc(), ["content"], anchorAt(entry)) : a?.cursor, name, index });
  });
  const open = createMemo(() => {
    const index = selectedIndex();
    const entry = index === undefined ? undefined : tl().entries[index];
    return entry?.kind === "feature" && entry.type !== "body" ? entry : undefined;
  });

  const select = (item: Selectable | undefined, from: SelectionFrom) =>
    batch(() => {
      setPickTarget(undefined);
      if (item?.kind !== "entry") {
        setAnchor(undefined);
        setSelection(item ? { kind: item.kind, id: "id" in item ? item.id : "", from } : undefined);
        return;
      }
      const entry = tl().entries[item.index];
      if (!entry) return;
      // While the code doesn't parse, offsets are the last valid code's: the fallbacks anchor it until it parses again.
      const cursor = syntaxError() ? undefined : getCursor(doc(), ["content"], anchorAt(entry));
      setAnchor({ cursor, name: entry.kind === "feature" ? entry.name : undefined, index: item.index });
      setSelection({ kind: entry.kind, id: cursor ?? "", from });
    });
  const isSelected = (item: Selectable): boolean => {
    const s = selection();
    if (!s) return false;
    if (item.kind === "entry") return selectedIndex() === item.index;
    // The parameters entry stands for the configurations, too.
    if (item.kind === "params") return s.kind === "params" || s.kind === "configuration";
    return s.kind === item.kind && ("id" in item ? item.id === s.id : true);
  };
  const shared = () => {
    const s = selection();
    // A pending insert names nothing in the model yet: collaborators can't resolve it.
    const kind = s?.kind;
    if (!s || kind === undefined || kind === "insert") return undefined;
    return kind === "feature" || kind === "script" ? { kind, id: anchor()?.cursor ?? "" } : { kind, id: s.id };
  };
  const entryOf = (s: { kind: string; id: string } | undefined): number | undefined => {
    if (!s || (s.kind !== "feature" && s.kind !== "script") || syntaxError()) return undefined;
    source();
    const offset = offsetOf(s.id);
    const index = offset === undefined ? -1 : entryAtOffset(tl().entries, s.kind, offset);
    return index < 0 ? undefined : index;
  };

  /** The open feature's call, re-analyzed from the document as it is now. */
  const current = (): { call: FeatureCall; analysis: Analysis; source: string } | undefined => {
    const text = doc().content;
    const { analysis: a } = tryAnalyze(text);
    const s = selection();
    const at = anchor();
    if (!a || s?.kind !== "feature" || !at) return undefined;
    const entries = timeline(text, a, []).entries;
    const index = resolve(entries, "feature", at, true);
    const entry = index === undefined ? undefined : entries[index];
    return entry?.kind === "feature" ? { call: entry.call, analysis: a, source: text } : undefined;
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
    const text = doc().content;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return;
    const name = freshName(text, type);
    const tl = timeline(text, a, []);
    // New features go to the marker; before it, the timeline is what the model is up to there.
    const position = markerIn(tl, ui.marker());
    const before: Timeline = { ...tl, entries: tl.entries.slice(0, position) };
    // At the end, a new fillet or chamfer works on the visible result, which may come from a Custom
    // Script; before the end, on the body that the next feature after the marker works on, e.g. what a loop made.
    const returned = position >= tl.entries.length ? returnedVariables(a) : [];
    const deps = graph(a, tl);
    const declaredBefore = (name: string) => (deps.declaredBy.get(name) ?? Infinity) < position;
    const nextInput = tl.entries
      .slice(position)
      .map((_, i) => inputOf(deps, position + i)?.name)
      .find((name) => name !== undefined && declaredBefore(name));
    const body = (returned.length === 1 ? returned[0] : undefined) ?? nextInput ?? lastOf(before, "body") ?? "undefined";
    const sketch = lastOf(before, "sketch");
    const code = DEFAULTS[type]({ sketch: sketch ?? "undefined", body });
    const consumes = type === "fillet" || type === "chamfer" || type === "combine" ? body : undefined;
    const hides = type === "extrude" ? sketch : undefined;
    apply(handle, insertFeatureAt(text, a, tl, name, code, position, { shows: true, ...(consumes ? { consumes } : {}), ...(hides ? { hides } : {}) }));
    const after = tryAnalyze(doc().content).analysis;
    const entries = after ? timeline(doc().content, after, []).entries : [];
    const index = entries.findIndex((e) => e.kind === "feature" && e.name === name);
    const entry = entries[index];
    if (entry?.kind !== "feature") return;
    const cursor = getCursor(doc(), ["content"], entry.call.span.start);
    batch(() => {
      setAnchor({ cursor, name, index });
      setSelection({ kind: "feature", id: cursor, from: "toolbar" });
    });
    setPickTarget(type === "fillet" || type === "chamfer" ? { param: "edges", kind: "edge", multi: true } : type === "combine" ? { param: "tools", kind: "body", multi: true } : undefined);
  };

  const deleteOpen = () => {
    const entry = open();
    const text = doc().content;
    const { analysis: a } = tryAnalyze(text);
    if (!entry || !a) return;
    const fresh = timeline(text, a, []).entries.find((e): e is FeatureEntry => e.kind === "feature" && e.name === entry.name);
    if (!fresh) return;
    select(undefined, "dialog");
    apply(handle, deleteFeature(text, a, fresh));
  };

  const boundBody = () => {
    const target = pickTarget();
    const entry = open();
    if (!target?.multi || (target.kind !== "face" && target.kind !== "edge") || !entry) return undefined;
    if (!derivedBody(entry.type, target.param) || elements(entry.call, target.param).length === 0) return undefined;
    // The body it got in the last build, which picks name: its variable may be another's, e.g. one a Custom Script reassigns.
    return entry.trace?.inputs[0];
  };
  const pick = async (entity: Entity) => {
    const target = pickTarget();
    if (!target) return;
    if (target.kind === "body" || target.kind === "sketch" || target.kind === "version") {
      const why = pickVersion(entity.body);
      if (why) throw new Error(why);
      return;
    }
    const bound = boundBody();
    if (bound !== undefined && bound !== entity.body) throw new Error(`${open()?.name ?? "The feature"} works on ${bound}`);
    const { code } = await model.engine.pick(entity.body, entity.kind, entity.index);
    const bodyIsVariable = model.trace().some((t) => t.variable && t.result === entity.body);
    editOpen((call, a, text) => {
      const edits: Edit[] = [...ensureImports(a, usedFunctions(code))];
      if (target.multi) {
        const existing = elements(call, target.param).findIndex((s) => text.slice(s.start, s.end) === code);
        edits.push(...(existing >= 0 ? removeElement(call, target.param, existing) : appendElement(call, target.param, code)));
      } else edits.push(...setProp(call, target.param, code));
      // The feature works on the body the user picked from, as if it had been inserted on it.
      const bodyParam = derivedBody(call.type, target.param);
      const currentBody = call.props?.find((p) => p.key === bodyParam);
      if (bodyParam && bodyIsVariable && (!currentBody || text.slice(currentBody.value.start, currentBody.value.end) !== entity.body)) {
        const fresh = timeline(text, a, []);
        const index = fresh.entries.findIndex((e) => e.kind === "feature" && e.name === open()?.name);
        const moved = currentBody && index >= 0 ? rebody(a, fresh, index, entity.body) : [];
        edits.push(...(moved.length ? moved : setProp(call, bodyParam, entity.body)));
      }
      return edits;
    });
    if (!target.multi) setPickTarget(undefined);
  };

  const g = createMemo(() => {
    const a = analysis();
    return a ? graph(a, tl()) : undefined;
  });
  const lanes = createMemo(() => {
    const graph = g();
    return graph ? lanesOf(tl(), graph) : undefined;
  });
  const [hoveredLane, setHoveredLane] = createSignal<LaneHover | undefined>(undefined, { equals: (a, b) => a?.lane === b?.lane && a?.version === b?.version });
  const [resultHovered, setResultHovered] = createSignal(false);

  const pickable = (name: string): boolean => {
    const target = pickTarget();
    const entry = open();
    const version = lanes()?.versions.get(name);
    // The return can take any version.
    if (target?.param === RETURN) return !!version;
    if (!target || !entry || !version || version.kind !== target.kind) return false;
    const index = tl().entries.indexOf(entry);
    return version.entry < index;
  };

  const pickVersion = (name: string): string | undefined => {
    const target = pickTarget();
    if (target?.param === RETURN) {
      if (!pickable(name)) return `${name} isn't a body or sketch.`;
      setOutput(name, !lanes()?.returned.has(name));
      return undefined;
    }
    const entry = open();
    if (!target || !entry || (target.kind !== "body" && target.kind !== "sketch")) return undefined;
    if (!pickable(name)) return `${name} isn't a ${target.kind} before ${entry.name}.`;
    let why: string | undefined;
    const valueOf = (call: FeatureCall, text: string, key: string) => {
      const p = call.props?.find((x) => x.key === key);
      return p?.node.type === "Identifier" ? text.slice(p.value.start, p.value.end) : undefined;
    };
    editOpen((call, a, text) => {
      if (target.multi) {
        const items = elements(call, target.param).map((s) => text.slice(s.start, s.end));
        const at = items.indexOf(name);
        if (at >= 0) return [...removeElement(call, target.param, at), ...retool(a, call, undefined, name)];
        if (valueOf(call, text, "target") === name) {
          why = `${name} is the target of ${entry.name}.`;
          return [];
        }
        return [...appendElement(call, target.param, name), ...retool(a, call, name, undefined)];
      }
      const previous = valueOf(call, text, target.param);
      if (previous === name) return [];
      if (target.param === "target" && elements(call, "tools").some((s) => text.slice(s.start, s.end) === name)) {
        why = `${name} is a tool of ${entry.name}.`;
        return [];
      }
      // A body it consumes takes its place in the result, and the previous one comes back; a body it reads, e.g. one it copies, stays.
      const role = paramRole(call.type, target.param);
      const result = target.kind === "sketch" ? resketch(a, call, previous, name) : role === "consume" ? retarget(a, call, entry.name, previous, name) : [];
      return [...setProp(call, target.param, name), ...result];
    });
    if (!target.multi && !why) setPickTarget(undefined);
    return why;
  };

  /** The current document, analyzed, with its timeline. */
  const fresh = () => {
    const text = doc().content;
    const { analysis: a } = tryAnalyze(text);
    return a ? { text, a, t: timeline(text, a, []) } : undefined;
  };
  const setOutput = (name: string, returned: boolean) => {
    const f = fresh();
    if (f) apply(handle, returned ? addToReturn(f.text, f.a, name) : removeFromReturn(f.a, name));
  };
  const openChainMode = createMemo(() => {
    const graph = g();
    const index = tl().entries.findIndex((e) => e === open());
    return graph && index >= 0 && !syntaxError() ? chainMode(graph, index) : undefined;
  });
  const setOpenChainMode = (mode: "join" | "branch") => {
    const f = fresh();
    const name = open()?.name;
    const index = f?.t.entries.findIndex((e) => e.kind === "feature" && e.name === name) ?? -1;
    if (f && index >= 0) apply(handle, setChainMode(f.text, f.a, f.t, index, mode));
  };

  /** A marker's position in a timeline of the document's current source; undefined is at the end, past the return. */
  function markerIn(t: Timeline, m: TimelineMarker | undefined): number {
    if (!m) return t.entries.length + 1;
    let offset: number | undefined;
    try {
      offset = getCursorPosition(doc(), ["content"], m.cursor);
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
  /**
   * Puts the marker before entry `position` of `t`, a timeline of `a`, the document's current source:
   * before the return at `entries.length`, on the return or else on main's closing brace.
   */
  const setMarkerIn = (t: Timeline, a: Analysis, position: number) => {
    const entry = t.entries[position];
    const end = t.returned?.start ?? (a.main ? a.main.body.end - 1 : undefined);
    if (entry) ui.setMarker({ cursor: getCursor(doc(), ["content"], entry.span.start, "after"), next: entry.kind === "feature" ? entry.name : "" });
    else if (position === t.entries.length && end !== undefined) ui.setMarker({ cursor: getCursor(doc(), ["content"], end, "after"), next: RETURN });
    else ui.setMarker(undefined);
  };
  const setMarker = (position: number) => {
    const a = analysis();
    if (!syntaxError() && a) setMarkerIn(tl(), a, position);
  };

  const [notice, setNotice] = createSignal<string>();
  const [hovered, setHoveredIndex] = createSignal<number>();
  /** The version of the node hovered in the lanes, if it is a node and not the entry. */
  const [hoveredNode, setHoveredNode] = createSignal<string>();
  const setHovered = (index: number | undefined, version?: string) => {
    setHoveredIndex(index);
    setHoveredNode(index === undefined ? undefined : version);
  };
  const [dragging, setDragging] = createSignal<number>();
  /** Whether a body or sketch field is picked: hovering then shows what would be picked, nothing else (research/15, "Availability"). */
  const pickingVersion = () => {
    const kind = pickTarget()?.kind;
    return kind === "body" || kind === "sketch" || kind === "version";
  };
  /** The version of entry `index`, if it has exactly one. */
  const versionAt = (index: number): string | undefined => {
    const versions = [...(lanes()?.versions.values() ?? [])].filter((v) => v.entry === index);
    return versions.length === 1 ? versions[0]!.name : undefined;
  };
  const focused = () => {
    const d = dragging() ?? (pickingVersion() ? undefined : hovered());
    return d ?? selectedIndex();
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
  // The documents the code imports (research/21, "The documents list"), from the last valid code, as the timeline is.
  const documents = createMemo<ModelDocument[]>(() => {
    const a = analysis();
    if (!a || !lastGood) return [];
    const statements = documentStatements(lastGood.source, a.program);
    const t = tl();
    return [...new Set(statements.map((s) => s.id))].map((id) => {
      const own = statements.filter((s) => s.id === id);
      return { id, statements: own, users: usersOf(a, t, own) };
    });
  });
  const [hoveredDocument, setHoveredDocument] = createSignal<string>();
  const focusedDocument = () => {
    const s = selection();
    return hoveredDocument() ?? (s?.kind === "document" ? s.id : undefined);
  };
  const hoveredFeatures = createMemo(
    () => {
      if (pickingVersion()) return [];
      const index = dragging() ?? hovered();
      if (index !== undefined) return ownersOf(tl().entries[index]);
      // A hovered document: what the features that use it made.
      const users = documents().find((d) => d.id === hoveredDocument())?.users.entries;
      return users ? users.flatMap((i) => ownersOf(tl().entries[i])) : codeFeatures();
    },
    [],
    { equals: sameNames },
  );
  const [viewHover, setViewHover] = createSignal<string[]>([], { equals: sameNames });
  const crossHovered = createMemo(() => {
    const names = new Set([...viewHover(), ...codeFeatures()]);
    const users = documents().find((d) => d.id === focusedDocument())?.users.entries ?? [];
    return new Set([...users, ...tl().entries.flatMap((e, i) => (ownersOf(e).some((n) => names.has(n)) ? [i] : []))]);
  });
  /** Whether the code under the pointer or at the cursor is the return. */
  const codeOnReturn = createMemo(() => {
    const offset = codeLast() === "hover" ? (codeHover() ?? codeCursor()) : (codeCursor() ?? codeHover());
    const span = tl().returned;
    return offset !== undefined && !!span && !syntaxError() && span.start <= offset && offset <= span.end;
  });

  const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));
  const highlightedLanes = createMemo(
    () => {
      const l = lanes();
      const out = new Set<number>();
      if (!l) return out;
      const lane = hoveredLane();
      if (lane) return new Set([lane.lane]);
      const index = dragging() ?? hovered();
      const node = hoveredNode();
      if (node !== undefined && l.laneOf.has(node)) return new Set([l.laneOf.get(node)!]);
      // While a version is picked, the hover is quiet: only what the pointer is on in the timeline.
      const entries = new Set([...(index === undefined ? [] : [index]), ...(pickingVersion() ? [] : crossHovered())]);
      for (const v of l.versions.values()) if (entries.has(v.entry)) out.add(l.laneOf.get(v.name)!);
      for (const link of l.links) {
        if (link.kind === "merge" && entries.has(link.to.entry)) out.add(link.from.lane);
        if (link.kind === "output" && entries.has(link.from.entry)) out.add(link.to.lane);
      }
      if (resultHovered() || (!pickingVersion() && codeOnReturn())) l.lanes.forEach((lane, i) => lane.returned && out.add(i));
      return out;
    },
    new Set<number>(),
    { equals: sameSet },
  );
  const lineage = createMemo(() => {
    const hover = hoveredLane();
    const l = lanes();
    if (!hover || !l) return undefined;
    const primary = l.versions.get(hover.version)?.entry;
    const entries = new Set<number>();
    // While a version is picked, only what a click would pick.
    if (!pickingVersion()) {
      for (const v of l.lanes[hover.lane]?.versions ?? []) entries.add(v.entry);
      for (const link of l.links) if (link.kind === "merge" && link.from.lane === hover.lane) entries.add(link.to.entry);
    }
    return { primary, entries };
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
    const result = await model.engine.check(changed, model.params(), await model.imports(changed));
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
    const text = doc().content;
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
      if (doc().content !== text) return "The model changed meanwhile; try again.";
    }
    apply(handle, r.edits);
    return undefined;
  };

  const renameEntry = async (index: number, from: string, to: string) => {
    // A body named by its key in the return keeps its name.
    const keyed = [...(lanes()?.keys.values() ?? [])].includes(from);
    const why = await refactorEntry(index, (_, a, fresh, i) => rename(a, fresh, i, from, to), `Renaming ${from} to ${to}`);
    // What this user shows or hides goes with the name.
    if (!why) ui.renameVisibility({ ...(keyed ? {} : { [`body:${from}`]: `body:${to}` }), [`version:${from}`]: `version:${to}` });
    return why;
  };
  const renameOutputKey = async (from: string, to: string) => {
    const f = fresh();
    if (!f) return "The code doesn't parse.";
    const r = renameOutput(f.a, from, to);
    if ("error" in r) return `Renaming ${from} to ${to} doesn't work: ${r.error}.`;
    apply(handle, r.edits);
    ui.renameVisibility({ [`body:${from}`]: `body:${to}` });
    return undefined;
  };
  const renameBody = (name: string, output: string | undefined, to: string) => {
    if (output !== undefined) return renameOutputKey(output, to);
    const index = lanes()?.versions.get(name)?.entry;
    return index === undefined ? Promise.resolve(`${name} isn't a variable of the model.`) : renameEntry(index, name, to);
  };
  const outputs = createMemo(() => {
    const a = analysis();
    const returned = a && !syntaxError() ? returnedOutputs(a) : undefined;
    if (!returned) return [];
    const keys = outputKeys(returned.outputs);
    return returned.outputs.map((o, i) => ({ key: keys[i]!, name: o.name }));
  });
  const wrap = (index: number) => refactorEntry(index, wrapInBody, `Wrapping ${labelOf(tl().entries[index])} in body()`, true);
  const unwrap = (index: number) => refactorEntry(index, unwrapBody, `Unwrapping ${labelOf(tl().entries[index])}`);
  const remove = async (index: number) => {
    const entry = tl().entries[index];
    // Selected, it closes once it is gone; a deletion that is refused leaves its dialog open, with why.
    const selected = selectedIndex() === index ? selection() : undefined;
    const why = await refactorEntry(
      index,
      (text, a, fresh, i) => {
        const e = fresh.entries[i]!;
        return e.kind === "feature" ? { edits: deleteFeature(text, a, e) } : deleteScript(text, a, fresh, i);
      },
      `Deleting ${labelOf(entry)}`,
    );
    if (!why && selected && selection() === selected) select(undefined, "timeline");
    return why;
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
      const text = doc().content;
      const { analysis: a } = tryAnalyze(text);
      if (!a) return "The code doesn't parse.";
      const fresh = timeline(text, a, []);
      const edits = moveEntry(text, a, fresh, freshIndex(fresh, index), freshIndex(fresh, position));
      const target = tl().entries[position];
      const why = await breaks(`Moving ${labelOf(entry)} ${target ? `before ${labelOf(target)}` : "to the end"}`, text, edits);
      if (why) return why;
    }
    const text = doc().content;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return "The code doesn't parse.";
    const fresh = timeline(text, a, []);
    const from = freshIndex(fresh, index);
    const to = freshIndex(fresh, position);
    if (from < 0 || to < 0) return "The timeline changed meanwhile.";
    if (!canMove(graph(a, fresh), from, to)) return blocked(index, position) ?? "The timeline changed meanwhile.";
    apply(handle, moveEntry(text, a, fresh, from, to));
    const after = tryAnalyze(doc().content).analysis;
    if (after) setMarkerIn(timeline(doc().content, after, []), after, markerGap);
    return undefined;
  };

  return {
    source,
    analysis,
    timeline: tl,
    syntaxError,
    selection,
    select,
    isSelected,
    selectedIndex,
    shared,
    entryOf,
    open,
    pickTarget,
    setPickTarget,
    editOpen,
    insert,
    deleteOpen,
    pick,
    boundBody,
    pickVersion,
    pickable,
    pickingVersion,
    pickedVersions: () => {
      const target = pickTarget();
      if (!target || !pickingVersion()) return [];
      if (target.param === RETURN) return [...(lanes()?.returned ?? [])];
      const value = open()?.call.props?.find((p) => p.key === target.param)?.node;
      return value?.type === "Identifier" ? [value.name] : value?.type === "ArrayExpression" ? value.elements.flatMap((e) => (e?.type === "Identifier" ? [e.name] : [])) : [];
    },
    versionAt,
    pickingAt: () => {
      const index = tl().entries.findIndex((e) => e === open());
      return pickTarget() && index >= 0 ? index : undefined;
    },
    lanes,
    hoveredLane,
    setHoveredLane,
    resultHovered,
    setResultHovered,
    highlightedLanes,
    lineage,
    returnEditable: () => !syntaxError() && !!analysis() && returnEditable(analysis()!),
    outputs,
    renameOutput: renameOutputKey,
    renameBody,
    setOutput,
    chainMode: openChainMode,
    setChainMode: setOpenChainMode,
    graph: g,
    marker,
    markerOf: (m: TimelineMarker | undefined) => (syntaxError() ? tl().entries.length + 1 : markerIn(tl(), m)),
    setMarker,
    hovered: () => dragging() ?? hovered(),
    setHovered,
    hoveredVersion: () => {
      const index = hovered();
      return index === undefined ? undefined : (hoveredNode() ?? versionAt(index));
    },
    setDragging,
    dragging,
    focused,
    related,
    setCodeHover,
    setCodeCursor,
    hoveredFeatures,
    setViewHover,
    crossHovered,
    returnCrossHovered: codeOnReturn,
    documents,
    hoveredDocument,
    setHoveredDocument,
    focusedDocument,
    documentsOf: (index) => documents().flatMap((d) => (d.users.entries.includes(index) ? [d.id] : [])),
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
