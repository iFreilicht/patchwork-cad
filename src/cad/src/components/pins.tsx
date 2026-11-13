import { createEffect, createMemo, createSignal, For, Show, untrack, type Accessor, type JSX } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { anchorLabel, placementOf } from "../model/annotations.ts";
import type { Annotation } from "../types.ts";
import type { Annotations } from "./annotations.tsx";
import type { CommentStore } from "./comments.ts";
import { CommentsPopover } from "./CommentsPopover.tsx";
import type { DocumentInfo } from "./documentInfo.ts";
import type { CommentPlace, createEntityComments } from "./entityComments.tsx";
import { Icon } from "./icons.tsx";
import { docOf } from "./imports.ts";
import type { Highlight, Pin, ViewerProps } from "./Viewer.tsx";

type EntityComments = ReturnType<typeof createEntityComments>;

/** The key of the pin of what is on the model as a whole, or whose place is gone or not shown. */
export const MODEL_PIN = "model";

/** Where a pin is: faces or edges of a shown body. */
export type At = { body: string; kind: "face" | "edge"; indices: number[] };

/** One face or edge, and what is pinned to it. */
interface Place {
  key: string;
  at: At;
  /** Threads on it, by the references that name it: one face may be named several ways. */
  comments: CommentPlace[];
  annotations: string[];
}

/** What a pin holds, as it draws it: its icons, the count if more than one of a kind, its label and state. */
interface Parts {
  icons: string[];
  count: number | undefined;
  label: string;
  state: string | undefined;
}

/** The open pin. */
interface Open {
  /** The pin it is open at, whose threads and annotations it lists: a new one for the first thread on a face or edge. */
  key: string;
  at: { x: number; y: number };
  above: boolean;
  create: (() => AutomergeUrl | undefined | Promise<AutomergeUrl | undefined>) | undefined;
  createNow: boolean;
  /** For the first thread on a face or edge: what it is on. */
  label: string | undefined;
  /** Whether opening it went to its one annotation's view: else each annotation with a view offers to. */
  wentToView: boolean;
}

const placeKey = (at: At) => `${at.body}|${at.kind}|${[...at.indices].sort((a, b) => a - b).join(",")}`;

/**
 * One pin per face or edge for everything pinned there (research/21-embedding.md, "Annotation"):
 * comment threads on it (research/13) and annotations on it, or on a feature, on the feature's first
 * face; and one pin at the bottom left of the 3D view for what is on the model as a whole, whose
 * place is gone, or isn't shown. A pin shows an icon per kind, comments and each kind of document,
 * and how many there are if more than one of a kind. Opening one lists its threads, then its
 * annotations in Patchwork's embed frame; it goes to an annotation's view if it holds just one
 * annotation, which has one. The selected face's or edge's pin is marked; one without a pin gets a
 * pin to comment on it. In the editor an open pin is the selection, shown as a dialog (`dialog`);
 * elsewhere a popover.
 */
