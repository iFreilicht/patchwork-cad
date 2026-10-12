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

export function CodeEditor(props: { handle: DocHandle<CadModelDoc>; errorLine: number | undefined }) {
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
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto", fontFamily: "inherit" } }),
      automergeSyncPlugin({ handle: props.handle, path: ["source"] }),
    ],
  });

  createEffect(() => view.dispatch({ effects: setErrorLine.of(props.errorLine) }));
  onCleanup(() => view.destroy());

  return <div class="cad-model__code" ref={(el) => el.append(view.dom)} />;
}
