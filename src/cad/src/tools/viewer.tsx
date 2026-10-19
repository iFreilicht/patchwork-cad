import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { createModel, modelAttributes } from "../components/createModel.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { createEntityName } from "../components/entityName.ts";
import { createPeerHighlights, joinPresence, peerMarkers } from "../components/presence.ts";
import { createUiState } from "../components/uiState.ts";
import { viewsOf } from "../components/viewDoc.ts";
import { sameCamera, Viewer, type ViewerProps } from "../components/Viewer.tsx";
import type { CadModelDoc, CadModelViewDoc, CameraState } from "../types.ts";
import type { Model } from "../components/createModel.ts";
import { createComments } from "../components/comments.ts";
import { CommentsPopover } from "../components/CommentsPopover.tsx";
import { createEntityComments, DetachedButton } from "../components/entityComments.tsx";
import type { Entity } from "../components/Viewer.tsx";
import { analyze } from "../model/analyze.ts";
import { timeline } from "../model/timeline.ts";
import "../styles.css";

const VIEWER_TOOL_ID = "cad-model-viewer";

/**
 * The model's 3D view alone, read-only: for embedding a model in other documents and as a building
 * block. It also shows view documents (`cad-model-view`), a model with a saved camera.
 */
export default function mount(handle: DocHandle<CadModelDoc | CadModelViewDoc>, element: HTMLElement): () => void {
  return render(() => {
    const doc = handle.doc();
    return doc && "model" in doc ? <ViewDocViewer handle={handle as DocHandle<CadModelViewDoc>} element={element} /> : <ModelViewer handle={handle as DocHandle<CadModelDoc>} element={element} />;
  }, element);
}

/**
 * The viewer's part in collaborators' presence (research/13): its pointer, hovered and selected
 * faces and edges go out, and collaborators' show in 3D. It has no code or timeline to share.
 * Faces and edges are named by the worker only while someone else is there to see them.
 */
function viewerPresence(element: HTMLElement, handle: DocHandle<CadModelDoc>, model: Model): { props: Pick<ViewerProps, "onHover" | "onSelect" | "onPointer" | "highlight" | "peers" | "pins" | "onPin" | "selectionAction">; popover: (wrap: () => HTMLElement) => JSX.Element } {
  const presence = joinPresence(element, handle, "viewer");
  const hover = createEntityName(model, 100);
  const selected = createEntityName(model, 0);
  const comments = createComments(element, handle);
  // Faces and edges are named also when alone if they can be commented on.
  const alone = () => presence.peers().length === 0 && !comments.enabled();
  const [selectedEntity, setSelectedEntity] = createSignal<Entity>();
  const entries = createMemo(() => {
    const source = comments.source();
    return timeline(source, analyze(source), model.trace()).entries;
  });
  const entityComments = createEntityComments({
    comments,
    model,
    shown: () => model.shapes() ?? [],
    entries,
    source: comments.source,
    selected: () => {
      const entity = selectedEntity();
      const ref = selected.ref();
      const name = selected.name();
      return entity && ref && name ? { entity, ref, name } : undefined;
    },
    // Its timeline is the current source's, and it never rolls back.
    current: () => true,
    complete: () => true,
  });
  createEffect(() => presence.set({ hover: hover.ref() }));
  createEffect(() => presence.set({ selected: selected.ref() }));
  const highlights = createPeerHighlights(model, () => model.shapes() ?? [], presence.peers);
  const props: Pick<ViewerProps, "onHover" | "onSelect" | "onPointer" | "highlight" | "peers" | "pins" | "onPin" | "selectionAction"> = {
    onHover: (entity) => hover.set(alone() ? undefined : entity),
    onSelect: (entity) => {
      setSelectedEntity(entity);
      selected.set(alone() ? undefined : entity);
    },
    onPointer: (pointer) => presence.set({ pointer }),
    get highlight() {
      return [...highlights(), ...entityComments.highlight()];
    },
    get peers() {
      return peerMarkers(presence.peers());
    },
    get pins() {
      return entityComments.pins();
    },
    onPin: entityComments.onPin,
    get selectionAction() {
      return entityComments.selectionAction();
    },
  };
  // Not part of the props object, whose getters a rest pattern would read once.
  const popover = (wrap: () => HTMLElement) => (
    <>
      <Show when={comments.enabled() && entityComments.detached().length}>
        <DetachedButton count={entityComments.detached().length} onOpen={entityComments.openDetached} />
      </Show>
      <Show when={entityComments.popover()} keyed>
        {(p) => <CommentsPopover comments={comments} threads={p.threads} create={p.create} createNow={p.createNow} caption={p.caption} actions={p.actions} label={p.label} at={p.at} wrap={wrap()} above={!!p.above} onClose={entityComments.close} />}
      </Show>
    </>
  );
  return { props, popover };
}

