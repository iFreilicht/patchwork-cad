import { createEffect, onCleanup } from "solid-js";
import { EditorView, Decoration, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, type DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { automergeSyncPlugin } from "@automerge/automerge-codemirror";
import type { DocHandle } from "@automerge/automerge-repo";
import type { CadModelDoc } from "../types.ts";

const setErrorLine = StateEffect.define<number | undefined>();
const errorLineClass = Decoration.line({ class: "cad-model__error-line" });
const setFocus = StateEffect.define<{ from: number; to: number } | undefined>();
const focusMark = Decoration.mark({ class: "cad-model__focus" });

/** Marks the code of the timeline entry being edited. */
const focus = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFocus)) continue;
      const span = effect.value;
      value = span && span.to <= tr.state.doc.length && span.from < span.to ? Decoration.set([focusMark.range(span.from, span.to)]) : Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Marks the line of the current model error. */
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setErrorLine)) continue;
      const line = effect.value;
      value = line !== undefined && line <= tr.state.doc.lines ? Decoration.set([errorLineClass.range(tr.state.doc.line(line).from)]) : Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function CodeEditor(props: {
  handle: DocHandle<CadModelDoc>;
  errorLine: number | undefined;
  /** A source span to mark and scroll to, e.g. the timeline entry being edited. */
  focus?: { start: number; end: number } | undefined;
}) {
  const view = new EditorView({
    doc: props.handle.doc()?.source ?? "",
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
      javascript(),
      syntaxHighlighting(defaultHighlightStyle),
      errorLine,
      focus,
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto", fontFamily: "inherit" } }),
      automergeSyncPlugin({ handle: props.handle, path: ["source"] }),
    ],
  });

  createEffect(() => view.dispatch({ effects: setErrorLine.of(props.errorLine) }));
  createEffect(() => {
    const span = props.focus;
    const range = span ? { from: span.start, to: span.end } : undefined;
    view.dispatch({ effects: range ? [setFocus.of(range), EditorView.scrollIntoView(range.from, { y: "center" })] : [setFocus.of(undefined)] });
  });
  onCleanup(() => view.destroy());

  return <div class="cad-model__code" ref={(el) => el.append(view.dom)} />;
}
