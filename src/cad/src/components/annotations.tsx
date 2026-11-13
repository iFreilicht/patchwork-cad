import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import { addAnnotation, anchorLabel, annotations as annotationsOf, featureGone, placementOf, removeAnnotation, setAnnotationAnchor, setAnnotationDoc, setAnnotationTool, setAnnotationView } from "../model/annotations.ts";
import { newId } from "../model/views.ts";
import { ownersOf, type Entry } from "../model/timeline.ts";
import type { Annotation, CadAnchor, CadModelDoc } from "../types.ts";
import type { Model } from "./createModel.ts";
import type { DocumentInfo } from "./documentInfo.ts";
import { Icon } from "./icons.tsx";
import { docOf } from "./imports.ts";
import { createLocated } from "./locate.ts";
import type { Entity, Highlight, Pin } from "./Viewer.tsx";

/** The key of an annotation's pin, and the prefix that tells it from a comment pin. */
export const ANNOTATION_PIN = "annotation:";

/** An annotation, with where it shows now. */
export interface PlacedAnnotation {
  annotation: Annotation;
  /** The faces or edges its pin is on; none for one on the model, or one whose place isn't shown, e.g. while rolled back. */
  at: { body: string; kind: "face" | "edge"; indices: number[] } | undefined;
  /** Its feature, face or edge is gone from the whole model (research/13, "Deleted targets", as comments). */
  detached: boolean;
}

/** The open annotation, shown in Patchwork's embed frame next to its pin. */
export interface AnnotationPopover {
  id: string;
  at: { x: number; y: number };
  above: boolean;
}

/** A model's annotations and their edits, in its document. */
export interface AnnotationStore {
  list: Accessor<Annotation[]>;
  /** Adds an annotation of `doc`, pinned to `anchor`, shown with `tool`, and returns its id. */
  add(doc: AutomergeUrl, anchor: CadAnchor | undefined, tool?: string): string;
  remove(id: string): void;
  setDoc(id: string, doc: AutomergeUrl): void;
  setAnchor(id: string, anchor: CadAnchor | undefined): void;
  setTool(id: string, tool: string | undefined): void;
  setView(id: string, view: string | undefined): void;
}

/** Where a 3D view shows a model's annotations, and the one open there. */
export interface AnnotationPlaces {
  placed: Accessor<PlacedAnnotation[]>;
  pins: Accessor<Pin[]>;
  /** The faces or edges of the given annotations, e.g. the selected one's. */
  highlight(ids: readonly string[]): Highlight[];
  /** Opens an annotation next to a point on the screen, and goes to its view. */
  open(id: string, at: { x: number; y: number }, above?: boolean): void;
  close(): void;
  popover: Accessor<AnnotationPopover | undefined>;
  /** The anchor of a face or edge, as a comment's: the feature that made it, its statement, and its reference as data and as code. */
  anchorOf(entity: Entity, ref: RefData, name: string): CadAnchor;
  /** The anchor of a feature, by its timeline entry. */
  featureAnchor(entry: Entry): CadAnchor | undefined;
}

export type Annotations = AnnotationStore & AnnotationPlaces;

