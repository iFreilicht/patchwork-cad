/**
 * Patchwork documents in a diagram: a cell that names a document (`patchworkUrl`, and the tool
 * picked for it, `patchworkTool`) on a user object, titled by the document, which draw.io and every
 * reader of the .drawio.svg show as a box with that title. The editor shows the document itself over
 * the cell, in Patchwork's embed frame (`<patchwork-view tool-id="embed">`): draw.io runs in an
 * iframe, and Patchwork's views and their providers are only in the page around it, so the frame
 * lies in the page, over the iframe, where draw.io's view puts the cell, through its plugin API.
 *
 * A click selects and moves the cell as any other; selected alone, its document takes the pointer,
 * until the selection changes or Escape. Documents are dropped in from Patchwork, e.g. its sidebar.
 */
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { droppedDocuments, isPatchworkDrag } from "./dnd.ts";
import type { DrawioWindow, EditorUi } from "./editor.ts";

export const URL_ATTRIBUTE = "patchworkUrl";
export const TOOL_ATTRIBUTE = "patchworkTool";

/** A box with the document's title at its top, in the theme's colours, which the frame covers in the editor. */
const EMBED_STYLE = "rounded=1;arcSize=2;absoluteArcSize=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;dashed=1;";
const EMBED_SIZE = { width: 360, height: 260 };
/** How far the frame stays inside the cell's box, so that its outline and handles show around it. */
const INSET = 4;

