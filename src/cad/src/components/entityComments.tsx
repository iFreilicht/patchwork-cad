import { createEffect, createMemo, type Accessor } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import type { Span } from "../model/analyze.ts";
import { isDetached, reanchorTarget } from "../model/comments.ts";
import { ownersOf, type Entry } from "../model/timeline.ts";
import type { CommentStore } from "./comments.ts";
import type { Model } from "./createModel.ts";
import { createLocated } from "./locate.ts";
import type { Entity, Highlight } from "./Viewer.tsx";

/** A reference as a string to compare by: Automerge may give an object's keys in another order than the worker. */
const refKey = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(refKey).join()}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${refKey((value as Record<string, unknown>)[k])}`)
          .join()}}`
      : JSON.stringify(value);

/** A shortened statement for a caption. */
const shorten = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** A face or edge with comment threads, and where it is in the shown bodies. */
export interface CommentPlace {
  /** Its reference as a key (`refKey`). */
  key: string;
  ref: RefData;
  ids: string[];
  range: Span | undefined;
  name: string | undefined;
  /** Where the worker found it; undefined while it isn't shown. */
  at: { body: string; kind: "face" | "edge"; indices: number[] } | undefined;
}

/**
 * Comments on faces and edges in a 3D view (research/13-collaboration.md, "Comments"). A thread on
 * one is anchored to the statement of the feature that made it, which Patchwork's Comments panel
 * lists, and keeps the face's or edge's reference, which the worker resolves against the shown
 * bodies, so that its pin (`createPins`) follows the face through rebuilds and rollbacks.
 */
