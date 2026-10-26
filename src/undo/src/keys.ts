import { UndoManager, type UndoableHandle, type UndoOptions } from "./manager.ts";

/**
 * What Patchwork's frame would do for every tool (research/16-undo-redo.md): one undo history per
 * document and tab, shared by every tool that shows it, and one keyboard binding for the page.
 */

const managers = new WeakMap<object, UndoManager<unknown>>();

/** The tab's undo history of a document; the first call's options apply. */
export function undoManagerFor<T>(handle: UndoableHandle<T>, opts?: UndoOptions): UndoManager<T> {
  let manager = managers.get(handle) as UndoManager<T> | undefined;
  if (!manager) {
    manager = new UndoManager(handle, opts);
    managers.set(handle, manager as UndoManager<unknown>);
  }
  return manager;
}

const bound = new Map<Element, UndoManager<unknown>>();
let lastUsed: Element | undefined;

const isMac = () => typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** Form fields keep the browser's own undo of their text; CodeMirror's editable content doesn't. */
const ownsUndo = (el: Element) => el.closest("input, textarea, select") !== null || (el.closest("[contenteditable]") !== null && el.closest(".cm-editor") === null);

/** The innermost bound element containing `el`. */
const boundFor = (el: Element | null): Element | undefined => {
  for (let at = el; at; at = at.parentElement) if (bound.has(at)) return at;
  return undefined;
};

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || !(isMac() ? event.metaKey : event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const undo = key === "z" && !event.shiftKey;
  const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey && !isMac());
  if (!undo && !redo) return;
  const target = (event.composedPath()[0] as Element | undefined) ?? document.activeElement;
  if (target instanceof Element && ownsUndo(target)) return;
  // Without a focused tool (e.g. after clicking a 3D view, which takes no focus), the tool last used.
  const el = (target instanceof Element ? boundFor(target) : undefined) ?? (lastUsed?.isConnected ? lastUsed : undefined);
  const manager = el && bound.get(el);
  if (!manager) return;
  event.preventDefault();
  event.stopPropagation();
  if (undo) manager.undo();
  else manager.redo();
}

function onUse(event: Event) {
  const el = boundFor(event.target as Element | null);
  if (el) lastUsed = el;
}

/** Binds Mod+Z, Mod+Shift+Z and Mod+Y (not on macOS) inside `element` to the document's undo history. */
export function bindUndo<T>(element: Element, handle: UndoableHandle<T>, opts?: UndoOptions): { manager: UndoManager<T>; unbind: () => void } {
  const manager = undoManagerFor(handle, opts);
  if (bound.size === 0) {
    // Capturing, so that no tool's own binding sees the keys first.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onUse, true);
    window.addEventListener("focusin", onUse, true);
  }
  bound.set(element, manager as UndoManager<unknown>);
  const unbind = () => {
    if (!bound.delete(element)) return;
    if (lastUsed === element) lastUsed = undefined;
    if (bound.size > 0) return;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onUse, true);
    window.removeEventListener("focusin", onUse, true);
  };
  return { manager, unbind };
}
