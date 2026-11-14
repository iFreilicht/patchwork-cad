/**
 * draw.io's editor from the inside, through its plugin API, "the only long-term supported solution
 * for access to the EditorUi instance" (draw.io's App.js), which the iframe of draw.io's own web app,
 * served with this tool, lets this tool use: where this user points and what they select, and
 * collaborators' cursors and selections drawn into the diagram, as draw.io's realtime collaboration
 * draws them (P2PCollab.js), in their Patchwork colours.
 */
import type { DiagramView } from "./presence.ts";

// The few parts of draw.io (mxGraph) this uses, as they are at runtime.
interface Point {
  x: number;
  y: number;
}
interface View {
  scale: number;
  translate: Point;
  getState(cell: unknown): unknown;
  addListener(name: string, listener: () => void): void;
  removeListener(listener: () => void): void;
}
interface Graph {
  container: HTMLElement;
  view: View;
  model: { getCell(id: string): unknown; addListener(name: string, listener: () => void): void; removeListener(listener: () => void): void };
  getSelectionCells(): { id: string }[];
  getSelectionModel(): { addListener(name: string, listener: () => void): void; removeListener(listener: () => void): void };
}
interface DrawioFile {
  setShadowPages(pages: unknown): void;
  mergeFile(file: object, success: () => void, error: (e: unknown) => void): void;
}
export interface EditorUi {
  editor: { graph: Graph };
  currentPage?: { getId(): string } | null;
  getCurrentFile(): DrawioFile | null;
  getPagesForXml(xml: string): unknown;
  getFileData(forceXml: boolean, forceSvg?: boolean, forceHtml?: boolean, embeddedCallback?: unknown, ignoreSelection?: boolean, currentPage?: boolean, node?: unknown, compact?: boolean, file?: unknown, uncompressed?: boolean): string;
  addListener(name: string, listener: () => void): void;
  removeListener(listener: () => void): void;
}
interface Highlight {
  highlight(state: unknown): void;
  destroy(): void;
}
export type DrawioWindow = Window & {
  Draw?: { loadPlugin(callback: (ui: EditorUi) => void): void };
  mxUtils: { convertPoint(container: HTMLElement, x: number, y: number): Point };
  mxEvent: { CHANGE: string; SCALE: string; TRANSLATE: string; SCALE_AND_TRANSLATE: string };
  mxCellHighlight: new (graph: Graph, color: string, strokeWidth: number) => Highlight;
  LocalFile: new (ui: EditorUi, data: string) => object;
};

/** The editor, once draw.io has made it; its plugin entry point exists from then on. */
export function editorUi(window: DrawioWindow): EditorUi | undefined {
  let ui: EditorUi | undefined;
  window.Draw?.loadPlugin((u) => (ui = u));
  return ui;
}

/** The diagram the editor shows now, all pages, uncompressed: what it would save. */
export const editorXml = (ui: EditorUi): string => ui.getFileData(true, false, false, undefined, true, false, undefined, false, undefined, true);

/**
 * Merges `to` into the editor, which shows `from`, as draw.io merges a file changed elsewhere into an
 * open one (`DrawioFile.mergeFile`): what differs between the two is patched into the diagram, keeping
 * the selection and the undo history. draw.io diffs against the file's shadow, the diagram as last
 * loaded or merged, which local edits don't move; set to `from`, the editor ends up showing `to`.
 * Synchronous; false if draw.io refused the merge.
 */
export function mergeInto(window: DrawioWindow, ui: EditorUi, from: string, to: string): boolean {
  const file = ui.getCurrentFile();
  if (!file) return false;
  let merged = false;
  file.setShadowPages(ui.getPagesForXml(from));
  file.mergeFile(
    new window.LocalFile(ui, to),
    () => (merged = true),
    (e) => console.warn("draw.io refused a merge", e),
  );
  return merged;
}

/** A collaborator as the diagram shows them. */
export interface ShownPeer {
  key: string;
  name: string;
  color: string;
  view: DiagramView;
}

/**
 * Follows this user's pointer, selection and page in the editor, and draws collaborators on the page
 * they share: a pointer with their name, and their selected cells outlined in their colour.
 */
