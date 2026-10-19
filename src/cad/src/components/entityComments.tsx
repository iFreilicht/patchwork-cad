import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import type { Span } from "../model/analyze.ts";
import { isDetached, reanchorTarget } from "../model/comments.ts";
import { ownersOf, type Entry } from "../model/timeline.ts";
import type { CommentStore } from "./comments.ts";
import type { Model } from "./createModel.ts";
import { createLocated } from "./locate.ts";
import type { Entity, Highlight, Pin, ViewerProps } from "./Viewer.tsx";

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

/** The open popover of comments on a face or edge. */
export interface EntityPopover {
  threads: string[];
  create?: (() => AutomergeUrl | undefined) | undefined;
  createNow: boolean;
  label: string;
  at: { x: number; y: number };
  caption?: (url: AutomergeUrl) => string | undefined;
  actions?: (url: AutomergeUrl) => { label: string; run: () => void }[];
  /** Opens above `at`, e.g. from a button at the bottom. */
  above?: boolean;
}

/** The button that lists threads whose target is gone, at the bottom left of a 3D view. */
export function DetachedButton(props: { count: number; onOpen: (at: { x: number; y: number }) => void }) {
  return (
    <button
      class="cad-model__detached"
      title="Comments whose code, feature, face or edge is gone"
      onClick={(event) => {
        const r = event.currentTarget.getBoundingClientRect();
        props.onOpen({ x: r.left, y: r.top });
      }}
    >
      Detached comments ({props.count})
    </button>
  );
}

/** A shortened statement for a caption. */
const shorten = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/**
 * Comments on faces and edges in a 3D view (research/13-collaboration.md, "Comments"). A thread on
 * one is anchored to the statement of the feature that made it, which Patchwork's Comments panel
 * lists, and keeps the face's or edge's reference, which the worker resolves against the shown
 * bodies for a pin, so that the pin follows the face through rebuilds and rollbacks.
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
  pins: Accessor<Pin[]>;
  onPin: NonNullable<ViewerProps["onPin"]>;
  /** The faces and edges of focused threads. */
  highlight: Accessor<Highlight[]>;
  selectionAction: Accessor<ViewerProps["selectionAction"]>;
  popover: Accessor<EntityPopover | undefined>;
  close: () => void;
  /** Threads whose code was deleted, or whose face or edge is gone. */
  detached: Accessor<string[]>;
  openDetached: (at: { x: number; y: number }) => void;
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
  const groupOf = (key: string) => groups().find((g) => g.key === key);
  const isFocused = (key: string) => !!groupOf(key)?.ids.some((id) => comments.focused().has(id));

  const pins = (): Pin[] =>
    comments.enabled()
      ? located().flatMap(({ item, found }) => {
          const part = found.find((p) => p.indices.length);
          const group = groupOf(item.key);
          return part && group ? [{ key: item.key, body: part.body, kind: item.ref.kind, indices: part.indices, label: String(group.ids.length), focused: isFocused(item.key) }] : [];
        })
      : [];
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

  const [popover, setPopover] = createSignal<EntityPopover>();
  const startThread = (range: Span, ref: RefData, name: string | undefined, feature: string | undefined) =>
    comments.create(range, { ...(feature ? { feature } : {}), statement: options.source().slice(range.start, range.end), entity: ref, ...(name ? { entityName: name } : {}) });

  const onPin = (key: string, at: { x: number; y: number }) => {
    const group = groupOf(key);
    const range = group?.range;
    if (!group) return;
    if (range) comments.select(range);
    setPopover({
      threads: group.ids,
      create: () => (range ? startThread(range, group.ref, group.name, comments.threads().find((t) => group.ids.includes(t.id))?.anchor?.feature) : undefined),
      createNow: false,
      label: `Comments on ${group.name ?? "this face"}`,
      at,
    });
  };

  const selectionAction = (): ViewerProps["selectionAction"] => {
    const selected = options.selected();
    if (!comments.enabled() || !selected) return undefined;
    const existing = groupOf(refKey(selected.ref));
    return {
      label: existing ? `Comments (${existing.ids.length})` : "Comment",
      run: (at) => {
        if (existing) return onPin(existing.key, at);
        const owner = ownerStatement(selected.entity);
        if (!owner) return;
        comments.select(owner.range);
        setPopover({ threads: [], create: () => startThread(owner.range, selected.ref, selected.name, owner.feature), createNow: true, label: `Comments on ${selected.name}`, at });
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
  const detached = createMemo(() => comments.threads().flatMap((t) => ((isDetached(t) && !reanchorTarget(t, options.entries())) || missing().has(t.id) ? [t.id] : [])));
  const caption = (url: AutomergeUrl) => {
    const t = comments.threads().find((x) => comments.urlOf(x.id) === url);
    if (!t) return undefined;
    const statement = t.anchor?.statement ? `: ${shorten(t.anchor.statement)}` : "";
    if (missing().has(t.id) || (t.anchor?.entity && isDetached(t))) return `${t.anchor?.entity?.kind === "edge" ? "Edge" : "Face"} not found${t.anchor?.entityName ? `: ${t.anchor.entityName}` : ""}`;
    return t.anchor?.feature ? `Feature ${t.anchor.feature} deleted${statement}` : `Code deleted${statement}`;
  };
  /** Moves a thread on a face or edge that is gone to the selected one, as Onshape lets one re-tag a comment. */
  const actions = (url: AutomergeUrl) => {
    const t = comments.threads().find((x) => comments.urlOf(x.id) === url);
    const selected = options.selected();
    if (!t?.anchor?.entity || !selected) return [];
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
  const openDetached = (at: { x: number; y: number }) => setPopover({ threads: detached(), createNow: false, label: "Detached comments", at, caption, actions, above: true });

  // Opening a face's threads made its statement the focus selection, which highlights the face; closing them ends that.
  const close = () => {
    setPopover(undefined);
    comments.select(undefined);
  };

  return { pins, onPin, highlight, selectionAction, popover, close, detached, openDetached };
}
