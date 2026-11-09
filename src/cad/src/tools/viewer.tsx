import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { createModel, modelAttributes } from "../components/createModel.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { createEntityName } from "../components/entityName.ts";
import { createPeerHighlights, joinPresence, peerMarkers } from "../components/presence.ts";
import { createUiState } from "../components/uiState.ts";
import { createNamedViews } from "../components/namedViews.ts";
import { createConfigurations } from "../components/configurations.ts";
import { sameCamera, Viewer, type ViewerProps } from "../components/Viewer.tsx";
import type { CadModelDoc, CadModelEmbedDoc, CameraState } from "../types.ts";
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
 * block. It also shows embeds (`cad-model-embed`), a model seen from one of its named views.
 */
export default function mount(handle: DocHandle<CadModelDoc | CadModelEmbedDoc>, element: HTMLElement): () => void {
  return render(() => {
    const doc = handle.doc();
    return doc && "model" in doc ? <EmbedViewer handle={handle as DocHandle<CadModelEmbedDoc>} element={element} /> : <ModelViewer handle={handle as DocHandle<CadModelDoc>} element={element} />;
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
      <Viewer shapes={model.shapes()} sketches={model.sketches()} view={ui.view(VIEWER_TOOL_ID)} onViewChange={(view) => ui.setView(VIEWER_TOOL_ID, view)} collapseViewCube {...presence} />
      {popover(() => root)}
      <StatusBar model={model} />
    </div>
  );
}

/**
 * An embed (research/18-named-views.md, "Embeds"): its model, seen from its named view, following
 * the model as it changes. Orbiting is local; "Reset" returns to the view.
 */
function EmbedViewer(props: { handle: DocHandle<CadModelEmbedDoc>; element: HTMLElement }) {
  const [doc, setDoc] = createSignal(props.handle.doc());
  const onChange = () => setDoc(props.handle.doc());
  props.handle.on("change", onChange);
  onCleanup(() => props.handle.off("change", onChange));
  const [modelHandle] = createResource(
    () => doc()?.model,
    (url: AutomergeUrl) => globalThis.repo?.find<CadModelDoc>(url),
  );
  return (
    <Show when={modelHandle()} fallback={<div class="cad-model cad-model--viewer cad-model--embed" data-state="loading" />}>
      {(model) => <Embed handle={props.handle} doc={doc} model={model()} element={props.element} />}
    </Show>
  );
}

function Embed(props: { handle: DocHandle<CadModelEmbedDoc>; doc: () => CadModelEmbedDoc | undefined; model: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const configurations = createConfigurations(props.model);
  const configuration = createMemo(() => configurations.list().find((c) => c.id === props.doc()?.configuration));
  /** Its configuration was deleted from the model. */
  const configurationDeleted = () => !!props.doc()?.configuration && !configuration();
  const configured = createMemo(() => configurations.values(configuration()?.id));
  const params = createMemo(
    () => {
      const values = configured().values;
      return Object.keys(values).length ? values : undefined;
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const model = createModel(props.model, params);
  const views = createNamedViews(props.model);
  const { props: presence, popover } = viewerPresence(props.element, props.model, model);
  let stage!: HTMLDivElement;
  const view = createMemo(() => views.views().find((v) => v.id === props.doc()?.view));
  /** Its view was deleted from the model. */
  const deleted = () => !!props.doc()?.view && !view();
  // The camera the viewer shows: the view's, again as a new object on Reset, which the viewer applies even if the view's didn't change.
  const [shown, setShown] = createSignal<CameraState>();
  const [current, setCurrent] = createSignal<CameraState>();
  createEffect(() => {
    const camera = view()?.camera;
    setShown(camera);
    setCurrent(camera);
  });
  const changed = () => !!view() && !!current() && !sameCamera(current(), view()?.camera);
  const reset = () => {
    const camera = view()?.camera;
    if (!camera) return;
    setShown({ ...camera });
    setCurrent(camera);
  };
  const choose = (id: string) => props.handle.change((d) => (d.view = id));
  const chooseConfiguration = (id: string) =>
    props.handle.change((d) => {
      if (id) d.configuration = id;
      else delete d.configuration;
    });
  let root!: HTMLDivElement;
  const openModel = () => root.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url: props.model.url }, bubbles: true, composed: true }));
  return (
    <div class="cad-model cad-model--viewer cad-model--embed" ref={root} {...modelAttributes(model)} data-view={view()?.name ?? ""} data-deleted={deleted() ? "true" : "false"} data-configuration={configuration()?.name ?? ""} data-configuration-deleted={configurationDeleted() ? "true" : "false"}>
      <div class="cad-embed__stage" ref={stage}>
        <Viewer shapes={model.shapes()} sketches={model.sketches()} view={shown()} onViewChange={setCurrent} collapseViewCube {...presence} />
        <div class="cad-embed__edit">
          <select class="cad-editor__button" aria-label="View" title={deleted() ? "This view was deleted from the model; choose another" : "The model's view this embed shows"} onChange={(event) => choose(event.currentTarget.value)}>
            <Show when={!view()}>
              <option value="" disabled selected>
                {deleted() ? "Deleted view" : "No view"}
              </option>
            </Show>
            <For each={views.views()}>
              {(v) => (
                <option value={v.id} selected={v.id === props.doc()?.view}>
                  {v.name}
                </option>
              )}
            </For>
          </select>
          <Show when={configurations.list().length > 0 || props.doc()?.configuration}>
            <select class="cad-editor__button" aria-label="Configuration" title={configurationDeleted() ? "This configuration was deleted from the model; choose another" : "The model's configuration this embed shows"} onChange={(event) => chooseConfiguration(event.currentTarget.value)}>
              <Show when={configurationDeleted()}>
                <option value={props.doc()?.configuration ?? ""} disabled selected>
                  Deleted configuration
                </option>
              </Show>
              <option value="" selected={!props.doc()?.configuration}>
                Defaults
              </option>
              <For each={configurations.list()}>
                {(c) => (
                  <option value={c.id} selected={c.id === props.doc()?.configuration}>
                    {c.name}
                  </option>
                )}
              </For>
            </select>
          </Show>
          <Show when={changed()}>
            <button class="cad-editor__button" onClick={reset}>
              Reset
            </button>
          </Show>
        </div>
        <button class="cad-editor__button cad-embed__open" onClick={openModel}>
          Open model
        </button>
        {popover(() => stage)}
      </div>
      <StatusBar model={model} problems={configured().problems} />
    </div>
  );
}
