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
import { apply, appendElement, deleteFeature, elements, ensureImports, freshName, insertFeature, lastOf, removeElement, returnedVariables, setProp, usedFunctions, type Edit } from "../../model/splice.ts";
import { timeline, type FeatureEntry, type Timeline } from "../../model/timeline.ts";
import type { CadModelDoc } from "../../types.ts";
import type { Model } from "../createModel.ts";
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
  /** Edits the open feature's call; `edit` gets the call as it is in the current source. */
  editOpen(edit: (call: FeatureCall, analysis: Analysis, source: string) => Edit[]): void;
  /** Adds a feature with default parameters and opens it. */
  insert(type: FeatureType): void;
  deleteOpen(): void;
  /** Fills the pick target with the picked entity's reference. */
  pick(entity: Entity): Promise<void>;
  /** Variables of features before the open one that produce a body or a sketch. */
  variablesBefore(kind: "body" | "sketch"): string[];
}

function tryAnalyze(source: string): { analysis?: Analysis; error?: string } {
  try {
    return { analysis: analyze(source) };
  } catch (error) {
    return { error: String((error as Error).message) };
  }
}

/** Default code of a new feature; `body` is the body it works on, `sketch` the last sketch. */
const DEFAULTS: Record<FeatureType, (d: { sketch: string; body: string }) => string> = {
  sketch: () => `sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) })`,
  extrude: ({ sketch }) => `extrude({ sketch: ${sketch}, distance: 10 })`,
  fillet: ({ body }) => `fillet({ body: ${body}, edges: [], radius: 1 })`,
  chamfer: ({ body }) => `chamfer({ body: ${body}, edges: [], distance: 1 })`,
};

export function createEditor(handle: DocHandle<CadModelDoc>, model: Model): Editor {
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
    if (c) apply(handle, edit(c.call, c.analysis, c.source));
  };

  const insert = (type: FeatureType) => {
    const text = doc().source;
    const { analysis: a } = tryAnalyze(text);
    if (!a) return;
    const name = freshName(text, type);
    const tl = timeline(text, a, []);
    // A new fillet or chamfer works on the visible result, which may come from a Custom Script.
    const returned = returnedVariables(a);
    const body = (returned.length === 1 ? returned[0] : undefined) ?? lastOf(tl, "body") ?? "undefined";
    const code = DEFAULTS[type]({ sketch: lastOf(tl, "sketch") ?? "undefined", body });
    const consumes = type === "fillet" || type === "chamfer" ? body : undefined;
    apply(handle, insertFeature(text, a, name, code, { body: type !== "sketch", ...(consumes ? { consumes } : {}) }));
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
    const code = await model.engine.pick(entity.body, entity.kind, entity.index);
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

  return { source, analysis, timeline: tl, syntaxError, open, openFeature, pickTarget, setPickTarget, editOpen, insert, deleteOpen, pick, variablesBefore };
}

export const schemaOf = (type: FeatureType) => schemas[type];
