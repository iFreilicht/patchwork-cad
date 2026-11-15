import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { bindUndo } from "@patchwork-cad/undo";
import type { MeshedShape, ShownSketch } from "../../kernel/protocol.ts";
import type { Span } from "../../model/analyze.ts";
import { ownersOf, type Entry, type FeatureEntry } from "../../model/timeline.ts";
import type { CadModelDoc, CameraState, NamedView } from "../../types.ts";
import { CodeEditor, type RelatedSpan } from "../CodeEditor.tsx";
import { createModel, faceRefs, modelAttributes } from "../createModel.ts";
import { StatusBar } from "../StatusBar.tsx";
import { Viewer, type Entity, type Highlight, type ShownCanvas, type ViewerApi } from "../Viewer.tsx";
import { createEntityName } from "../entityName.ts";
import { CodeDialog, FeatureDialog } from "./FeatureDialog.tsx";
import { createEditor, type Selectable } from "./state.ts";
import { Timeline } from "./Timeline.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { createUiState } from "../uiState.ts";
import { createPeerHighlights, joinPresence, peerMarkers } from "../presence.ts";
import type { TimelinePeer } from "./Timeline.tsx";
import { createEmbed } from "../embed.ts";
import { createNamedViews } from "../namedViews.ts";
import { createComments } from "../comments.ts";
import { createEntityComments } from "../entityComments.tsx";
import { createPins } from "../pins.tsx";
import { createFeatureHighlights } from "../featureHighlights.ts";
import { createBodies } from "./bodies.ts";
import { Browser, ResultDialog, ViewDialog, viewItems, type BrowserPeer, type ViewsSection } from "./Browser.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { createConfigurations } from "../configurations.ts";
import { createParams } from "./parameters.ts";
import { ParamsDialog } from "./ParamsDialog.tsx";
import { createDocumentInfo } from "../documentInfo.ts";
import { annotationRowId, canvasRowId, createDocuments, type DocumentRow } from "./documents.ts";
import { ANCHOR_PICK, DocumentDialog, InsertDialog } from "./DocumentDialog.tsx";
import { createInserts, type PendingInsert } from "./inserts.ts";
import { UNDO_IGNORE } from "../../model/locks.ts";
import { getRegistry, type ToolDescription } from "@inkandswitch/patchwork-plugins";
import { createAnnotationStore, placeAnnotations } from "../annotations.tsx";
import { HOME } from "../../model/views.ts";
import { createCanvasImages, createCanvasStore, onFace, placeCanvases, placeNewCanvas } from "../canvases.ts";
import { canvasCorners, centredAt, storedPlacement } from "../../model/canvases.ts";
import { CANVAS_PICK, createCalibration } from "./CanvasFields.tsx";

const EDITOR_TOOL_ID = "cad-model";

/** The source span of a feature's parameter value, or an empty span. */
const spanOf = (entry: FeatureEntry, key: string): [number, number] => {
  const p = entry.call.props?.find((x) => x.key === key);
  return p ? [p.value.start, p.value.end] : [0, 0];
};

/**
 * The Fusion-like editor (tool `cad-model`, the default): toolbar, 3D view, timeline and feature
 * dialogs on one kernel worker; the shared code editor opens next to it on demand.
 */
