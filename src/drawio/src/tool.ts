/**
 * draw.io's editor on a diagram document, in an iframe of draw.io's own web app, which the build puts
 * next to this bundle (dist/drawio), served from the same place as the tool: no other site is asked
 * for anything (`stealth`, `offline`). Embed mode's JSON protocol: the editor asks for the diagram
 * (`init`), reports each change (`autosave`), and exports the diagram as an SVG that carries it
 * (`xmlsvg`), which becomes the document's content. Changes made elsewhere are loaded into it. A
 * document shown read-only, e.g. at an old version, is its picture.
 */
import type { DocHandle, DocHandleChangePayload } from "@automerge/automerge-repo";
import type { DrawioDoc } from "./datatype.ts";
import { diagramOf, EMPTY_DIAGRAM, textOfDataUri } from "./svg.ts";

/** draw.io's web app, next to the bundle: this module is a chunk in dist/assets (vite.config.ts). */
const WEBAPP = new URL("../drawio/index.html", import.meta.url);

/** Embed mode, offline, without the buttons that save or close: every change is saved as it is made. */
const EDITOR_PARAMS = { embed: "1", proto: "json", spin: "1", stealth: "1", offline: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", libraries: "1", lang: "en" };

/** How long the export waits after the last change. */
const SETTLE_MS = 300;

type Message = { event: string; xml?: string; data?: string; format?: string };

export default function mount(handle: DocHandle<DrawioDoc>, element: HTMLElement): () => void {
  element.style.position = "relative";
  element.style.height = "100%";
  if (handle.isReadOnly()) return picture(handle, element);

  const iframe = document.createElement("iframe");
  iframe.className = "drawio-editor";
  iframe.title = "draw.io";
  iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
  const url = new URL(WEBAPP);
  for (const [key, value] of Object.entries(EDITOR_PARAMS)) url.searchParams.set(key, value);
  iframe.src = url.href;
  element.append(iframe);

  const post = (message: object) => iframe.contentWindow?.postMessage(JSON.stringify(message), "*");
  /** The content this editor shows: what it loaded, or last saved. */
  let shown = handle.doc().content;
  let ready = false;
  // One export at a time; a change during one asks for another once it is back.
  let exporting = false;
  let again = false;
  // An autosave comes as a change is made, before draw.io has drawn it, whose export would lack the
  // new shapes: the export waits for the changes to settle.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(settle);
    settle = setTimeout(exportDiagram, SETTLE_MS);
  };
  const exportDiagram = () => {
    if (exporting) {
      again = true;
      return;
    }
    exporting = true;
    post({ action: "export", format: "xmlsvg" });
  };
  const load = (content: string) => {
    shown = content;
    post({ action: "load", autosave: 1, xml: diagramOf(content) ?? EMPTY_DIAGRAM });
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || typeof event.data !== "string") return;
    let message: Message;
    try {
      message = JSON.parse(event.data) as Message;
    } catch {
      return;
    }
    if (message.event === "init") {
      ready = true;
      load(handle.doc().content);
    } else if (message.event === "autosave") changed();
    else if (message.event === "export" && message.data) {
      exporting = false;
      const svg = textOfDataUri(message.data);
      if (svg !== shown) {
        shown = svg;
        handle.change((d) => {
          d.content = svg;
        });
      }
      if (again) {
        again = false;
        exportDiagram();
      }
    }
  };
  window.addEventListener("message", onMessage);

  // A change from elsewhere, another tab or a collaborator, replaces what the editor shows.
  const onChange = ({ doc }: DocHandleChangePayload<DrawioDoc>) => {
    if (ready && doc && doc.content !== shown && !exporting) load(doc.content);
  };
  handle.on("change", onChange);

  return () => {
    clearTimeout(settle);
    window.removeEventListener("message", onMessage);
    handle.off("change", onChange);
    iframe.remove();
  };
}

/** The diagram's picture, following the document, e.g. at a version that can't be edited. */
function picture(handle: DocHandle<DrawioDoc>, element: HTMLElement): () => void {
  const img = document.createElement("img");
  img.className = "drawio-picture";
  img.alt = handle.doc().name;
  img.style.cssText = "display:block;max-width:100%;max-height:100%;margin:auto";
  let url = "";
  const show = () => {
    URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([handle.doc().content], { type: "image/svg+xml" }));
    img.src = url;
  };
  show();
  element.append(img);
  handle.on("change", show);
  return () => {
    handle.off("change", show);
    URL.revokeObjectURL(url);
    img.remove();
  };
}
