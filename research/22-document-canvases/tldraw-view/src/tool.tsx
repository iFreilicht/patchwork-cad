/**
 * A tldraw5 document as a picture on a CAD canvas (research/22-document-canvases.md): the shapes
 * alone, on a transparent background, without tldraw's UI, read-only, following the document as it
 * changes without mounting again. Its camera comes from the hosting `<patchwork-view>`'s
 * `data-camera` (tldraw's `{ x, y, z }`), and follows it; it writes nothing into the document. Light
 * or dark as the stock tldraw tool is, by Patchwork's theme.
 */
import type { Patch } from "@automerge/automerge";
import type { DocHandle, DocHandleChangePayload } from "@automerge/automerge-repo";
import { createTLStore, defaultShapeUtils, Tldraw, type Editor, type SerializedSchema, type TLRecord } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { createRoot } from "react-dom/client";
import { useColorScheme } from "./color-scheme.ts";

type TLDrawDoc = { store: Record<string, TLRecord>; schema: SerializedSchema };
type Camera = { x: number; y: number; z: number };

/** The camera the host asks for, if it gives one. */
const cameraOf = (host: Element | null): Camera | undefined => {
  try {
    const camera = JSON.parse(host?.getAttribute("data-camera") ?? "null") as Partial<Camera> | null;
    return camera && typeof camera.x === "number" && typeof camera.y === "number" && typeof camera.z === "number" ? { x: camera.x, y: camera.y, z: camera.z } : undefined;
  } catch {
    return undefined;
  }
};

/** tldraw, read-only and without UI, in the theme's light or dark. */
function View(props: { element: HTMLElement; store: ReturnType<typeof createTLStore>; onMount: (editor: Editor) => void }) {
  const colorScheme = useColorScheme(props.element);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw store={props.store} colorScheme={colorScheme} hideUi autoFocus={false} onMount={props.onMount} />
    </div>
  );
}

export default function mount(handle: DocHandle<TLDrawDoc>, element: HTMLElement): () => void {
  const doc = handle.doc();
  // tldraw's shape utils don't type-check under exactOptionalPropertyTypes (their `meta?` returns).
  const store = createTLStore({ shapeUtils: defaultShapeUtils as never });
  store.loadStoreSnapshot({ store: structuredClone(doc.store) as never, schema: doc.schema });
  // The document's changes, record by record, as remote changes: the store follows without a new mount.
  const onChange = ({ patches, doc }: DocHandleChangePayload<TLDrawDoc>) => {
    if (!doc) return;
    const ids = new Set(patches.flatMap((p: Patch) => (p.path[0] === "store" && p.path.length > 1 ? [String(p.path[1])] : [])));
    const put = [...ids].flatMap((id) => (doc.store[id] ? [structuredClone(doc.store[id])] : []));
    const removed = [...ids].filter((id) => !doc.store[id]) as TLRecord["id"][];
    store.mergeRemoteChanges(() => {
      if (removed.length) store.remove(removed);
      if (put.length) store.put(put);
    });
  };
  handle.on("change", onChange);

  const host = element.closest("patchwork-view");
  let editor: Editor | undefined;
  const applyCamera = () => {
    const camera = cameraOf(host);
    if (editor && camera) editor.setCamera(camera, { force: true });
    else editor?.zoomToFit();
  };
  const observer = new MutationObserver(applyCamera);
  if (host) observer.observe(host, { attributes: true, attributeFilter: ["data-camera"] });
  const onMount = (e: Editor) => {
    editor = e;
    e.updateInstanceState({ isReadonly: true });
    e.setCameraOptions({ isLocked: true });
    applyCamera();
  };

  element.classList.add("cad-tldraw-canvas-view");
  element.style.position = "relative";
  element.style.height = "100%";
  const style = document.createElement("style");
  // No background: the page or the model shows between the shapes.
  style.textContent = ".cad-tldraw-canvas-view .tl-container, .cad-tldraw-canvas-view .tl-background { background: transparent !important; } .cad-tldraw-canvas-view .tl-background { display: none; }";
  element.append(style);
  const root = createRoot(element.appendChild(document.createElement("div")));
  root.render(<View element={element} store={store} onMount={onMount} />);
  return () => {
    root.unmount();
    observer.disconnect();
    handle.off("change", onChange);
    style.remove();
  };
}