export function WysiwygEditor(props: { handle: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const ui = createUiState(props.element, props.handle.url);
  // The parameters this user shows the model with: a configuration and values they try (research/17).
  const [code, setCode] = createSignal(props.handle.doc()?.content ?? "");
  const onCode = () => setCode(props.handle.doc()?.content ?? "");
  props.handle.on("change", onCode);
  onCleanup(() => props.handle.off("change", onCode));
  const params = createParams(props.handle, code, createConfigurations(props.handle), ui);
  // The editor alone writes locks of the documents the model follows (research/21, "Following and pinning").
  const model = createModel(props.handle, params.shown, { writeLocks: true });
  const editor = createEditor(props.handle, model, ui);
  const documentInfo = createDocumentInfo();
  // Documents shown at places on the model (research/21, "Annotation"); where they show is placed with the view, below.
  const annotationStore = createAnnotationStore(props.handle);
  // Images on planes, to trace or compare (research/21, "Canvas"); where they are is placed with the view, below.
  const canvasStore = createCanvasStore(props.handle);
  const canvasImage = createCanvasImages(documentInfo, () => canvasStore.list().map((c) => c.image));
  const documents = createDocuments({
    handle: props.handle,
    editor,
    model,
    configurations: params.configurations.list,
    annotations: annotationStore,
    canvases: canvasStore,
    canvasImage,
    onShow: (id) => showAnnotation(id),
    info: documentInfo,
    element: props.element,
  });
  // Documents dropped, pasted or inserted (research/21, "Dropping, pasting, inserting").
  const inserts = createInserts({
    handle: props.handle,
    editor,
    model,
    documents,
    params,
    annotations: annotationStore,
    anchorOf: (...a) => annotations.anchorOf(...a),
    faceAt: (x, y) => viewer?.faceAt(x, y),
    pointAt: (x, y) => viewer?.pointAt(x, y),
    canvases: canvasStore,
    placeCanvas: (face, anchor, point) => placeNewCanvas(shown(), face, anchor, point),
    info: documentInfo,
    element: props.element,
  });
  const bodies = createBodies(editor, ui);
  const resultHovered = editor.resultHovered;
  const presence = joinPresence(props.element, props.handle, "editor");
  const comments = createComments(props.element, props.handle);
  // Comments, Patchwork's metadata (`@…`) and the locks aren't undone (research/16-undo-redo.md).
  const undo = bindUndo(props.element, props.handle, { ignore: UNDO_IGNORE });
  onCleanup(undo.unbind);
  const codeOpen = ui.codeOpen;
  const setCodeOpen = ui.setCodeOpen;

  // The camera: the one this user last left, a named view gone to, and the one shown now (research/18-named-views.md).
  let viewer: ViewerApi | undefined;
  /** A named view gone to, as a new object each time, which the view applies even if it showed it before. */
  const [goTo, setGoTo] = createSignal<CameraState>();
  /** The camera as the view last reported it, or as this editor moved it to a named view. */
  const [camera, setCamera] = createSignal<CameraState>();
  const saveCamera = (view: CameraState) => {
    setCamera(view);
    ui.setView(EDITOR_TOOL_ID, view);
  };
  /** The Home view or a configuration is hovered in the browser: the ViewCube's Home button or the parameters entry show it. */
  const [homeHovered, setHomeHovered] = createSignal(false);
  const [configurationHovered, setConfigurationHovered] = createSignal(false);
  const views: ViewsSection = {
    views: createNamedViews(props.handle),
    camera() {
      // Read for making or updating a view, which is then where the camera is.
      const now = viewer?.camera();
      if (now) setCamera(now);
      return now;
    },
    current: () => camera() ?? ui.view(EDITOR_TOOL_ID),
    goTo(view: NamedView) {
      setGoTo({ ...view.camera });
      saveCamera(view.camera);
    },
    goHome: () => viewer?.home(),
    homeCamera: () => viewer?.homeCamera(),
    setHomeHovered,
    embed: (view) => createEmbed(props.handle, { view }),
  };

  // The selection (research/19-selection.md): a selected view or configuration that is deleted, e.g. by a collaborator, is no longer selected.
  const selectedView = () => {
    const s = editor.selection();
    return s?.kind === "view" ? viewItems(views.views).find((v) => v.id === s.id) : undefined;
  };
  const selectedDocument = () => {
    const s = editor.selection();
    return s?.kind === "document" ? documents.rows().find((r) => r.id === s.id) : undefined;
  };
  createEffect(() => {
    const s = editor.selection();
    if ((s?.kind === "view" && !selectedView()) || (s?.kind === "configuration" && s.id && !params.configurations.list().some((c) => c.id === s.id))) editor.select(undefined, "dialog");
    // A document no longer imported, e.g. removed by a collaborator; not while the code doesn't parse, when the list is its last valid state,
    // nor before the list has followed an edit of the code.
    if (s?.kind === "document" && !selectedDocument() && !editor.syntaxError() && editor.source() === (props.handle.doc()?.content ?? "")) editor.select(undefined, "dialog");
  });
  // A configuration selected is the one the model is shown with, also when that changes in the dialog or by "+" in the browser.
  createEffect(
    on(
      () => params.selected()?.id ?? "",
      (id) => {
        const s = untrack(editor.selection);
        if (s?.kind === "configuration" && s.id !== id) editor.select({ kind: "configuration", id }, "dialog");
      },
    ),
  );
  /**
   * What the open dialog shows, kept after it closes: a field's blur, which Chrome sends when the
   * dialog is removed, reads it then, and Match's own accessor throws after the Match has switched.
   */
  const dialogEntry = createMemo<FeatureEntry | undefined>((previous) => editor.open() ?? previous);
  /** The selected Custom Script or body(), which has no form, only its code's dialog. */
  const codeEntry = () => {
    const index = editor.selectedIndex();
    const entry = index === undefined || editor.open() ? undefined : editor.timeline().entries[index];
    return entry && index !== undefined ? { entry, index } : undefined;
  };
  const dialogCode = createMemo<ReturnType<typeof codeEntry>>((previous) => codeEntry() ?? previous);
  const dialogView = createMemo<ReturnType<typeof selectedView>>((previous) => selectedView() ?? previous);
  const dialogDocument = createMemo<DocumentRow | undefined>((previous) => selectedDocument() ?? previous);
  const dialogInsert = createMemo<PendingInsert | undefined>((previous) => inserts.pending() ?? previous);
  /** The documents an entry uses, with their titles, for "Edit ‹document›". */
  const documentsOf = (index: number) => editor.documentsOf(index).flatMap((id) => {
    const row = documents.rows().find((r) => r.id === id);
    return row ? [{ id, title: documents.title(row) }] : [];
  });
  /** Which table of the Parameters dialog was used last: the code pane scrolls to its code. */
  const [paramsSection, setParamsSection] = createSignal<"params" | "derived">("params");
  const [codeFocus, setCodeFocus] = createSignal<Span>();
  const [pickError, setPickError] = createSignal<string>();
  const pick = (entity: Parameters<typeof editor.pick>[0]) => {
    setPickError(undefined);
    // A face picked for a canvas puts it on the face, centred on it (research/21, "Canvas").
    const canvas = selectedDocument()?.canvas;
    if (editor.pickTarget()?.param === CANVAS_PICK && canvas) {
      editor.setPickTarget(undefined);
      const shape = shown().find((s) => s.body === entity.body);
      if (entity.kind !== "face" || !shape) return;
      void model.engine.pick(entity.body, "face", entity.index).then(
        ({ code, ref }) => {
          const placed = ref && code ? onFace(shape, entity.index, annotations.anchorOf(entity, ref, code)) : undefined;
          // Its image centred there, as far as it is drawn.
          const image = placedCanvases().find((c) => c.canvas.id === canvas.id)?.image;
          if (placed) canvasStore.update(canvas.id, { plane: placed.plane, ...(image ? storedPlacement(centredAt(image.placement, image.box, placed.center)) : {}) });
          else setPickError(ref && code ? "the face isn't planar" : "it has no reference");
        },
        (error: unknown) => setPickError(String((error as Error)?.message ?? error)),
      );
      return;
    }
    // A face or edge picked for an annotation pins it there (research/21, "Annotation").
    const target = editor.pickTarget()?.param;
    const annotation = selectedDocument()?.annotation;
    if ((target === ANCHOR_PICK.face || target === ANCHOR_PICK.edge) && annotation) {
      editor.setPickTarget(undefined);
      if (entity.kind !== "face" && entity.kind !== "edge") return;
      model.engine.pick(entity.body, entity.kind, entity.index).then(
        ({ code, ref }) => (ref && code ? annotations.setAnchor(annotation.id, annotations.anchorOf(entity, ref, code)) : setPickError("it has no reference")),
        (error: unknown) => setPickError(String((error as Error)?.message ?? error)),
      );
      return;
    }
    editor.pick(entity).catch((error: unknown) => setPickError(String((error as Error)?.message ?? error)));
  };

  /** The names of the features the last build ran in timeline entries. */
  const ran = (entry: Entry) => (entry.kind === "feature" ? (entry.trace ? [entry.trace.name] : []) : entry.features.map((f) => f.name));
  /**
   * The state at the timeline marker, if it isn't at the end: the bodies visible before the first
   * feature that runs after it, or else after the last one before it, or else none.
   */
  const atMarker = (): { feature: string; after: boolean } | "nothing" | undefined => {
    const entries = editor.timeline().entries;
    const marker = editor.marker();
    // Past the return, the view shows what main returns.
    if (marker > entries.length) return undefined;
    const next = entries.slice(marker).flatMap(ran)[0];
    if (next) return { feature: next, after: false };
    const previous = entries.slice(0, marker).flatMap(ran).at(-1);
    return previous ? { feature: previous, after: true } : "nothing";
  };
  // While a reference is picked, the view rolls back to the bodies the feature works on, as in
  // Fusion's timeline; the feature's resolved references are highlighted there. Otherwise it shows
  // the model at the timeline marker.
  const rollbackTo = () => {
    const entry = editor.open();
    return editor.pickTarget() && entry?.trace ? { feature: entry.trace.name, after: false } : atMarker();
  };
  const rollbackKey = () => JSON.stringify(rollbackTo() ?? null);
  const [rolledBackTo, setRolledBack] = createSignal<{ shapes: MeshedShape[]; sketches: ShownSketch[] }>();
  createEffect(() => {
    const to = rollbackTo();
    const key = rollbackKey();
    model.last();
    if (!to || to === "nothing") {
      setRolledBack(to ? { shapes: [], sketches: [] } : undefined);
      return;
    }
    model.engine.rollback(to.feature, to.after).then(
      (state) => rollbackKey() === key && setRolledBack(state),
      () => setRolledBack(undefined),
    );
  });
  const rolledBack = () => rolledBackTo()?.shapes;
  /**
   * What the view would show: what main returns, or what exists where it is rolled back to, which
   * is what the browser lists there (research/15, "Visibility"). The build drops a body once a
   * feature consumes it; one that exists there all the same, a returned version a later feature
   * continues or what the open feature branches from, comes from the last build, meshed on demand.
   */
  const built = () => {
    const shapes = rolledBack();
    if (!shapes) return model.shapes() ?? [];
    const consumed = consumedHere().flatMap((name) => meshes().get(name) ?? []);
    return consumed.length ? [...shapes, ...consumed] : shapes;
  };

  // Bodies that don't show, e.g. hidden or consumed ones, as the browser or a pick hovers them,
  // meshed by the worker once per build (research/15, "Visibility").
  const [meshes, setMeshes] = createSignal(new Map<string, MeshedShape | null>());
  createEffect(on(model.last, () => setMeshes(new Map())));
  /** The version of the lineage hovered in the browser or the lanes, which a click there opens or picks. */
  const lineageVersion = () => editor.hoveredLane()?.version;
  /** While a body or sketch is picked, the version a click on the hovered timeline entry or node would pick. */
  const hoveredVersion = () => (editor.pickingVersion() ? editor.hoveredVersion() : undefined);
  const kindOf = (version: string | undefined) => (version ? editor.lanes()?.versions.get(version)?.kind : undefined);
  /** While rolled back, the bodies that exist there but that the build had consumed by then. */
  const consumedHere = createMemo(
    () => {
      const shapes = rolledBack();
      return shapes ? bodies.rows().flatMap((r) => (r.kind === "body" && !shapes.some((s) => s.body === r.version) ? [r.version] : [])) : [];
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) },
  );
  const wantedMeshes = createMemo(() => [...consumedHere(), ...[lineageVersion(), hoveredVersion()].filter((n): n is string => !!n && kindOf(n) === "body")]);
  createEffect(() => {
    const cache = meshes();
    for (const name of wantedMeshes()) {
      if (cache.has(name) || rolledBack()?.some((s) => s.body === name) || (!rolledBack() && model.shapes()?.some((s) => s.body === name))) continue;
      cache.set(name, null);
      model.engine.result(name).then(
        (shape) => meshes() === cache && setMeshes(new Map(cache).set(name, shape ?? null)),
        () => undefined,
      );
    }
  });
  const meshOf = (name: string) => built().find((s) => s.body === name) ?? meshes().get(name) ?? undefined;
  /** The same shapes stay the same array: a new one would reset the view's selection. */
  const sameShapes = (a: MeshedShape[], b: MeshedShape[]) => a.length === b.length && a.every((s, i) => s === b[i]);
  /** What this user sees: what exists at the marker, without the bodies they hid. */
  const shown = createMemo(() => built().filter((s) => !s.body || bodies.shows(s.body)), [], { equals: sameShapes });
  /** Bodies the view would show but this user hid: collaborators' highlights on them show as ghosts. */
  const hidden = createMemo(() => built().filter((s) => s.body && !bodies.shows(s.body)), [], { equals: sameShapes });
  const shownSketches = () => (rolledBackTo()?.sketches ?? model.sketches()).filter((s) => bodies.shows(s.name));
  /** All faces of a shown body, or of a mesh of it as a ghost. */
  const wholeBody = (name: string, style: Highlight["style"]): Highlight[] => {
    const visible = shown().find((s) => s.body === name);
    const shape = visible ?? meshOf(name);
    if (!shape) return [];
    const indices = [...new Set((shape.faceIndex ?? []).filter((i) => i >= 0))];
    return [{ body: name, kind: "face", indices, style, ...(visible ? {} : { shape, ghost: true }) }];
  };
  /** While a body field or the return is picked, the bodies it holds; while a reference is, what it resolves to. */
  const references = (): Highlight[] => {
    const target = editor.pickTarget();
    if (target?.param === "return") return [...(editor.lanes()?.returned ?? [])].flatMap((n) => wholeBody(n, "accent"));
    const entry = editor.open();
    if (!rolledBack() || !target || !entry) return [];
    if (target.kind === "body" || target.kind === "sketch") {
      const value = entry.call.props?.find((p) => p.key === target.param)?.node;
      const names = value?.type === "Identifier" ? [value.name] : value?.type === "ArrayExpression" ? value.elements.flatMap((e) => (e?.type === "Identifier" ? [e.name] : [])) : [];
      return names.flatMap((n) => wholeBody(n, "accent"));
    }
    return (entry.trace?.refs ?? []).map((d) => ({ body: d.body, kind: d.kind, indices: d.matches, style: "accent" }));
  };
  /** The body hovered in the browser or the lanes, what a pick would take, and what main returns while the return entry is hovered. */
  const bodyHighlights = (): Highlight[] => {
    const lineage = lineageVersion();
    const fromBrowser = lineage && kindOf(lineage) === "body" ? wholeBody(lineage, "hover") : [];
    const pointed = bodyUnderPointer();
    const fromView = pointed && editor.pickingVersion() ? wholeBody(pointed, "hover") : [];
    const version = hoveredVersion();
    const fromTimeline = version && kindOf(version) === "body" ? wholeBody(version, "hover") : [];
    const fromResult = resultHovered() ? [...(editor.lanes()?.returned ?? [])].flatMap((n) => wholeBody(n, "hover")) : [];
    return [...fromBrowser, ...fromView, ...fromTimeline, ...fromResult];
  };
  /** The sketch hovered in the browser or the lanes, or in the timeline while a version is picked, as an overlay. */
  const hoveredSketch = () => {
    const name = [lineageVersion(), hoveredVersion()].find((n) => kindOf(n) === "sketch");
    return name ? model.trace().find((t) => t.name === name)?.outline : undefined;
  };

  /** What the features hovered in the timeline or code made, by their schema's `hover`. */
  const featureHighlights = createFeatureHighlights(model, shown);
  const featureHighlight = (): Highlight[] => featureHighlights(editor.hoveredFeatures(), "hover");

  // Hovering a face or edge marks the features that made it in the timeline and code; the status bar names it, or the selected one.
  const hoverName = createEntityName(model, 100);
  const selectedName = createEntityName(model, 0);
  const [selectedEntity, setSelectedEntity] = createSignal<Entity>();
  const onSelect = (entity: Entity | undefined) => {
    setSelectedEntity(entity);
    selectedName.set(entity);
  };
  const [viewFeatures, setViewFeatures] = createSignal<string[]>([]);
  /** While a body is picked, the body under the pointer, which a click picks as a whole. */
  const [bodyUnderPointer, setBodyUnderPointer] = createSignal<string>();
  const onHover = (entity: Entity | undefined) => {
    hoverName.set(entity);
    setBodyUnderPointer(editor.pickingVersion() ? entity?.body : undefined);
    const shape = entity && shown().find((s) => s.body === entity.body);
    const names = Object.entries(shape?.features ?? {}).flatMap(([name, owned]) => ((entity!.kind === "face" ? owned.faces : owned.edges).includes(entity!.index) ? [name] : []));
    setViewFeatures(names);
  };
  /** The code of the features hovered in the 3D view: their statements, or in a Custom Script the lines that ran them. */
  const viewHoveredCode = (): Span[] => {
    const names = new Set(viewedFeatures());
    if (editor.syntaxError()) return [];
    // The code of the features that use the hovered or selected document (research/21, "The documents list").
    const focused = editor.documents().find((d) => d.id === editor.focusedDocument());
    if (focused) return focused.users.entries.flatMap((i) => (editor.timeline().entries[i] ? [editor.timeline().entries[i]!.span] : []));
    if (names.size === 0) return [];
    const text = editor.source();
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    return editor.timeline().entries.flatMap((e): Span[] => {
      if (e.kind === "feature") return ownersOf(e).some((n) => names.has(n)) ? [e.span] : [];
      return e.features.flatMap((f) => (names.has(f.name) && f.line !== undefined && lineStarts[f.line - 1] !== undefined ? [{ start: lineStarts[f.line - 1]!, end: (lineStarts[f.line] ?? text.length + 1) - 1 }] : []));
    });
  };

  /** The code past the timeline marker, from the start of its first line. */
  const pastMarker = (): Span | undefined => {
    const entries = editor.timeline().entries;
    const first = entries[editor.marker()];
    if (editor.syntaxError()) return undefined;
    // Before the return, the return is rolled back.
    if (!first) return editor.marker() === entries.length ? editor.timeline().returned : undefined;
    return { start: first.span.start, end: editor.timeline().returned?.end ?? entries[entries.length - 1]!.span.end };
  };
  /**
   * The code of the entry whose dependencies are shown, and of its dependencies and dependents; and,
   * as if hovered, but without them, the return's while it is hovered and that of the entry a click
   * on the hovered lineage opens.
   */
  const relatedCode = (): RelatedSpan[] => {
    const index = editor.focused();
    const entries = editor.timeline().entries;
    if (editor.syntaxError()) return [];
    const self = (span: Span | undefined): RelatedSpan[] => (span ? [{ ...span, relation: "self", link: "hard" }] : []);
    const primary = editor.lineage()?.primary;
    const hovered = [...(primary !== undefined && primary !== index ? self(entries[primary]?.span) : []), ...(resultHovered() ? self(editor.timeline().returned) : [])];
    if (index === undefined || !entries[index]) return hovered;
    return [...self(entries[index]!.span), ...[...editor.related().values()].map((r) => ({ ...entries[r.index]!.span, relation: r.relation, link: r.link })), ...hovered];
  };

  /** The open sketch's profile, or the sketch of the open extrude, and the profiles of hovered sketches. */
  const overlays = () => {
    const entry = editor.open();
    const sketchName = entry?.type === "sketch" ? entry.name : entry?.type === "extrude" ? editor.source().slice(...spanOf(entry, "sketch")) : undefined;
    const names = new Set([...(sketchName ? [sketchName] : []), ...editor.hoveredFeatures()]);
    const sketch = hoveredSketch();
    // While the return entry is hovered, the sketches main returns, as its bodies are highlighted.
    if (resultHovered()) for (const n of editor.lanes()?.returned ?? []) if (editor.lanes()?.versions.get(n)?.kind === "sketch") names.add(n);
    return [...model.trace().flatMap((t) => (names.has(t.name) && t.outline ? [{ points: t.outline, closed: true }] : [])), ...(sketch ? [{ points: sketch, closed: true }] : [])];
  };

  // What collaborators see of this view (research/13), and what this view shows of theirs.
  // Hovered and selected faces and edges go out as references once the worker has named them.
  createEffect(() => presence.set({ hover: hoverName.ref() }));
  createEffect(() => presence.set({ selected: selectedName.ref() }));
  createEffect(() => presence.set({ features: editor.hoveredFeatures() }));
  createEffect(() => presence.set({ marker: ui.marker() }));
  createEffect(() => presence.set({ selection: editor.shared() }));
  const peers = presence.peers;
  const peerHighlights = createPeerHighlights(model, shown, peers, hidden);
  const entityComments = createEntityComments({
    comments,
    model,
    shown,
    entries: () => editor.timeline().entries,
    source: editor.source,
    selected: () => {
      const entity = selectedEntity();
      const ref = selectedName.ref();
      const name = selectedName.name();
      return entity && ref && name ? { entity, ref, name } : undefined;
    },
    current: () => !editor.syntaxError(),
    complete: () => !rolledBack(),
  });
  /** Goes to a named view by its id, or Home, as opening an annotation with a view does. */
  const goToView = (id: string) => {
    if (id === HOME) return views.goHome();
    const view = views.views.views().find((v) => v.id === id);
    if (view) views.goTo(view);
  };
  const annotations = placeAnnotations({
    store: annotationStore,
    model,
    shown,
    entries: () => editor.timeline().entries,
    source: editor.source,
    complete: () => !rolledBack(),
  });
  // Comments and annotations, one pin per face or edge and one for the model (research/21, "Annotation").
  const pins = createPins({
    comments,
    entityComments,
    annotations,
    info: documentInfo,
    goToView,
    selected: () => selectedDocument()?.annotation?.id,
    edit: (id) => editor.select({ kind: "document", id: annotationRowId(id) }, "view"),
    hoverAnnotation: (id) => editor.setHoveredDocument(id === undefined ? undefined : annotationRowId(id)),
    // An open pin is the selection, with its dialog (research/19).
    selection: {
      selected: () => {
        const s = editor.selection();
        return s?.kind === "pin" ? s.id : undefined;
      },
      select: (key) => editor.select(key === undefined ? undefined : { kind: "pin", id: key }, "view"),
    },
  });
  // Canvases (research/21, "Canvas"): where each is, whether this user shows it, and Calibrate.
  const placedCanvases = placeCanvases({ list: canvasStore.list, model, shown, complete: () => !rolledBack(), image: canvasImage });
  const canvasVisible = (id: string) => ui.visibility()[`canvas:${id}`] ?? true;
  const setCanvasVisible = (id: string, visible: boolean) => ui.setVisibility(`canvas:${id}`, visible ? undefined : false);
  const calibration = createCalibration({
    canvases: canvasStore,
    placed: placedCanvases,
    selected: () => selectedDocument()?.canvas?.id,
    picking: () => !!editor.pickTarget(),
    stopPicking: () => editor.setPickTarget(undefined),
    setNotice: (notice) => editor.setNotice(notice),
  });
  /** The canvases this user shows, with their images drawn: the selected one is outlined, a hovered row's too. */
  const shownCanvases = createMemo((): ShownCanvas[] =>
    placedCanvases().flatMap(({ canvas, frame, image }) => {
      if (!frame || !image || !canvasVisible(canvas.id)) return [];
      const row = canvasRowId(canvas.id);
      const highlight = editor.isSelected({ kind: "document", id: row }) ? "accent" : editor.hoveredDocument() === row ? "hover" : undefined;
      return [{ id: canvas.id, image: image.image, corners: canvasCorners(image.placement, frame, image.box), opacity: canvas.opacity, through: canvas.through, highlight }];
    }),
  );
  /** Opens an annotation from its row, at the pin that holds it. */
  const showAnnotation = (id: string) => pins.show(id, stage);
  /** The features that made the open pin's face or edge, which are marked as if it were hovered (research/21, "Annotation"). */
  const pinFeatures = () => {
    const at = pins.opened();
    const shape = at && shown().find((s) => s.body === at.body);
    return Object.entries(shape?.features ?? {}).flatMap(([name, owned]) => ((at!.kind === "face" ? owned.faces : owned.edges).some((i) => at!.indices.includes(i)) ? [name] : []));
  };
  /** What the 3D view marks in the timeline and code: the hovered face's or edge's features, and the open pin's. */
  const viewedFeatures = createMemo(() => [...new Set([...viewFeatures(), ...pinFeatures()])], [], { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  createEffect(() => editor.setViewHover(viewedFeatures()));
  const toolName = (id: string) => getRegistry<ToolDescription>("patchwork:tool").get(id)?.name ?? id;
  /** The face a document is dragged over, as a hovered one is. */
  const dropFaceHighlight = (): Highlight[] => {
    const face = inserts.dropFace();
    return face ? [{ body: face.body, kind: "face", indices: [face.index], style: "hover" }] : [];
  };
  let stage!: HTMLDivElement;
  /** Collaborators in the editor, with the timeline entry they selected, if they selected one. */
  const editorPeers = createMemo(() =>
    presence
      .peers()
      .filter((p) => p.state.tool === "editor")
      .map((p) => ({ ...p, entry: editor.entryOf(p.state.selection) })),
  );
  const timelinePeers = (): TimelinePeer[] => {
    const entries = editor.timeline().entries;
    return editorPeers().map((p) => {
      const names = new Set(p.state.features ?? []);
      const marked = new Set(entries.flatMap((e, i) => (i === p.entry || ownersOf(e).some((n) => names.has(n)) ? [i] : [])));
      return { key: p.key, color: p.color, contactUrl: p.contactUrl, marker: editor.markerOf(p.state.marker), entries: marked };
    });
  };
  /** The colour of the first collaborator whose selection is of one of `kinds`. */
  const peerOfKind = (...kinds: string[]) => editorPeers().find((p) => kinds.includes(p.state.selection?.kind ?? ""))?.color;
  const browserPeers = (): BrowserPeer[] =>
    editorPeers().map((p) => {
      const s = p.state.selection;
      return { color: p.color, ...(p.entry !== undefined ? { entry: p.entry } : {}), ...(s?.kind === "view" ? { view: s.id } : {}), ...(s?.kind === "configuration" ? { configuration: s.id } : {}), ...(s?.kind === "document" ? { document: s.id } : {}) };
    });

  /** The code of what is selected as `{ kind, id }`, by this user or a collaborator, if it has code. */
  const codeOf = (kind: string | undefined, entry: number | undefined, section: "params" | "derived" = "params", id?: string): Span | undefined => {
    if (editor.syntaxError()) return undefined;
    const info = params.info();
    if (entry !== undefined) return editor.timeline().entries[entry]?.span;
    if (kind === "return") return editor.timeline().returned;
    if (kind === "document") return editor.documents().find((d) => d.id === id)?.statements[0]?.span;
    if (kind !== "params" && kind !== "configuration") return undefined;
    const derived = info?.derived ?? [];
    if (kind === "params" && section === "derived" && derived.length) return { start: derived[0]!.statement.start, end: derived[derived.length - 1]!.statement.end };
    return info?.defaults?.statement ?? info?.mainStatement;
  };
  const peerItems = () => editorPeers().flatMap((p) => {
    const span = codeOf(p.state.selection?.kind, p.entry, "params", p.state.selection?.id);
    return span ? [{ ...span, color: p.color }] : [];
  });

  /** The items in the code, with where each one's code is, from the start of its first line to the end of its last (research/19-selection.md, "The code pane"). */
  const codeItems = createMemo(() => {
    if (editor.syntaxError()) return [];
    const text = editor.source();
    const info = params.info();
    const items: { item: Selectable; span: Span; section?: "params" | "derived" }[] = editor.timeline().entries.map((e, index) => ({ item: { kind: "entry", index }, span: e.span }));
    const returned = editor.timeline().returned;
    if (returned) items.push({ item: { kind: "return" }, span: returned });
    if (info?.defaults) items.push({ item: { kind: "params" }, span: info.defaults.statement, section: "params" });
    for (const d of info?.derived ?? []) items.push({ item: { kind: "params" }, span: d.statement, section: "derived" });
    // main's head, `export default function main({ … } = defaultParams) {`, takes the parameters.
    if (info?.mainStatement && info.mainBody) items.push({ item: { kind: "params" }, span: { start: info.mainStatement.start, end: info.mainBody.start + 1 }, section: "params" });
    // An import of a document selects the document (research/21, "The documents list").
    for (const d of editor.documents()) for (const statement of d.statements) items.push({ item: { kind: "document", id: d.id }, span: statement.span });
    // Blanks before and after a statement on its lines are part of it: only lines without an item, e.g. blank ones, have none.
    const blank = (from: number, to: number) => /^[ \t]*$/.test(text.slice(from, to));
    return items.map((x) => {
      const lineStart = text.lastIndexOf("\n", x.span.start - 1) + 1;
      const next = text.indexOf("\n", x.span.end);
      const lineEnd = next < 0 ? text.length : next;
      return { ...x, from: blank(lineStart, x.span.start) ? lineStart : x.span.start, to: blank(x.span.end, lineEnd) ? lineEnd : x.span.end };
    });
  });
  /** The selection follows the code pane's cursor while it has focus (research/19-selection.md, "The code pane"). */
  const onCodeCursor = (offset: number | undefined) => {
    editor.setCodeCursor(offset);
    if (offset === undefined || editor.syntaxError()) return;
    const hit = codeItems()
      .filter((x) => x.from <= offset && offset <= x.to)
      .sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))[0];
    if (hit?.section) setParamsSection(hit.section);
    if (hit ? editor.isSelected(hit.item) : !editor.selection()) return;
    editor.select(hit?.item, "code");
  };
  /** Code to scroll to: the selection's, when it is made elsewhere, the code pane opens, or another table of the Parameters dialog is used. */
  const [reveal, setReveal] = createSignal<Span>();
  const revealSelection = () => {
    const span = untrack(() => codeOf(editor.selection()?.kind, editor.selectedIndex(), paramsSection(), editor.selection()?.id));
    if (span) setReveal({ ...span });
  };
  createEffect(on(editor.selection, (s) => s && s.from !== "code" && revealSelection()));
  createEffect(on(codeOpen, (open) => open && revealSelection()));
  createEffect(on(paramsSection, () => editor.selection()?.kind === "params" && revealSelection(), { defer: true }));

  /** Opens the code pane at an entry's code, e.g. a Custom Script's or a body()'s, which have no dialog. */
  const openCode = (span: Span) => {
    setCodeFocus({ ...span });
    setCodeOpen(true);
  };
  /** Opens the code pane at main's parameters, or at its derived values, which are at the start of main, in another place. */
  const editParams = (section: "params" | "derived") => {
    const info = params.info();
    const derived = info?.derived ?? [];
    const first = derived[0];
    const last = derived[derived.length - 1];
    const at = section === "derived" ? (first && last ? { start: first.statement.start, end: last.statement.end } : info?.mainBody) : (info?.defaults?.statement ?? info?.mainStatement);
    if (at) setCodeFocus({ ...at });
    setCodeOpen(true);
  };
  /** What the view shows the model with, if not its defaults. */
  const shownWith = () => {
    const configuration = params.selected()?.name;
    return configuration ? `Shown with configuration "${configuration}"` : undefined;
  };
  /** Opens the code pane at the return. */
  const editReturn = () => {
    const returned = editor.timeline().returned;
    if (returned) setCodeFocus({ ...returned });
    setCodeOpen(true);
  };
  const returnCount = () => (editor.returnEditable() ? (editor.lanes()?.returned.size ?? 0) : undefined);
  const editCode = () => {
    const entry = editor.open();
    if (entry) setCodeFocus({ ...entry.span });
    setCodeOpen(true);
  };

  // Closing (research/19-selection.md, "Closing"): Escape, unless something used it first, and a
  // click elsewhere, in the view or on empty space in the browser or the timeline. Before menus and
  // popovers see the press, which closes them alone. Capturing, so that what is pressed can't stop it.
  /** Whether a press on `target` is elsewhere: on no item or control. The lanes say so themselves. */
  const elsewhere = (target: Element) =>
    target.matches(".cad-model__viewer > canvas") ||
    (!!target.closest(".cad-editor__browser, .cad-editor__timeline-wrap") && !target.closest("button, input, select, textarea, a, li, svg, [draggable], .cad-editor__actions, .cad-editor__marker-drawing"));
  let press: { x: number; y: number } | undefined;
  const onPress = (event: PointerEvent) => {
    const target = event.target as Element;
    const popup = props.element.querySelector(".cad-editor__menu, .cad-model__comments-popover, .cad-model__comment-popover");
    press = event.button === 0 && !popup && props.element.contains(target) && elsewhere(target) ? { x: event.clientX, y: event.clientY } : undefined;
  };
  const onRelease = (event: PointerEvent) => {
    const p = press;
    press = undefined;
    // As the ViewCube's click: a drag orbits or pans, and keeps the dialog. While a field picks, a click picks, and so while Calibrate does.
    if (!p || Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 || editor.pickTarget() || calibration.state()) return;
    editor.select(undefined, "view");
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as Node;
    if (target !== document.body && !props.element.contains(target)) return;
    // A field that picks stops picking first, and so does Calibrate.
    if (editor.pickTarget()) editor.setPickTarget(undefined);
    else if (calibration.state()) calibration.stop();
    else if (editor.selection()) editor.select(undefined, "dialog");
    else return;
    event.preventDefault();
  };
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("pointerup", onRelease, true);
  document.addEventListener("keydown", onEscape);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPress, true);
    document.removeEventListener("pointerup", onRelease, true);
    document.removeEventListener("keydown", onEscape);
  });

  /** A face's context menu: "Edit ‹feature›" for the feature that created it, the base of its name (research/19-selection.md, "The selection"). */
  const [viewMenu, setViewMenu] = createSignal<{ items: MenuItem[]; label: string; x: number; y: number }>();
  const onViewMenu = (entity: Entity | undefined, at: { x: number; y: number }) => {
    if (entity?.kind !== "face" || editor.pickTarget()) return;
    model.engine.pick(entity.body, entity.kind, entity.index).then(
      ({ code }) => {
        const base = /^[A-Za-z_$][\w$]*/.exec(code)?.[0];
        const index = base === undefined ? -1 : editor.timeline().entries.findIndex((e) => ownersOf(e).includes(base));
        const entry = editor.timeline().entries[index];
        if (!entry) return;
        const label = entry.kind === "feature" ? entry.name : `the Custom Script at lines ${entry.lines.join("–")}`;
        setViewMenu({ items: [{ label: `Edit ${label}`, run: () => editor.select({ kind: "entry", index }, "view") }], label: `Actions for ${code}`, ...at });
      },
      () => undefined,
    );
  };

  /** Selects an item from the timeline, or closes it if it is selected. */
  const toggle = (item: Selectable) => editor.select(editor.isSelected(item) ? undefined : item, "timeline");
  /** The selection for tests and styles: its kind, and the entry's index or the item's id. */
  const selectionKey = () => {
    const s = editor.selection();
    if (!s) return "";
    if (s.kind === "feature" || s.kind === "script") return `${s.kind}:${editor.selectedIndex() ?? ""}`;
    return s.kind === "configuration" || s.kind === "view" || s.kind === "document" || s.kind === "pin" ? `${s.kind}:${s.id}` : s.kind === "insert" ? `insert:${inserts.pending()?.url ?? ""}` : s.kind;
  };

  /** Documents held back at their locks, with what their newer version brings (research/21, "Following and pinning"). */
  const heldBack = () =>
    documents.rows().flatMap((r) => (r.held ? [`${documents.title(r)} is held back at the version the model last built with: ${r.held.errors.join("; ")}`] : []));
  /** The documents the code imports, for their titles in the code pane, and the lines of the held-back ones. */
  const codeDocuments = () =>
    documents.rows().flatMap((r) => {
      const state = documents.state(r);
      return r.statements.map((s) => ({ specifier: s.specifier, title: documents.title(r) + (r.path ?? ""), state: state.state, label: state.label }));
    });
  const heldLines = () => documents.rows().flatMap((r) => (r.held ? r.statements.map((s) => s.line) : []));
  const openUrl = (url: string) => props.element.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url }, bubbles: true, composed: true }));
  const openDocument = (specifier: string) => {
    const row = documents.rows().find((r) => r.statements.some((s) => s.specifier === specifier));
    if (row) documents.open(row);
  };

  /** Why a body() failed: it has no dialog to say it (research/11), so the status bar does. */
  const undialogued = () => editor.timeline().entries.flatMap((e) => (e.kind === "feature" && e.type === "body" && e.trace && e.trace.status !== "ok" && e.trace.message ? [`body() ${e.names.join(", ")}: ${e.trace.message}`] : []));

  return (
    <div class="cad-model cad-model--editor" classList={{ "cad-model--with-code": codeOpen(), "cad-model--with-browser": ui.browserOpen() }} {...modelAttributes(model)} data-open={editor.open()?.name ?? ""} data-selection={selectionKey()} data-rolled-back={rolledBack() ? "true" : "false"} data-marker={editor.marker()}>
      <Toolbar editor={editor} codeOpen={codeOpen()} onToggleCode={() => setCodeOpen(!codeOpen())} browserOpen={ui.browserOpen()} onToggleBrowser={() => ui.setBrowserOpen(!ui.browserOpen())} onInsert={() => inserts.begin(undefined, undefined, "toolbar")} />
      <Show when={ui.browserOpen()}>
        <Browser
          editor={editor}
          bodies={bodies}
          views={views}
          params={params}
          documents={documents}
          peers={browserPeers()}
          onHoverConfiguration={setConfigurationHovered}
          embedConfiguration={(configuration) => createEmbed(props.handle, { configuration })}
          dragging={inserts.dragging()}
          canvases={{ placed: placedCanvases, visible: canvasVisible, setVisible: setCanvasVisible }}
        />
      </Show>
      <div class="cad-editor__stage" ref={stage} tabindex="-1" data-drop="insert">
        <Viewer
          shapes={rolledBack() || model.shapes() ? shown() : undefined}
          pick={editor.pickTarget()?.kind === "body" || editor.pickTarget()?.kind === "version" ? "face" : editor.pickTarget()?.kind === "sketch" ? undefined : (editor.pickTarget()?.kind as "face" | "edge" | undefined)}
          onPick={pick}
          hoverHighlight={!editor.pickingVersion()}
          pickable={editor.boundBody() === undefined ? undefined : (body) => body === editor.boundBody()}
          onHover={onHover}
          onSelect={onSelect}
          onContextMenu={onViewMenu}
          onPointer={(pointer) => presence.set({ pointer })}
          highlight={[...peerHighlights(), ...pins.highlight(), ...references(), ...featureHighlight(), ...bodyHighlights(), ...dropFaceHighlight()]}
          pins={pins.pins()}
          onPin={pins.onPin}
          onPinHover={pins.onPinHover}
          peers={peerMarkers(peers())}
          overlays={[...overlays(), ...calibration.overlays()]}
          canvases={shownCanvases()}
          canvasPick={calibration.state()?.id}
          onCanvasPick={calibration.pick}
          onCanvasHover={calibration.hover}
          sketches={shownSketches()}
          view={goTo() ?? ui.view(EDITOR_TOOL_ID)}
          onViewChange={saveCamera}
          onApi={(api) => (viewer = api)}
          home={views.views.home()}
          faceRefs={faceRefs(model)}
          homeHovered={homeHovered()}
        />
        {/* The selected item's dialog (research/19-selection.md): every selected item has one. */}
        <Switch>
          <Match when={editor.open()}>
            <FeatureDialog editor={editor} entry={dialogEntry()!} onEditCode={editCode} promote={params.promote} documents={documentsOf(editor.timeline().entries.indexOf(dialogEntry()!))} />
          </Match>
          <Match when={codeEntry()}>
            <CodeDialog editor={editor} entry={dialogCode()!.entry} index={dialogCode()!.index} onEditCode={() => openCode(dialogCode()!.entry.span)} documents={documentsOf(dialogCode()!.index)} />
          </Match>
          <Match when={editor.isSelected({ kind: "params" })}>
            <ParamsDialog params={params} editor={editor} values={model.paramValues} onClose={() => editor.select(undefined, "dialog")} onEditCode={editParams} onSection={setParamsSection} />
          </Match>
          <Match when={editor.selection()?.kind === "return"}>
            <ResultDialog editor={editor} onClose={() => editor.select(undefined, "dialog")} onEditCode={editReturn} />
          </Match>
          <Match when={selectedView()}>
            <ViewDialog section={views} view={dialogView()!} onClose={() => editor.select(undefined, "dialog")} />
          </Match>
          <Match when={selectedDocument()}>
            <DocumentDialog
              documents={documents}
              row={dialogDocument()!}
              editor={editor}
              annotation={{ annotations, views: viewItems(views.views).map((v) => ({ id: v.id, name: v.name })), toolName, goToView }}
              canvas={{ canvases: canvasStore, placed: placedCanvases, calibration }}
              onClose={() => editor.select(undefined, "dialog")}
            />
          </Match>
          <Match when={editor.selection()?.kind === "pin"}>{pins.dialog()}</Match>
          <Match when={inserts.pending()}>
            <InsertDialog inserts={inserts} pending={dialogInsert()!} editor={editor} onOpen={openUrl} onClose={() => editor.select(undefined, "dialog")} />
          </Match>
        </Switch>
        <Show when={viewMenu()}>{(m) => <Menu items={m().items} label={m().label} at={m()} wrap={stage} down onClose={() => setViewMenu(undefined)} />}</Show>
        <Show when={pickError()}>{(message) => <p class="cad-editor__banner" role="alert">Can't refer to that: {message()}</p>}</Show>
        {pins.view(() => stage)}
        <Show when={editor.syntaxError()}>{(message) => <p class="cad-editor__banner">The code doesn't parse ({message()}); the timeline shows its last valid state.</p>}</Show>
      </div>
      <Show when={codeOpen()}>
        <div class="cad-editor__code" data-drop="import">
          <CodeEditor
            handle={props.handle}
            undo={undo.manager}
            errorLine={model.error()?.line}
            focus={codeFocus()}
            onFocusDone={() => setCodeFocus(undefined)}
            past={pastMarker()}
            related={relatedCode()}
            reveal={reveal()}
            onHover={editor.setCodeHover}
            onCursor={onCodeCursor}
            crossHover={viewHoveredCode()}
            onSelection={(code) => presence.set({ code })}
            peerSelections={presence.peers().flatMap((p) => (p.state.code ? [{ key: p.key, color: p.color, contactUrl: p.contactUrl, ...p.state.code }] : []))}
            peerItems={peerItems()}
            comments={comments}
            documents={codeDocuments()}
            onOpenDocument={openDocument}
            markedLines={heldLines()}
          />
        </div>
      </Show>
      <Timeline
        editor={editor}
        onOpenCode={openCode}
        peers={timelinePeers()}
        documentsOf={documentsOf}
        comments={comments}
        result={{
          get open() {
            return editor.isSelected({ kind: "return" });
          },
          get count() {
            return returnCount();
          },
          get peer() {
            return peerOfKind("return");
          },
          onOpen: () => toggle({ kind: "return" }),
        }}
        parameters={{
          get open() {
            return editor.isSelected({ kind: "params" });
          },
          get peer() {
            return peerOfKind("params", "configuration");
          },
          get count() {
            return (params.info()?.params.length ?? 0) + (params.info()?.derived.length ?? 0);
          },
          get hovered() {
            return configurationHovered();
          },
          onOpen: () => toggle({ kind: "params" }),
        }}
      />
      <StatusBar model={model} notice={editor.notice()} action={inserts.status() ?? calibration.status()} problems={[...undialogued(), ...heldBack(), ...params.problems()]} context={shownWith()} reference={selectedName.name() ? { code: selectedName.name()!, selected: true } : hoverName.name() ? { code: hoverName.name()!, selected: false } : undefined} />
    </div>
  );
}
