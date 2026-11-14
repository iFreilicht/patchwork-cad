/**
 * draw.io's editor on a diagram document, in an iframe of draw.io's own web app, which the build puts
 * next to this bundle (dist/drawio), served from the same place as the tool: no other site is asked
 * for anything (`stealth`). Embed mode's JSON protocol: the editor asks for the diagram (`init`) and
 * reports each change (`autosave`).
 *
 * The document keeps the diagram as records per cell (diagram.ts), so that collaborators' edits merge
 * per shape and property, and as a .drawio.svg (`content`) for everything that reads files, which is
 * exported once changes settle. On each change, this user's or a collaborator's, the tool reads the
 * diagram from the editor, writes what this user changed since, and merges the document, with
 * everyone's changes, into the editor without reloading it, keeping this user's selection and undo
 * (editor.ts); both at once, so that the editor shows exactly what the tool last read or merged.
 * Collaborators' pointers and selections come over Patchwork's presence (presence.ts) and are drawn
 * into the editor (editor.ts). A document shown read-only, e.g. at an old
 * version, is its picture.
 */
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { DrawioDoc } from "./datatype.ts";
import { applyChanges, applyPages, diagramXml, parseDiagram, type PageRecord } from "./diagram.ts";
import { bridge, editorUi, editorXml, mergeInto, type DrawioWindow, type EditorUi, type ShownPeer } from "./editor.ts";
import { DiagramPresence, presenceColor } from "./presence.ts";
import { diagramOf, EMPTY_DIAGRAM, textOfDataUri } from "./svg.ts";

/** draw.io's web app, next to the bundle: this module is a chunk in dist/assets (vite.config.ts). The build copies it there, so vite finds nothing to bundle. */
const WEBAPP = new URL(/* @vite-ignore */ "../drawio/index.html", import.meta.url);

/**
 * Embed mode, without the buttons that save or close: every change is saved as it is made. Not
 * `offline`, which also turns plugins off, and with them the editor's plugin API (editor.ts);
 * `stealth` keeps the editor from asking other sites for anything all the same.
 */
