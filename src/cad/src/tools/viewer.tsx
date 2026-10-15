import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { createModel, modelAttributes } from "../components/createModel.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { createUiState } from "../components/uiState.ts";
import { viewsOf } from "../components/viewDoc.ts";
import { sameCamera, Viewer } from "../components/Viewer.tsx";
import type { CadModelDoc, CadModelViewDoc, CameraState } from "../types.ts";
import "../styles.css";

const VIEWER_TOOL_ID = "cad-model-viewer";

/**
 * The model's 3D view alone, read-only: for embedding a model in other documents and as a building
 * block. It also shows view documents (`cad-model-view`), a model with a saved camera.
 */
export default function mount(handle: DocHandle<CadModelDoc | CadModelViewDoc>, element: HTMLElement): () => void {
  return render(() => {
    const doc = handle.doc();
    return doc && "model" in doc ? <ViewDocViewer handle={handle as DocHandle<CadModelViewDoc>} /> : <ModelViewer handle={handle as DocHandle<CadModelDoc>} element={element} />;
  }, element);
}

/** A model, with the camera this user last had in the viewer. */
function ModelViewer(props: { handle: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const model = createModel(props.handle);
  const ui = createUiState(props.element, props.handle.url);
  return (
    <div class="cad-model cad-model--viewer" {...modelAttributes(model)}>
      <Viewer shapes={model.shapes()} view={ui.view(VIEWER_TOOL_ID)} onViewChange={(view) => ui.setView(VIEWER_TOOL_ID, view)} createView={viewsOf(props.handle)} />
      <StatusBar model={model} />
    </div>
  );
}

/** A view document: its model with its camera. Orbiting is local until "Save view" stores the camera for everyone. */
function ViewDocViewer(props: { handle: DocHandle<CadModelViewDoc> }) {
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
      {(model) => <SavedView handle={props.handle} doc={doc} model={model()} />}
    </Show>
  );
}

function SavedView(props: { handle: DocHandle<CadModelViewDoc>; doc: () => CadModelViewDoc | undefined; model: DocHandle<CadModelDoc> }) {
  const model = createModel(props.model);
  const [current, setCurrent] = createSignal<CameraState>();
  const changed = () => !!current() && !sameCamera(current(), props.doc()?.camera);
  const save = () => {
    const camera = current();
    if (camera) props.handle.change((d) => (d.camera = camera));
  };
  let root!: HTMLDivElement;
  const openModel = () => root.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url: props.model.url }, bubbles: true, composed: true }));
  return (
    <div class="cad-model cad-model--viewer cad-model--view-doc" ref={root} {...modelAttributes(model)}>
      <Viewer shapes={model.shapes()} view={props.doc()?.camera} onViewChange={setCurrent} createView={viewsOf(props.model)} />
      <div class="cad-view-doc__actions">
        <Show when={changed()}>
          <button class="cad-editor__button" onClick={save}>
            Save view
          </button>
        </Show>
        <button class="cad-editor__button" onClick={openModel}>
          Open model
        </button>
      </div>
      <StatusBar model={model} />
    </div>
  );
}