/** The annotations of a model, following its document (research/21-embedding.md, "Annotation"). */
export function createAnnotationStore(handle: DocHandle<CadModelDoc>, onRemove?: (id: string) => void): AnnotationStore {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));
  // Edits of the code mustn't look like a change of the annotations.
  const list = createMemo(() => annotationsOf(doc()), [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const change = (fn: (d: CadModelDoc) => void) => handle.change(fn);
  return {
    list,
    add(url, anchor, tool) {
      const id = newId();
      change((d) => addAnnotation(d, { id, doc: url, ...(anchor ? { anchor } : {}), ...(tool ? { tool } : {}) }));
      return id;
    },
    remove(id) {
      onRemove?.(id);
      change((d) => removeAnnotation(d, id));
    },
    setDoc: (id, url) => change((d) => setAnnotationDoc(d, id, url)),
    setAnchor: (id, anchor) => change((d) => setAnnotationAnchor(d, id, anchor)),
    setTool: (id, tool) => change((d) => setAnnotationTool(d, id, tool)),
    setView: (id, view) => change((d) => setAnnotationView(d, id, view)),
  };
}

/**
 * The annotations of a model (research/21-embedding.md, "Annotation"), for a 3D view: a pin on each
 * one's face or edge, which the worker resolves against the shown bodies as it does a comment's, or
 * on the faces its feature made; those without a pin, on the model as a whole, whose place isn't
 * shown or is gone, are listed at the bottom right of the view (`AnnotationList`).
 */
export function placeAnnotations(options: {
  store: AnnotationStore;
  model: Model;
  shown: Accessor<MeshedShape[]>;
  entries: Accessor<Entry[]>;
  source: Accessor<string>;
  info: (url: string) => DocumentInfo;
  /** The view shows the whole model, not rolled back, so a face it doesn't find is gone. */
  complete: Accessor<boolean>;
  /** Goes to a named view by its id, or Home's. */
  goToView: (id: string) => void;
  /** The selected annotation, whose pin is marked. */
  selected?: Accessor<string | undefined>;
}): Annotations {
  const { store } = options;
  const list = store.list;

  const onEntities = createMemo(() => list().flatMap((a) => (a.anchor?.entity ? [{ key: a.id, ref: a.anchor.entity }] : [])));
  const located = createLocated(options.model, options.shown, onEntities);

  const placed = createMemo((): PlacedAnnotation[] =>
    list().map((annotation) => {
      const placement = placementOf(annotation);
      if (placement === "model") return { annotation, at: undefined, detached: false };
      if (placement === "feature") {
        const gone = featureGone(annotation, options.entries());
        // On the first face the feature made in the shown bodies, not a ghost of it past the marker.
        // On the faces the feature made in the shown bodies; a feature whose faces later ones removed, or one past the marker, has none.
        const name = annotation.anchor!.feature!;
        const shape = gone ? undefined : options.shown().find((s) => s.features?.[name]?.faces.length);
        return { annotation, at: shape && { body: shape.body ?? shape.name, kind: "face", indices: shape.features![name]!.faces }, detached: gone };
      }
      const found = located().find((l) => l.item.key === annotation.id)?.found.find((p) => p.indices.length);
      const kind = annotation.anchor!.entity!.kind === "edge" ? "edge" : "face";
      return { annotation, at: found && { body: found.body, kind, indices: found.indices }, detached: !found && options.complete() && options.shown().length > 0 };
    }),
  );

  const [popover, setPopover] = createSignal<AnnotationPopover>();
  const titleOf = (a: Annotation) => options.info(docOf(a.doc) ?? a.doc).title;
  const pins = (): Pin[] =>
    placed().flatMap(({ annotation: a, at }) => {
      if (!at) return [];
      const info = options.info(docOf(a.doc) ?? a.doc);
      return [{ key: `${ANNOTATION_PIN}${a.id}`, ...at, label: `${titleOf(a)} on ${anchorLabel(a)}`, icon: info.icon, focused: options.selected?.() === a.id || popover()?.id === a.id, ...(info.status === "unavailable" ? { state: "unavailable" } : {}) }];
    });

  return {
    ...store,
    remove(id) {
      if (popover()?.id === id) setPopover(undefined);
      store.remove(id);
    },
    placed,
    pins,
    highlight: (ids) => placed().flatMap(({ annotation, at }) => (at && ids.includes(annotation.id) ? [{ ...at, style: "accent" as const }] : [])),
    open(id, at, above = false) {
      setPopover({ id, at, above });
      const view = list().find((a) => a.id === id)?.view;
      if (view) options.goToView(view);
    },
    close: () => setPopover(undefined),
    popover,
    anchorOf(entity, ref, name) {
      // As a comment on a face is anchored: to the first feature in the timeline that owns it, the one that created it (research/13).
      const shape = options.shown().find((s) => s.body === entity.body);
      const names = Object.entries(shape?.features ?? {}).flatMap(([n, owned]) => ((entity.kind === "face" ? owned.faces : owned.edges).includes(entity.index) ? [n] : []));
      const entry = options.entries().find((e) => ownersOf(e).some((n) => names.includes(n)));
      const feature = entry?.kind === "feature" ? entry.name : undefined;
      return { ...(feature ? { feature } : {}), ...(entry ? { statement: options.source().slice(entry.span.start, entry.span.end) } : {}), entity: ref, entityName: name };
    },
    featureAnchor: (entry) => (entry.kind === "feature" ? { feature: entry.name, statement: options.source().slice(entry.span.start, entry.span.end) } : undefined),
  };
}

/**
 * The annotations without a pin, at the bottom right of a 3D view: those on the model as a whole,
 * those whose place isn't shown, and those whose feature, face or edge is gone, marked so; each
 * opens its document.
 */
export function AnnotationList(props: { annotations: Annotations; info: (url: string) => DocumentInfo }) {
  const unpinned = () => props.annotations.placed().filter((p) => !p.at);
  return (
    <Show when={unpinned().length}>
      <div class="cad-model__annotations" role="list" aria-label="Annotations">
        <For each={unpinned()}>
          {(p) => {
            const info = () => props.info(docOf(p.annotation.doc) ?? p.annotation.doc);
            const label = () =>
              p.detached
                ? `${info().title}: ${p.annotation.anchor?.entity ? (p.annotation.anchor.entity.kind === "edge" ? "edge" : "face") : "feature"} ${anchorLabel(p.annotation)} not found`
                : placementOf(p.annotation) === "model"
                  ? info().title
                  : `${info().title} on ${anchorLabel(p.annotation)}`;
            return (
              <button
                role="listitem"
                class="cad-model__annotation"
                data-annotation={p.annotation.id}
                data-detached={p.detached ? "true" : undefined}
                data-state={info().status === "unavailable" ? "unavailable" : undefined}
                title={label()}
                aria-label={label()}
                onClick={(event) => {
                  const r = event.currentTarget.getBoundingClientRect();
                  props.annotations.open(p.annotation.id, { x: r.right, y: r.top }, true);
                }}
              >
                <Icon name={info().icon} size={12} />
                <Show when={p.detached}>
                  <Icon name="TriangleAlert" size={10} />
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/**
 * An annotation's document in Patchwork's embed frame (`<patchwork-view tool-id="embed">`, research/21,
 * "Annotation"), with its title, tool picker and open button, next to a point in `wrap`'s coordinates.
 * The tool picked there is kept in the annotation. It closes on a click outside or Escape; a press
 * outside that becomes a drag keeps it, as the comments' popover does.
 */
export function AnnotationPopover(props: { annotations: Annotations; popover: AnnotationPopover; wrap: HTMLElement; actions?: { label: string; run: () => void }[] }) {
  let el!: HTMLDivElement;
  const annotation = () => props.annotations.list().find((a) => a.id === props.popover.id);
  /** Where it opens, and the view's box, followed every frame while it hangs from a pin. */
  const [place, setPlace] = createSignal({ at: props.popover.at, box: props.wrap.getBoundingClientRect() });
  const view = document.createElement("patchwork-view");
  view.className = "cad-model__annotation-view";
  // Inline, as Patchwork's markdown embeds do: the frame fills its height, and a stylesheet's height on the element isn't reliably applied.
  view.style.display = "block";
  view.style.height = "min(320px, 50vh)";
  view.style.width = "100%";
  const mount = (a: Annotation) => {
    view.setAttribute("doc-url", a.doc);
    view.setAttribute("tool-id", "embed");
    if (a.tool) view.setAttribute("embed-tool-id", a.tool);
    else view.removeAttribute("embed-tool-id");
  };
  // Mounted once: the frame keeps its own tool once one is picked, and a new document gets a new popover.
  const first = annotation();
  if (first) mount(first);
  const onTool = (event: Event) => {
    // Not the hosts around this editor, e.g. a markdown document it is embedded in.
    event.stopPropagation();
    const tool = (event as CustomEvent<{ toolId?: string }>).detail?.toolId;
    if (tool) props.annotations.setTool(props.popover.id, tool);
  };
  let pressedOutside = false;
  const press = (event: PointerEvent) => (pressedOutside = !el.contains(event.target as Node));
  const outside = (event: MouseEvent) => pressedOutside && !el.contains(event.target as Node) && props.annotations.close();
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.annotations.close();
  };
  // Opened at a pin, it follows the pin as the camera moves, e.g. to the annotation's view.
  let frame = 0;
  const follow = () => {
    const pin = props.wrap.querySelector<HTMLElement>(`.cad-model__pin[data-key="${CSS.escape(ANNOTATION_PIN + props.popover.id)}"]`);
    if (pin && !pin.hidden) {
      const r = pin.getBoundingClientRect();
      const box = props.wrap.getBoundingClientRect();
      const p = place();
      if (r.left !== p.at.x || r.bottom !== p.at.y || box.left !== p.box.left || box.top !== p.box.top) setPlace({ at: { x: r.left, y: r.bottom }, box });
    }
    frame = requestAnimationFrame(follow);
  };
  if (!props.popover.above) frame = requestAnimationFrame(follow);
  onMount(() => {
    el.addEventListener("patchwork:embed-tool-changed", onTool);
    setTimeout(() => {
      document.addEventListener("pointerdown", press, true);
      document.addEventListener("click", outside, true);
      document.addEventListener("keydown", escape, true);
    });
  });
  onCleanup(() => {
    cancelAnimationFrame(frame);
    el.removeEventListener("patchwork:embed-tool-changed", onTool);
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", escape, true);
  });
  // Opened from the right edge of the view, it extends to the left.
  const left = () => Math.max(0, Math.min(place().at.x - place().box.left, place().box.width - 380));
  return (
    <div
      ref={el}
      class="cad-model__annotation-popover"
      role="dialog"
      aria-label={`Annotation on ${annotation() ? anchorLabel(annotation()!) : "the model"}`}
      data-annotation={props.popover.id}
      style={{ left: `${left()}px`, ...(props.popover.above ? { bottom: `${place().box.bottom - place().at.y}px` } : { top: `${place().at.y - place().box.top}px` }) }}
    >
      {view}
      <Show when={props.actions?.length}>
        <div class="cad-model__annotation-actions">
          <For each={props.actions}>
            {(action) => (
              <button class="cad-model__comment-new" onClick={action.run}>
                {action.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