const EDITOR_PARAMS = { embed: "1", proto: "json", spin: "1", stealth: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", libraries: "1", lang: "en" };

/** How long the SVG export waits after the last change: an export right at a change lacks the shapes it adds. */
const SETTLE_MS = 300;

/** draw.io names each export's SVG anew; the same diagram should be the same file, or collaborators would write it back and forth. */
const sameSvg = (svg: string) => svg.replace(/\bge-svg-[\w-]+/g, "ge-svg-drawio");

type Message = { event: string; data?: string };

/**
 * Whether what `element` shows is dark: as Patchwork's theme has it (its stylesheet's `color-scheme`,
 * the theme following the browser's light or dark mode), else as the browser prefers. `onChange`
 * follows a change of either; the returned function stops it.
 */
function colorScheme(element: HTMLElement, onChange: (dark: boolean) => void): { dark(): boolean; stop(): void } {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const dark = () => {
    const schemes = getComputedStyle(element).colorScheme.split(/\s+/);
    const light = schemes.includes("light");
    return schemes.includes("dark") === light ? query.matches : !light;
  };
  let last = dark();
  const check = () => {
    if (dark() === last) return;
    last = !last;
    onChange(last);
  };
  // A theme is an attribute on the root, and a stylesheet that loads after it is set.
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLLinkElement) node.addEventListener("load", check, { once: true });
    check();
  });
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.head, { childList: true });
  query.addEventListener("change", check);
  return {
    dark,
    stop() {
      observer.disconnect();
      query.removeEventListener("change", check);
    },
  };
}

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
  const scheme = colorScheme(element, (dark) => ui?.setDarkMode(dark));
  url.searchParams.set("dark", scheme.dark() ? "1" : "0");
  iframe.src = url.href;
  element.append(iframe);
  const post = (message: object) => iframe.contentWindow?.postMessage(JSON.stringify(message), "*");

  /** The diagram as draw.io's XML, from the records, or from the SVG of a document that has none yet. */
  const xmlOf = (doc: DrawioDoc) => (doc.pages?.length ? diagramXml(doc.pages) : (diagramOf(doc.content) ?? EMPTY_DIAGRAM));
  const win = () => iframe.contentWindow as DrawioWindow;
  let ui: EditorUi | undefined;
  let writing = false;
  /** The pages the editor showed when the tool last read or merged them: this user's changes are what differs from them. */
  let shadow: PageRecord[] | undefined;

  // The SVG: one export at a time, after changes settle, written if it differs.
  let exporting = false;
  let again = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const exportSvg = () => {
    if (exporting) {
      again = true;
      return;
    }
    exporting = true;
    post({ action: "export", format: "xmlsvg" });
  };
  const changed = () => {
    clearTimeout(settle);
    settle = setTimeout(exportSvg, SETTLE_MS);
  };

  /** This user's changes into the document, the document's into the editor. */
  const sync = () => {
    if (!ui) return;
    const xml = editorXml(ui);
    const pages = parseDiagram(xml);
    if (!pages) return;
    const from = shadow;
    if (!from || diagramXml(from) !== diagramXml(pages)) {
      writing = true;
      // A document without records gets them whole; otherwise only this user's changes are written.
      handle.change((d) => (from ? applyChanges(d, from, pages) : applyPages(d, pages)));
      writing = false;
      changed();
    }
    shadow = pages;
    const doc = handle.doc();
    if (!doc.pages || diagramXml(doc.pages) === diagramXml(pages)) return;
    // Others' changes: the editor then shows the document, the base of this user's next changes.
    if (mergeInto(win(), ui, xml, diagramXml(doc.pages))) shadow = JSON.parse(JSON.stringify(doc.pages)) as PageRecord[];
    changed();
  };

  // Collaborators.
  const presence = new DiagramPresence(handle);
  const repo = (element as HTMLElement & { repo?: typeof globalThis.repo }).repo ?? globalThis.repo;
  const contacts = new Map<AutomergeUrl, { name?: string; color?: string }>();
  let shown: ReturnType<typeof bridge> | undefined;
  const showPeers = () =>
    shown?.show(
      presence.peers().map((peer): ShownPeer => {
        let contact = contacts.get(peer.contactUrl);
        if (!contact) {
          contacts.set(peer.contactUrl, (contact = {}));
          void repo?.find<{ name?: string; color?: string }>(peer.contactUrl).then((h) => {
            const read = () => {
              Object.assign(contact!, { name: h.doc()?.name, color: h.doc()?.color });
              showPeers();
            };
            h.on("change", read);
            read();
          });
        }
        return { key: peer.key, name: contact.name || "Someone", color: contact.color || presenceColor(peer.contactUrl), view: peer.view };
      }),
    );
  const offPeers = presence.onChange(showPeers);
  const unsubscribe = subscribe<AutomergeUrl>(element, { type: "patchwork:contact" }, (contact) => contact && presence.setContact(contact));

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || typeof event.data !== "string") return;
    let message: Message;
    try {
      message = JSON.parse(event.data) as Message;
    } catch {
      return;
    }
    if (message.event === "init") {
      post({ action: "load", autosave: 1, xml: xmlOf(handle.doc()) });
    } else if (message.event === "load") {
      // The editor shows the document now; draw.io's plugin API reaches it from here on.
      ui = editorUi(win());
      if (!ui) return console.warn("draw.io's editor is out of reach: changes are not saved");
      ui.setDarkMode(scheme.dark());
      shadow = parseDiagram(editorXml(ui));
      shown = bridge(win(), ui, (view) => presence.set(view));
      showPeers();
      sync();
    } else if (message.event === "autosave") {
      sync();
    } else if (message.event === "export" && message.data) {
      exporting = false;
      const svg = sameSvg(textOfDataUri(message.data));
      if (svg !== handle.doc().content) {
        writing = true;
        handle.change((d) => {
          d.content = svg;
        });
        writing = false;
      }
      if (again) {
        again = false;
        exportSvg();
      }
    }
  };
  window.addEventListener("message", onMessage);

  // A change from elsewhere, another tab or a collaborator, merged into what the editor shows, once the change event is over.
  let pending = false;
  const onChange = () => {
    if (writing || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      sync();
    });
  };
  handle.on("change", onChange);

  return () => {
    clearTimeout(settle);
    window.removeEventListener("message", onMessage);
    handle.off("change", onChange);
    offPeers();
    scheme.stop();
    unsubscribe();
    shown?.destroy();
    presence.stop();
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
