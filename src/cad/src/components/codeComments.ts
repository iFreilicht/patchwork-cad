/**
 * Comments in the code pane, as in Patchwork's own text editor (patchwork-base
 * codemirror-base/src/lib/extensions/commentUI.ts, ported): a floating "Comment" button on a
 * selection, the thread in a popover rendered by Patchwork's `comment-thread` tool, and a click on
 * commented code opens its thread again. Commented code is marked, the focused threads' stronger.
 */
import { EditorView, Decoration, showTooltip, type DecorationSet, type Tooltip, type TooltipView } from "@codemirror/view";
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { COMMENT_THREAD_TYPE } from "../model/comments.ts";

export interface CodeCommentOptions {
  /** Starts a thread on the range and returns its URL, or undefined if none can be made, e.g. without a contact. */
  create(from: number, to: number): AutomergeUrl | undefined;
  /** The thread whose range covers `pos`, and the range's start. */
  threadAt(pos: number): { url: AutomergeUrl; from: number } | undefined;
  watchClose(url: AutomergeUrl, close: () => void): () => void;
  /** Called when a popover closes, for any reason. */
  onClose(url: AutomergeUrl): void;
}

export interface CommentMark {
  from: number;
  to: number;
  focused: boolean;
}

/** Sets the marked comment ranges. */
export const setCommentMarks = StateEffect.define<CommentMark[]>();
const plainMark = Decoration.mark({ class: "cad-model__comment" });
const focusedMark = Decoration.mark({ class: "cad-model__comment cad-model__comment--focused" });
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setCommentMarks)) {
        const length = tr.state.doc.length;
        return RangeSet.of(
          effect.value.filter((m) => m.from < m.to && m.to <= length).map((m) => (m.focused ? focusedMark : plainMark).range(m.from, m.to)),
          true,
        );
      }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

type Popover = { url: AutomergeUrl; anchor: number };
const openPopover = StateEffect.define<Popover>();
const closePopover = StateEffect.define<null>();
/** Hides the button until the selection changes (Escape). */
const dismissButton = StateEffect.define<null>();

/** The thread that was just closed: a click that stays inside it doesn't open it again. */
type UiState = { suppressed: AutomergeUrl | undefined };

const POPOVER_CLASS = "cad-model__comment-popover";

function commentButton(from: number, to: number, view: EditorView, options: CodeCommentOptions): HTMLElement {
  const button = document.createElement("button");
  button.className = "cad-model__comment-button";
  button.textContent = "Comment";
  // Focusing the button would blur the editor, collapse the selection and remove the button before the click.
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const url = options.create(from, to);
    // Under the start, as when the thread opens again: the end of a long line may be out of view, where CodeMirror hides tooltips.
    if (url) view.dispatch({ effects: openPopover.of({ url, anchor: from }) });
  });
  return button;
}

/** A thread in Patchwork's `comment-thread` tool, mounted inside the editor so that its provider requests reach the frame. */
export function threadView(url: AutomergeUrl): HTMLElement {
  const thread = document.createElement("patchwork-view");
  thread.setAttribute("doc-url", url);
  thread.setAttribute("tool-id", COMMENT_THREAD_TYPE);
  return thread;
}

function popoverView(view: EditorView, popover: Popover, options: CodeCommentOptions, ui: UiState): TooltipView {
  const dom = document.createElement("div");
  dom.className = POPOVER_CLASS;
  dom.append(threadView(popover.url));
  const close = () => view.dispatch({ effects: closePopover.of(null) });
  const outside = (event: MouseEvent) => !dom.contains(event.target as Node) && close();
  const escape = (event: KeyboardEvent) => event.key === "Escape" && close();
  const doc = view.dom.ownerDocument;
  // Armed after the click that opened it.
  const arm = setTimeout(() => {
    doc.addEventListener("mousedown", outside, true);
    doc.addEventListener("keydown", escape, true);
  });
  const stopWatch = options.watchClose(popover.url, close);
  return {
    dom,
    destroy() {
      clearTimeout(arm);
      doc.removeEventListener("mousedown", outside, true);
      doc.removeEventListener("keydown", escape, true);
      stopWatch();
      ui.suppressed = popover.url;
      // Not inside CodeMirror's update, which is tearing the popover down.
      queueMicrotask(() => options.onClose(popover.url));
    },
  };
}

function buttonTooltip(state: EditorState, options: CodeCommentOptions): Tooltip | null {
  const selection = state.selection.main;
  if (selection.empty || state.readOnly) return null;
  return {
    pos: selection.head,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: commentButton(selection.from, selection.to, view, options) }),
  };
}

interface UiField {
  popover: Popover | null;
  buttonDismissed: boolean;
  tooltip: Tooltip | null;
}

function uiField(options: CodeCommentOptions, ui: UiState) {
  const popoverTooltip = (popover: Popover): Tooltip => ({ pos: popover.anchor, above: false, strictSide: false, arrow: false, create: (view) => popoverView(view, popover, options, ui) });
  return StateField.define<UiField>({
    create: (state) => ({ popover: null, buttonDismissed: false, tooltip: buttonTooltip(state, options) }),
    update(value, tr) {
      let { popover, buttonDismissed } = value;
      let popoverChanged = false;
      if (popover && tr.docChanged) {
        popover = { ...popover, anchor: tr.changes.mapPos(popover.anchor) };
        popoverChanged = true;
      }
      for (const effect of tr.effects) {
        if (effect.is(openPopover)) {
          popover = effect.value;
          popoverChanged = true;
        } else if (effect.is(closePopover)) {
          popover = null;
          popoverChanged = true;
          buttonDismissed = true;
        } else if (effect.is(dismissButton)) buttonDismissed = true;
      }
      if (tr.selection) buttonDismissed = false;
      if (popover) {
        // The same tooltip object, unless the popover moved: a new one would remount the thread mid-edit.
        if (!popoverChanged) return buttonDismissed === value.buttonDismissed ? value : { ...value, buttonDismissed };
        return { popover, buttonDismissed, tooltip: popoverTooltip(popover) };
      }
      if (!popoverChanged && !tr.docChanged && !tr.selection && buttonDismissed === value.buttonDismissed) return value;
      return { popover: null, buttonDismissed, tooltip: buttonDismissed ? null : buttonTooltip(tr.state, options) };
    },
    provide: (field) => showTooltip.from(field, (value) => value.tooltip),
  });
}

export function codeComments(options: CodeCommentOptions): Extension {
  const ui: UiState = { suppressed: undefined };
  const field = uiField(options, ui);
  return [
    marks,
    field,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
        if ((event.target as HTMLElement | null)?.closest(`.${POPOVER_CLASS}`) || view.state.readOnly) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const hit = pos === null ? undefined : options.threadAt(pos);
        if (!hit) {
          ui.suppressed = undefined;
          return false;
        }
        if (hit.url === ui.suppressed) return false;
        ui.suppressed = undefined;
        view.dispatch({ effects: openPopover.of({ url: hit.url, anchor: hit.from }) });
        // The click also moves the cursor.
        return false;
      },
      keydown(event, view) {
        if (event.key !== "Escape") return false;
        const state = view.state.field(field, false);
        if (!state || state.popover || !state.tooltip) return false;
        view.dispatch({ effects: dismissButton.of(null) });
        return true;
      },
    }),
  ];
}
