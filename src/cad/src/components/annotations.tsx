import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import { addAnnotation, annotations as annotationsOf, featureGone, placementOf, removeAnnotation, setAnnotationAnchor, setAnnotationDoc, setAnnotationTool, setAnnotationView } from "../model/annotations.ts";
import { newId } from "../model/views.ts";
import { ownersOf, type Entry } from "../model/timeline.ts";
import type { Annotation, CadAnchor, CadModelDoc } from "../types.ts";
import type { Model } from "./createModel.ts";
import { createLocated } from "./locate.ts";
import type { Entity, Highlight } from "./Viewer.tsx";

/** An annotation, with where it shows now. */
export interface PlacedAnnotation {
  annotation: Annotation;
  /** The faces or edges its pin is on; none for one on the model, or one whose place isn't shown, e.g. while rolled back. */
  at: { body: string; kind: "face" | "edge"; indices: number[] } | undefined;
  /** Its feature, face or edge is gone from the whole model (research/13, "Deleted targets", as comments). */
  detached: boolean;
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

/** Where a 3D view shows a model's annotations. */
export interface AnnotationPlaces {
  placed: Accessor<PlacedAnnotation[]>;
  /** The faces or edges of the given annotations, e.g. the selected one's. */
  highlight(ids: readonly string[]): Highlight[];
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
 * Where the annotations of a model (research/21-embedding.md, "Annotation") are in a 3D view: each
 * one's face or edge, which the worker resolves against the shown bodies as it does a comment's, or
 * the faces its feature made; none for one on the model as a whole, or whose place isn't shown or is
 * gone. Their pins are `createPins`'.
 */
export function placeAnnotations(options: {
  store: AnnotationStore;
  model: Model;
  shown: Accessor<MeshedShape[]>;
  entries: Accessor<Entry[]>;
  source: Accessor<string>;
  /** The view shows the whole model, not rolled back, so a face it doesn't find is gone. */
  complete: Accessor<boolean>;
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

  return {
    ...store,
    placed,
    highlight: (ids) => placed().flatMap(({ annotation, at }) => (at && ids.includes(annotation.id) ? [{ ...at, style: "accent" as const }] : [])),
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
 * An annotation's document in Patchwork's embed frame (`<patchwork-view tool-id="embed">`, research/21,
 * "Annotation"), with its title, tool picker and open button, shown with its tool. A tool picked in
 * the frame is kept in the annotation, and goes no further, e.g. to a markdown document this editor is
 * embedded in.
 */
export function annotationView(annotation: Annotation, store: AnnotationStore): HTMLElement {
  const view = document.createElement("patchwork-view");
  view.className = "cad-model__annotation-view";
  // Inline, as Patchwork's markdown embeds do: the frame fills its height, and a stylesheet's height on the element isn't reliably applied.
  view.style.display = "block";
  view.style.height = "min(320px, 50vh)";
  view.style.width = "100%";
  view.setAttribute("doc-url", annotation.doc);
  view.setAttribute("tool-id", "embed");
  if (annotation.tool) view.setAttribute("embed-tool-id", annotation.tool);
  view.addEventListener("patchwork:embed-tool-changed", (event) => {
    event.stopPropagation();
    const tool = (event as CustomEvent<{ toolId?: string }>).detail?.toolId;
    if (tool) store.setTool(annotation.id, tool);
  });
  return view;
}