/** A model, with the camera this user last had in the viewer. */
function ModelViewer(props: { handle: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const model = createModel(props.handle);
  const ui = createUiState(props.element, props.handle.url);
  const { props: presence, popover } = viewerPresence(props.element, props.handle, model);
  let root!: HTMLDivElement;
  return (
    <div class="cad-model cad-model--viewer" ref={root} {...modelAttributes(model)}>
      <Viewer shapes={model.shapes()} sketches={model.sketches()} view={ui.view(VIEWER_TOOL_ID)} onViewChange={(view) => ui.setView(VIEWER_TOOL_ID, view)} createView={viewsOf(props.handle)} collapseViewCube {...presence} />
      {popover(() => root)}
      <StatusBar model={model} />
    </div>
  );
}

/** A view document: its model with its camera. Orbiting is local until "Save view" stores the camera for everyone. */
function ViewDocViewer(props: { handle: DocHandle<CadModelViewDoc>; element: HTMLElement }) {
  const [doc, setDoc] = createSignal(props.handle.doc());
  const onChange = () => setDoc(props.handle.doc());
  props.handle.on("change", onChange);
  onCleanup(() => props.handle.off("change", onChange));
  const [modelHandle] = createResource(
    () => doc()?.model,
    (url: AutomergeUrl) => globalThis.repo?.find<CadModelDoc>(url),
  );
  return (
    <Show when={modelHandle()} fallback={<div class="cad-model cad-model--viewer" data-state="loading" />}>
      {(model) => <SavedView handle={props.handle} doc={doc} model={model()} element={props.element} />}
    </Show>
  );
}

function SavedView(props: { handle: DocHandle<CadModelViewDoc>; doc: () => CadModelViewDoc | undefined; model: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const model = createModel(props.model);
  const { props: presence, popover } = viewerPresence(props.element, props.model, model);
  let stage!: HTMLDivElement;
  const [current, setCurrent] = createSignal<CameraState>();
  const changed = () => !!current() && !sameCamera(current(), props.doc()?.camera);
  const save = () => {
    const camera = current();
    if (camera) props.handle.change((d) => (d.camera = camera));
  };
  // The camera the viewer shows: the document's, again as a new object on Reset, which the viewer applies even if the document's didn't change.
  const [shown, setShown] = createSignal<CameraState>();
  createEffect(() => setShown(props.doc()?.camera));
  const reset = () => {
    const camera = props.doc()?.camera;
    if (!camera) return;
    setShown({ ...camera });
    setCurrent(camera);
  };
  let root!: HTMLDivElement;
  const openModel = () => root.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url: props.model.url }, bubbles: true, composed: true }));
  return (
    <div class="cad-model cad-model--viewer cad-model--view-doc" ref={root} {...modelAttributes(model)}>
      <div class="cad-view-doc__stage" ref={stage}>
        <Viewer shapes={model.shapes()} sketches={model.sketches()} view={shown()} onViewChange={setCurrent} createView={viewsOf(props.model)} collapseViewCube {...presence} />
        <Show when={changed()}>
          <div class="cad-view-doc__edit">
            <button class="cad-editor__button" onClick={save}>
              Save view
            </button>
            <button class="cad-editor__button" onClick={reset}>
              Reset
            </button>
          </div>
        </Show>
        <button class="cad-editor__button cad-view-doc__open" onClick={openModel}>
          Open model
        </button>
        {popover(() => stage)}
      </div>
      <StatusBar model={model} />
    </div>
  );
}