export function bridge(window: DrawioWindow, ui: EditorUi, report: (view: DiagramView) => void): { show(peers: ShownPeer[]): void; destroy(): void } {
  const graph = ui.editor.graph;
  const container = graph.container;
  const document = container.ownerDocument;
  const page = () => ui.currentPage?.getId();

  // This user.
  const onMove = (event: MouseEvent) => {
    const p = window.mxUtils.convertPoint(container, event.clientX, event.clientY);
    const { scale, translate } = graph.view;
    report({ page: page(), cursor: [Math.round((p.x / scale - translate.x) * 10) / 10, Math.round((p.y / scale - translate.y) * 10) / 10] });
  };
  const onLeave = () => report({ cursor: undefined });
  const onSelection = () => report({ page: page(), selection: graph.getSelectionCells().map((c) => c.id) });
  const onPage = () => {
    report({ page: page(), selection: [], cursor: undefined });
    redraw();
  };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", onLeave);
  graph.getSelectionModel().addListener(window.mxEvent.CHANGE, onSelection);
  ui.addListener("pageSelected", onPage);
  report({ page: page(), selection: graph.getSelectionCells().map((c) => c.id) });

  // Collaborators: their pointers are elements in the diagram's scrolling container, at the point
  // the view puts their coordinates; their selections are draw.io's own highlights, which follow
  // their cells.
  let peers: ShownPeer[] = [];
  const cursors = new Map<string, HTMLElement>();
  const highlights = new Map<string, Highlight[]>();
  const cursorOf = (peer: ShownPeer) => {
    let el = cursors.get(peer.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "patchwork-peer-cursor";
      el.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:3;transition:transform 80ms linear;";
      el.innerHTML = '<svg width="12" height="18" viewBox="0 0 8 12" style="display:block"><path d="M 0 0 L 8 9 L 4 9 L 2 12 Z"/></svg><span style="position:absolute;left:10px;top:14px;padding:1px 6px;border-radius:8px;font:12px/16px sans-serif;color:white;white-space:nowrap"></span>';
      container.append(el);
      cursors.set(peer.key, el);
    }
    el.dataset["peer"] = peer.key;
    el.querySelector("path")!.setAttribute("fill", peer.color);
    const label = el.querySelector("span")!;
    label.textContent = peer.name;
    label.style.background = peer.color;
    return el;
  };
  const redraw = () => {
    const here = page();
    const { scale, translate } = graph.view;
    const shown = peers.filter((p) => p.view.page === here);
    for (const [key, el] of cursors) {
      if (shown.some((p) => p.key === key && p.view.cursor)) continue;
      el.remove();
      cursors.delete(key);
    }
    for (const peer of shown) {
      if (!peer.view.cursor) continue;
      const [x, y] = peer.view.cursor;
      cursorOf(peer).style.transform = `translate(${(x + translate.x) * scale}px, ${(y + translate.y) * scale}px)`;
    }
    for (const list of highlights.values()) for (const h of list) h.destroy();
    highlights.clear();
    for (const peer of shown) {
      const list = (peer.view.selection ?? []).flatMap((id) => {
        const state = graph.view.getState(graph.model.getCell(id));
        if (!state) return [];
        const h = new window.mxCellHighlight(graph, peer.color, 3);
        h.highlight(state);
        return [h];
      });
      highlights.set(peer.key, list);
    }
  };
  const view = graph.view;
  for (const event of [window.mxEvent.SCALE, window.mxEvent.TRANSLATE, window.mxEvent.SCALE_AND_TRANSLATE]) view.addListener(event, redraw);
  // A peer's cell that changes, e.g. one they move, moves their outline.
  graph.model.addListener(window.mxEvent.CHANGE, redraw);

  return {
    show(next) {
      peers = next;
      redraw();
    },
    destroy() {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      graph.getSelectionModel().removeListener(onSelection);
      ui.removeListener(onPage);
      view.removeListener(redraw);
      graph.model.removeListener(redraw);
      for (const el of cursors.values()) el.remove();
      for (const list of highlights.values()) for (const h of list) h.destroy();
    },
  };
}