export function createEntityComments(options: {
  comments: CommentStore;
  model: Model;
  shown: Accessor<MeshedShape[]>;
  entries: Accessor<Entry[]>;
  source: Accessor<string>;
  /** The selected face or edge, with its reference and code once the worker named it. */
  selected: Accessor<{ entity: Entity; ref: RefData; name: string } | undefined>;
  /** The timeline is that of the current source, e.g. not the last valid one while the code doesn't parse. */
  current: Accessor<boolean>;
  /** The view shows the whole model, not rolled back, so a face it doesn't find is gone. */
  complete: Accessor<boolean>;
}): {
  /** The faces and edges with threads; none without Patchwork's comments. */
  places: Accessor<CommentPlace[]>;
  /** Starts a thread on a place, as its pin's New comment does. */
  create(place: CommentPlace): AutomergeUrl | undefined;
  /** Starts a thread on a face or edge without one, e.g. one that only annotations are pinned to; the worker names it first. */
  createAt(entity: Entity): Promise<AutomergeUrl | undefined>;
  /** Makes a place's statement Patchwork's focus selection, which highlights its face while its threads are open. */
  focus(place: CommentPlace | undefined): void;
  /** The faces and edges of focused threads. */
  highlight: Accessor<Highlight[]>;
  /** The selected face or edge: its place if it has threads, and how to start one on it. */
  selection: Accessor<{ entity: Entity; name: string; place: CommentPlace | undefined; create: () => AutomergeUrl | undefined } | undefined>;
  /** Threads whose code was deleted, or whose face or edge is gone. */
  detached: Accessor<string[]>;
  /** What a detached thread was about, and moving one on a face that is gone to the selected one. */
  caption: (url: AutomergeUrl) => string | undefined;
  actions: (url: AutomergeUrl) => { label: string; run: () => void }[];
} {
  const { comments } = options;
  /** Threads on faces and edges, by their reference. */
  const groups = createMemo(() => {
    const byRef = new Map<string, { key: string; ref: RefData; ids: string[]; range: Span | undefined; name: string | undefined }>();
    for (const t of comments.threads()) {
      const ref = t.anchor?.entity;
      if (!ref) continue;
      const key = refKey(ref);
      const group = byRef.get(key) ?? { key, ref, ids: [], range: t.range, name: t.anchor?.entityName };
      group.ids.push(t.id);
      group.range ??= t.range;
      byRef.set(key, group);
    }
    return [...byRef.values()];
  });
  const located = createLocated(options.model, options.shown, () => groups().map((g) => ({ key: g.key, ref: g.ref })));
  const places = createMemo((): CommentPlace[] => {
    if (!comments.enabled()) return [];
    return groups().map((g) => {
      const part = located().find((l) => l.item.key === g.key)?.found.find((p) => p.indices.length);
      return { ...g, at: part && { body: part.body, kind: g.ref.kind === "edge" ? "edge" : "face", indices: part.indices } };
    });
  });
  const groupOf = (key: string) => groups().find((g) => g.key === key);
  const isFocused = (key: string) => !!groupOf(key)?.ids.some((id) => comments.focused().has(id));
  const highlight = (): Highlight[] => located().flatMap(({ item, found }) => (isFocused(item.key) ? found.map((p) => ({ body: p.body, kind: item.ref.kind, indices: p.indices, style: "accent" as const })) : []));

  /**
   * The statement of the feature that made a face or edge: the first in the timeline of the
   * features that own it (research/12), i.e. the one that created it, not those that split it.
   */
  const ownerStatement = (entity: Entity): { range: Span; feature: string | undefined } | undefined => {
    const shape = options.shown().find((s) => s.body === entity.body);
    const names = Object.entries(shape?.features ?? {}).flatMap(([name, owned]) => ((entity.kind === "face" ? owned.faces : owned.edges).includes(entity.index) ? [name] : []));
    const entries = options.entries();
    const index = entries.findIndex((e) => ownersOf(e).some((n) => names.includes(n)));
    const entry = entries[index];
    return entry && { range: { ...entry.span }, feature: entry.kind === "feature" ? entry.name : undefined };
  };

  const startThread = (range: Span, ref: RefData, name: string | undefined, feature: string | undefined) =>
    comments.create(range, { ...(feature ? { feature } : {}), statement: options.source().slice(range.start, range.end), entity: ref, ...(name ? { entityName: name } : {}) });

  const create = (place: CommentPlace) => (place.range ? startThread(place.range, place.ref, place.name, comments.threads().find((t) => place.ids.includes(t.id))?.anchor?.feature) : undefined);

  const selection = () => {
    const selected = options.selected();
    if (!comments.enabled() || !selected) return undefined;
    const place = places().find((p) => p.key === refKey(selected.ref));
    return {
      entity: selected.entity,
      name: selected.name,
      place,
      create: () => {
        if (place) return create(place);
        const owner = ownerStatement(selected.entity);
        if (!owner) return undefined;
        comments.select(owner.range);
        return startThread(owner.range, selected.ref, selected.name, owner.feature);
      },
    };
  };

  // A feature thread whose statement was deleted goes back to it when a feature of that name is
  // there again, e.g. after an undo, which inserts the text anew (research/13, "Anchors under edits").
  createEffect(() => {
    if (!options.current()) return;
    const entries = options.entries();
    for (const t of comments.threads()) {
      const target = reanchorTarget(t, entries);
      if (target) comments.reanchor(t.id, target);
    }
  });

  /** Entity threads whose face or edge the whole model doesn't have, by id. */
  const missing = createMemo(() => {
    if (!options.complete() || !options.shown().length) return new Set<string>();
    return new Set(located().flatMap(({ item, found }) => (found.some((p) => p.indices.length) ? [] : (groupOf(item.key)?.ids ?? []))));
  });
  const detached = createMemo(() => (comments.enabled() ? comments.threads().flatMap((t) => ((isDetached(t) && !reanchorTarget(t, options.entries())) || missing().has(t.id) ? [t.id] : [])) : []));
  const caption = (url: AutomergeUrl) => {
    const t = comments.threads().find((x) => comments.urlOf(x.id) === url);
    if (!t || !detached().includes(t.id)) return undefined;
    const statement = t.anchor?.statement ? `: ${shorten(t.anchor.statement)}` : "";
    if (missing().has(t.id) || (t.anchor?.entity && isDetached(t))) return `${t.anchor?.entity?.kind === "edge" ? "Edge" : "Face"} not found${t.anchor?.entityName ? `: ${t.anchor.entityName}` : ""}`;
    return t.anchor?.feature ? `Feature ${t.anchor.feature} deleted${statement}` : `Code deleted${statement}`;
  };
  /** Moves a thread on a face or edge that is gone to the selected one, as Onshape lets one re-tag a comment. */
  const actions = (url: AutomergeUrl) => {
    const t = comments.threads().find((x) => comments.urlOf(x.id) === url);
    const selected = options.selected();
    if (!t?.anchor?.entity || !selected || !detached().includes(t.id)) return [];
    return [
      {
        label: `Attach to ${selected.name}`,
        run: () => {
          const owner = ownerStatement(selected.entity);
          if (!owner) return;
          comments.retag(t.id, owner.range, { ...(owner.feature ? { feature: owner.feature } : {}), statement: options.source().slice(owner.range.start, owner.range.end), entity: selected.ref, entityName: selected.name });
        },
      },
    ];
  };

  const createAt = async (entity: Entity) => {
    if (entity.kind !== "face" && entity.kind !== "edge") return undefined;
    const { code, ref } = await options.model.engine.pick(entity.body, entity.kind, entity.index).catch(() => ({ code: "", ref: undefined }));
    const owner = ownerStatement(entity);
    if (!ref || !owner) return undefined;
    comments.select(owner.range);
    return startThread(owner.range, ref, code || undefined, owner.feature);
  };

  return { places, create, createAt, focus: (place) => comments.select(place?.range), highlight, selection, detached, caption, actions };
}