export function createPins(options: {
  comments: CommentStore;
  entityComments: EntityComments;
  annotations: Annotations;
  info: (url: string) => DocumentInfo;
  goToView: (id: string) => void;
  /** The selected annotation, whose pin is marked; the editor's. */
  selected?: Accessor<string | undefined>;
  /** Selects an annotation, e.g. to edit it; the editor's. */
  edit?: (id: string) => void;
  /** An annotation in the open pin is hovered or focused, e.g. to mark its row; the editor's. */
  hoverAnnotation?: (id: string | undefined) => void;
  /** The editor's selection, which an open pin is, by its key, with its dialog (research/19). */
  selection?: { selected: Accessor<string | undefined>; select(key: string | undefined): void };
}): {
  pins: Accessor<Pin[]>;
  onPin: NonNullable<ViewerProps["onPin"]>;
  onPinHover: NonNullable<ViewerProps["onPinHover"]>;
  /** The faces and edges of focused threads, of the selected and open annotations, and of the open and the hovered pin. */
  highlight: Accessor<Highlight[]>;
  /** Where the open pin is, e.g. to mark the features that made its face. */
  opened: Accessor<At | undefined>;
  /** Opens the pin that holds an annotation, e.g. for its row's Show. */
  show(annotation: string, wrap: HTMLElement): void;
  /** The model's pin, and elsewhere than in the editor the open popover, in `wrap`. */
  view(wrap: () => HTMLElement): JSX.Element;
  /** The open pin's dialog, in the editor. */
  dialog(): JSX.Element;
} {
  const { comments, entityComments, annotations } = options;
  const annotation = (id: string): Annotation | undefined => annotations.list().find((a) => a.id === id);
  const infoOf = (a: Annotation) => options.info(docOf(a.doc) ?? a.doc);

  const places = createMemo((): Place[] => {
    const byKey = new Map<string, Place>();
    const placeAt = (at: At) => {
      const key = placeKey(at);
      let place = byKey.get(key);
      if (!place) byKey.set(key, (place = { key, at, comments: [], annotations: [] }));
      return place;
    };
    for (const c of entityComments.places()) if (c.at) placeAt(c.at).comments.push(c);
    for (const p of annotations.placed()) {
      if (!p.at) continue;
      // A feature's pin is on its first face, so that it shares a pin with what else is there.
      placeAt(placementOf(p.annotation) === "feature" ? { ...p.at, indices: p.at.indices.slice(0, 1) } : p.at).annotations.push(p.annotation.id);
    }
    return [...byKey.values()];
  });
  const threadsOf = (place: Place) => place.comments.flatMap((c) => c.ids);
  /** The model's pin: detached threads and those on the whole document, and annotations without a place. */
  const onModel = createMemo(() => ({
    threads: comments.enabled() ? [...entityComments.detached(), ...comments.threads().flatMap((t) => (t.document ? [t.id] : []))] : [],
    annotations: annotations.placed().flatMap((p) => (p.at ? [] : [p.annotation.id])),
  }));
  const contents = (key: string) => {
    if (key === MODEL_PIN) return onModel();
    const place = places().find((p) => p.key === key);
    return { threads: place ? threadsOf(place) : [], annotations: place?.annotations ?? [] };
  };

  const parts = (threads: number, ids: readonly string[]): Parts => {
    const icons = threads ? ["MessageSquare"] : [];
    const kinds = new Map<string, number>();
    const titles: string[] = [];
    let state: string | undefined;
    for (const id of ids) {
      const a = annotation(id);
      if (!a) continue;
      const info = infoOf(a);
      if (!kinds.has(info.icon)) icons.push(info.icon);
      kinds.set(info.icon, (kinds.get(info.icon) ?? 0) + 1);
      titles.push(info.title);
      if (info.status === "unavailable") state = "unavailable";
    }
    const many = threads > 1 || [...kinds.values()].some((n) => n > 1);
    const label = [...(threads ? [`${threads} comment${threads > 1 ? "s" : ""}`] : []), ...titles].join(", ");
    return { icons, count: many ? threads + ids.length : undefined, label, state };
  };

  const [open, setOpen] = createSignal<Open>();
  const isFocused = (threads: readonly string[], ids: readonly string[], key: string) => open()?.key === key || threads.some((id) => comments.focused().has(id)) || (!!options.selected?.() && ids.includes(options.selected()!));

  /** The selected face or edge, as comments see it: its place, and how to start a thread on it. */
  const selection = () => entityComments.selection();
  const holds = (at: At, s: NonNullable<ReturnType<typeof selection>>) => at.body === s.entity.body && at.kind === s.entity.kind && at.indices.includes(s.entity.index);
  /** The key of a pin to comment on the selected face or edge, which has none, and where it goes. */
  const newPin = createMemo(() => {
    const s = selection();
    if (!s || places().some((p) => holds(p.at, s))) return undefined;
    const at: At = { body: s.entity.body, kind: s.entity.kind === "edge" ? "edge" : "face", indices: [s.entity.index] };
    return { key: placeKey(at), at, name: s.name };
  });
  const pins = (): Pin[] => {
    const s = selection();
    const placed = places().map((place): Pin => {
      const threads = threadsOf(place);
      return { key: place.key, ...place.at, ...parts(threads.length, place.annotations), threads: threads.length, annotations: place.annotations.length, focused: isFocused(threads, place.annotations, place.key), selected: !!s && holds(place.at, s) };
    });
    const fresh = newPin();
    return fresh ? [...placed, { key: fresh.key, ...fresh.at, icons: ["MessageSquare"], count: undefined, label: `Comment on ${fresh.name}`, threads: 0, annotations: 0, focused: open()?.key === fresh.key, selected: true, new: true }] : placed;
  };

  /**
   * Opens a pin: its threads and annotations, New comment on its threads' face, or on the selected
   * face or edge if it is there, and at once on the selected one without threads, whose pin is new.
   */
  const openAt = (key: string, at: { x: number; y: number }) => {
    const place = places().find((p) => p.key === key);
    const { annotations: ids } = contents(key);
    const views = ids.flatMap((id) => annotation(id)?.view ?? []);
    const wentToView = ids.length === 1 && views.length === 1;
    const thread = place?.comments[0];
    const s = selection();
    const fresh = newPin()?.key === key ? newPin() : undefined;
    const create = thread
      ? () => entityComments.create(thread)
      : s && (fresh || (place && holds(place.at, s)))
        ? s.create
        : place && comments.enabled()
          ? () => entityComments.createAt({ body: place.at.body, kind: place.at.kind, index: place.at.indices[0]! })
          : undefined;
    entityComments.focus(thread);
    setOpen({ key, at, above: key === MODEL_PIN, create, createNow: !!fresh, label: fresh ? `Comments on ${fresh.name}` : undefined, wentToView });
    options.selection?.select(key);
    if (wentToView) options.goToView(views[0]!);
  };

  const close = () => {
    setOpen(undefined);
    entityComments.focus(undefined);
    if (options.selection?.selected() !== undefined) options.selection.select(undefined);
  };
  if (options.selection) {
    const { selected, select } = options.selection;
    // Another selection, or none, closes it; so does its pin's going, e.g. its last thread resolved,
    // but not a new pin's, which a thread started there replaces.
    createEffect(() => {
      const key = selected();
      const o = untrack(open);
      if (o && o.key !== key) {
        setOpen(undefined);
        entityComments.focus(undefined);
      }
      if (key !== undefined && !untrack(open)) select(undefined);
    });
    createEffect(() => {
      const key = selected();
      if (key === undefined || key === MODEL_PIN) return;
      const { threads, annotations: ids } = contents(key);
      if (!threads.length && !ids.length && newPin()?.key !== key) untrack(() => select(undefined));
    });
  }

  const [hovered, setHovered] = createSignal<string>();
  const placeAt = (key: string | undefined) => (key === undefined ? undefined : (places().find((p) => p.key === key)?.at ?? (newPin()?.key === key ? newPin()!.at : undefined)));

  /** What a popover is about, as its label says: "Comments on extrude1.end", "Annotations on …", "Comments and annotations on the model". */
  const labelOf = (o: Open) => {
    if (o.label) return o.label;
    const place = places().find((p) => p.key === o.key);
    const { threads, annotations: ids } = contents(o.key);
    const first = ids.map(annotation).find((a) => a);
    const on = o.key === MODEL_PIN ? "the model" : (place?.comments.find((c) => c.name)?.name ?? (first ? anchorLabel(first) : "this face"));
    return `${threads.length && ids.length ? "Comments and annotations" : ids.length ? "Annotations" : "Comments"} on ${on}`;
  };

  /** Why an annotation on the model's pin isn't on a face: its place is gone, or isn't shown; none for one on the model. */
  const annotationCaption = (id: string) => {
    const p = annotations.placed().find((x) => x.annotation.id === id);
    if (!p || p.at || placementOf(p.annotation) === "model") return undefined;
    const a = p.annotation;
    if (!p.detached) return `On ${anchorLabel(a)}, not shown here`;
    return a.anchor?.entity ? `${a.anchor.entity.kind === "edge" ? "Edge" : "Face"} not found: ${anchorLabel(a)}` : `Feature ${a.anchor?.feature} deleted`;
  };
  const annotationActions = (o: Open) => (id: string) => {
    const a = annotation(id);
    return [...(a?.view && !o.wentToView ? [{ label: "Go to view", run: () => options.goToView(a.view!) }] : []), ...(options.edit ? [{ label: "Edit annotation", run: () => options.edit!(id) }] : [])];
  };

  const highlight = (): Highlight[] => {
    const o = open();
    const ids = [...(options.selected?.() ? [options.selected()!] : []), ...(o ? contents(o.key).annotations : [])];
    const opened = placeAt(o?.key);
    const pointed = hovered() !== o?.key ? placeAt(hovered()) : undefined;
    return [...entityComments.highlight(), ...annotations.highlight(ids), ...(opened ? [{ ...opened, style: "accent" as const }] : []), ...(pointed ? [{ ...pointed, style: "hover" as const }] : [])];
  };

  const show = (id: string, wrap: HTMLElement) => {
    const place = places().find((p) => p.annotations.includes(id));
    const key = place?.key ?? MODEL_PIN;
    const el = wrap.querySelector<HTMLElement>(`.cad-model__pin[data-key="${CSS.escape(key)}"]:not([hidden])`);
    const r = (el ?? wrap).getBoundingClientRect();
    openAt(key, key === MODEL_PIN ? { x: r.left, y: r.top } : { x: r.left, y: r.bottom });
  };

  const view = (wrap: () => HTMLElement) => {
    const model = () => parts(onModel().threads.length, onModel().annotations);
    const detached = () => entityComments.detached().length > 0 || annotations.placed().some((p) => p.detached);
    return (
      <>
        <Show when={onModel().threads.length + onModel().annotations.length > 0}>
          <button
            class="cad-model__pin cad-model__pin--model"
            data-key={MODEL_PIN}
            data-threads={onModel().threads.length}
            data-annotations={onModel().annotations.length}
            data-detached={detached() ? "true" : undefined}
            data-state={model().state}
            data-focused={isFocused(onModel().threads, onModel().annotations, MODEL_PIN) ? "true" : "false"}
            title={model().label}
            aria-label={`On the model: ${model().label}`}
            onClick={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              openAt(MODEL_PIN, { x: r.left, y: r.top });
            }}
          >
            <For each={model().icons}>{(icon) => <Icon name={icon} size={12} />}</For>
            {model().count ?? ""}
            <Show when={detached()}>
              <Icon name="TriangleAlert" size={10} />
            </Show>
          </button>
        </Show>
        <Show when={!options.selection && open()} keyed>
          {(o) => (
            <CommentsPopover
              comments={comments}
              threads={contents(o.key).threads}
              create={o.create}
              createNow={o.createNow}
              caption={entityComments.caption}
              actions={entityComments.actions}
              annotations={{ ids: contents(o.key).annotations, store: annotations, caption: annotationCaption, actions: annotationActions(o), hover: options.hoverAnnotation }}
              follow={o.key === MODEL_PIN ? undefined : o.key}
              label={labelOf(o)}
              at={o.at}
              wrap={wrap()}
              above={o.above}
              onClose={close}
            />
          )}
        </Show>
      </>
    );
  };

  const dialog = () => (
    <Show when={open()} keyed>
      {(o) => (
        <CommentsPopover
          comments={comments}
          threads={contents(o.key).threads}
          create={o.create}
          createNow={o.createNow}
          caption={entityComments.caption}
          actions={entityComments.actions}
          annotations={{ ids: contents(o.key).annotations, store: annotations, caption: annotationCaption, actions: annotationActions(o), hover: options.hoverAnnotation }}
          label={labelOf(o)}
          dialog={{ onClose: close }}
        />
      )}
    </Show>
  );

  return { pins, onPin: (key, at) => openAt(key, at), onPinHover: setHovered, highlight, opened: () => placeAt(open()?.key), show, view, dialog };
}