// The few parts of draw.io (mxGraph) this uses, as they are at runtime.
interface Cell {
  id: string;
  value: unknown;
}
interface State {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Graph {
  container: HTMLElement;
  view: { scale: number; translate: { x: number; y: number }; getState(cell: Cell): State | null; addListener(name: string, l: () => void): void; removeListener(l: () => void): void };
  model: { cells: Record<string, Cell>; isVertex(cell: Cell): boolean; beginUpdate(): void; endUpdate(): void; addListener(name: string, l: () => void): void; removeListener(l: () => void): void };
  getDefaultParent(): Cell;
  insertVertex(parent: Cell, id: string | null, value: unknown, x: number, y: number, width: number, height: number, style: string): Cell;
  setSelectionCells(cells: Cell[]): void;
  clearSelection(): void;
  getTooltipForCell(cell: Cell): string | null;
  getSelectionCells(): Cell[];
  getSelectionModel(): { addListener(name: string, l: () => void): void; removeListener(l: () => void): void };
  setAttributeForCell(cell: Cell, name: string, value: string | null): void;
  dblClick(event: MouseEvent, cell: Cell | null): void;
}
type Window = DrawioWindow & {
  mxUtils: DrawioWindow["mxUtils"] & { createXmlDocument(): Document };
  mxEvent: DrawioWindow["mxEvent"] & { UP: string };
};

/** The document a cell embeds, if it embeds one. */
export function embeddedUrl(cell: Cell | null | undefined): AutomergeUrl | undefined {
  const value = cell?.value as { getAttribute?: (name: string) => string | null } | undefined;
  return (value && typeof value === "object" && typeof value.getAttribute === "function" ? value.getAttribute(URL_ATTRIBUTE) : null) as AutomergeUrl | undefined;
}

/**
 * Follows the editor's embedded documents with frames in `layer`, an element of the page over the
 * iframe, and takes documents dropped from Patchwork. `self` is the diagram's own document, which
 * can't be embedded in itself; `titleOf` finds a dropped document's title.
 */
export function embeds(window: Window, ui: EditorUi, layer: HTMLElement, options: { self: AutomergeUrl; titleOf(url: AutomergeUrl): Promise<string | undefined> }): { destroy(): void } {
  const graph = ui.editor.graph as unknown as Graph;
  const container = graph.container;
  const doc = container.ownerDocument;
  // The frames, clipped to the diagram's part of the editor.
  const clip = layer.ownerDocument.createElement("div");
  clip.className = "drawio-embeds";
  clip.style.cssText = "position:absolute;overflow:hidden;pointer-events:none";
  layer.append(clip);
  const frames = new Map<string, HTMLElement>();
  /** The cell whose document takes the pointer: the embedding cell selected alone. */
  let active: string | undefined;

  const frameOf = (cell: Cell, url: AutomergeUrl): HTMLElement => {
    let frame = frames.get(cell.id);
    if (frame && frame.getAttribute("doc-url") !== url) {
      frame.remove();
      frame = undefined;
    }
    if (!frame) {
      frame = layer.ownerDocument.createElement("patchwork-view");
      frame.className = "drawio-embed";
      frame.dataset["cell"] = cell.id;
      frame.style.cssText = "position:absolute;display:block;box-sizing:border-box;background:var(--editor-fill, Canvas);border-radius:4px;overflow:hidden";
      // Its document once it is in the page: a view given its document before stays empty (research/22).
      clip.append(frame);
      frame.setAttribute("tool-id", "embed");
      frame.setAttribute("doc-url", url);
      const tool = (cell.value as Element).getAttribute(TOOL_ATTRIBUTE);
      if (tool) frame.setAttribute("embed-tool-id", tool);
      // A tool picked in the frame is the cell's, and goes no further.
      frame.addEventListener("patchwork:embed-tool-changed", (event) => {
        event.stopPropagation();
        const picked = (event as CustomEvent<{ toolId?: string }>).detail?.toolId;
        const current = graph.model.cells[cell.id];
        if (picked && current) graph.setAttributeForCell(current, TOOL_ATTRIBUTE, picked);
      });
      // Escape in the document, which has the keyboard while it is entered, leaves it.
      frame.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && active === cell.id) leave();
      });
      frames.set(cell.id, frame);
    }
    return frame;
  };

  /**
   * Whether draw.io shows something over the diagram, which the frames would hide: a menu or a
   * dialog. Shown, not only there: draw.io keeps some, e.g. its tooltip, hidden in the page.
   */
  const covered = () =>
    [...doc.querySelectorAll<HTMLElement>(".mxPopupMenu, .geDialog")].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden");

  const redraw = () => {
    const box = container.getBoundingClientRect();
    Object.assign(clip.style, { left: `${box.left + container.clientLeft}px`, top: `${box.top + container.clientTop}px`, width: `${container.clientWidth}px`, height: `${container.clientHeight}px` });
    clip.style.visibility = covered() ? "hidden" : "visible";
    const shown = new Set<string>();
    for (const cell of Object.values(graph.model.cells)) {
      const url = embeddedUrl(cell);
      const state = url && url !== options.self && graph.model.isVertex(cell) ? graph.view.getState(cell) : null;
      if (!url || !state || state.width <= 2 * INSET || state.height <= 2 * INSET) continue;
      const frame = frameOf(cell, url);
      shown.add(cell.id);
      Object.assign(frame.style, {
        left: `${state.x - container.scrollLeft + INSET}px`,
        top: `${state.y - container.scrollTop + INSET}px`,
        width: `${state.width - 2 * INSET}px`,
        height: `${state.height - 2 * INSET}px`,
        pointerEvents: active === cell.id ? "auto" : "none",
      });
      frame.classList.toggle("drawio-embed--active", active === cell.id);
      // Entered, it shows that it takes the pointer.
      frame.style.boxShadow = active === cell.id ? "0 0 0 2px var(--accent-color, Highlight)" : "";
    }
    for (const [id, frame] of frames) {
      if (shown.has(id)) continue;
      frame.remove();
      frames.delete(id);
    }
  };

  // Selected alone, an embedded document takes the pointer, so that the next click is in it.
  const onSelection = () => {
    const cells = graph.getSelectionCells();
    const next = cells.length === 1 && embeddedUrl(cells[0]) && embeddedUrl(cells[0]) !== options.self ? cells[0]!.id : undefined;
    if (next === active) return;
    active = next;
    redraw();
  };
  // A double click in an embedded document is the document's, not draw.io's label editing.
  const dblClick = graph.dblClick;
  graph.dblClick = function (event, cell) {
    if (!(cell && embeddedUrl(cell) && embeddedUrl(cell) !== options.self)) dblClick.call(this, event, cell);
  };
  // The cell's tooltip, its label, would lie over the document.
  const tooltip = graph.getTooltipForCell;
  graph.getTooltipForCell = function (cell) {
    return embeddedUrl(cell) ? null : tooltip.call(this, cell);
  };
  /** Leaves the document, deselecting its cell, and gives the keyboard back to the diagram. */
  const leave = () => {
    graph.clearSelection();
    container.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && active) leave();
  };

  // Documents dropped from Patchwork, each a cell where they are dropped.
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer || !isPatchworkDrag([...event.dataTransfer.types])) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === "move" ? "move" : event.dataTransfer.effectAllowed === "link" ? "link" : "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer || !isPatchworkDrag([...event.dataTransfer.types])) return;
    event.preventDefault();
    event.stopPropagation();
    const docs = droppedDocuments(event.dataTransfer).filter((d) => d.url !== options.self);
    const p = window.mxUtils.convertPoint(container, event.clientX, event.clientY);
    const { scale, translate } = graph.view;
    const [x, y] = [p.x / scale - translate.x, p.y / scale - translate.y];
    void Promise.all(docs.map(async (d) => ({ ...d, title: d.name ?? (await options.titleOf(d.url)) ?? "Document" }))).then((titled) => {
      if (!titled.length) return;
      graph.model.beginUpdate();
      try {
        const cells = titled.map((d, i) => {
          const value = window.mxUtils.createXmlDocument().createElement("object");
          value.setAttribute("label", d.title);
          value.setAttribute(URL_ATTRIBUTE, d.url);
          // Centred where it is dropped, the next ones a little further down.
          return graph.insertVertex(graph.getDefaultParent(), null, value, x - EMBED_SIZE.width / 2 + 20 * i, y - EMBED_SIZE.height / 2 + 20 * i, EMBED_SIZE.width, EMBED_SIZE.height, EMBED_STYLE);
        });
        graph.setSelectionCells(cells);
      } finally {
        graph.model.endUpdate();
      }
    });
  };

  const { mxEvent } = window;
  for (const event of [mxEvent.SCALE, mxEvent.TRANSLATE, mxEvent.SCALE_AND_TRANSLATE]) graph.view.addListener(event, redraw);
  graph.model.addListener(mxEvent.CHANGE, redraw);
  graph.getSelectionModel().addListener(mxEvent.CHANGE, onSelection);
  ui.addListener("pageSelected", redraw);
  container.addEventListener("scroll", redraw);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("dragover", onDragOver, true);
  doc.addEventListener("drop", onDrop, true);
  // The editor's layout and its menus and dialogs come and go without events of their own.
  const resize = new ResizeObserver(redraw);
  resize.observe(container);
  const menus = new MutationObserver(redraw);
  menus.observe(doc.body, { childList: true });
  redraw();

  return {
    destroy() {
      graph.dblClick = dblClick;
      graph.getTooltipForCell = tooltip;
      graph.view.removeListener(redraw);
      graph.model.removeListener(redraw);
      graph.getSelectionModel().removeListener(onSelection);
      ui.removeListener(redraw);
      container.removeEventListener("scroll", redraw);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("dragover", onDragOver, true);
      doc.removeEventListener("drop", onDrop, true);
      resize.disconnect();
      menus.disconnect();
      clip.remove();
    },
  };
}
