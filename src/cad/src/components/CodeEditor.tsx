import { createEffect, onCleanup } from "solid-js";
import { EditorView, Decoration, GutterMarker, gutter, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, Prec, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { automergeSyncPlugin } from "@automerge/automerge-codemirror";
import { getRegistry, type PluginDescription } from "@inkandswitch/patchwork-plugins";
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

/** Code of a timeline entry related to the focused one (or the focused one itself, `self`). */
export interface RelatedSpan {
  start: number;
  end: number;
  relation: "self" | "dependency" | "dependent";
  link: "chain" | "hard";
}

const setPast = StateEffect.define<{ from: number; to: number } | undefined>();
const pastLine = Decoration.line({ class: "cad-model__past-marker" });

/** Marks the lines past the timeline marker (research/07, "The timeline marker"), whose tokens are greyed. */
const past = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setPast)) continue;
      const span = effect.value;
      const doc = tr.state.doc;
      if (!span || span.to > doc.length || span.from >= span.to) {
        value = Decoration.none;
        continue;
      }
      const first = doc.lineAt(span.from).number;
      const last = doc.lineAt(span.to).number;
      value = Decoration.set(Array.from({ length: last - first + 1 }, (_, i) => pastLine.range(doc.line(first + i).from)));
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setRelated = StateEffect.define<RelatedSpan[]>();

/** Marks the code of the entry whose dependencies the timeline shows, and of those it relates to. */
const related = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRelated)) continue;
      const spans = effect.value.filter((s) => s.end <= tr.state.doc.length && s.start < s.end).sort((a, b) => a.start - b.start);
      value = Decoration.set(spans.map((s) => Decoration.mark({ class: `cad-model__related cad-model__related--${s.relation}`, attributes: { "data-relation": s.relation, "data-link": s.link } }).range(s.start, s.end)));
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** A bar in the relation gutter, in front of a line of the focused entry or of one related to it. */
class RelationMarker extends GutterMarker {
  constructor(
    readonly relation: RelatedSpan["relation"],
    readonly link: RelatedSpan["link"],
  ) {
    super();
    this.elementClass = `cad-model__relation-bar cad-model__relation-bar--${relation} cad-model__relation-bar--${link}`;
  }
  override eq(other: RelationMarker): boolean {
    return other.relation === this.relation && other.link === this.link;
  }
}

/**
 * The bars of the lines of related code. They are a gutter of their own, not part of the line: the
 * lines past the timeline marker are greyed with a filter, which would grey a bar in the line, too.
 */
const relationBars = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRelated)) continue;
      const doc = tr.state.doc;
      const byLine = new Map<number, RelationMarker>();
      for (const s of effect.value) {
        if (s.end > doc.length || s.start >= s.end) continue;
        for (let n = doc.lineAt(s.start).number; n <= doc.lineAt(s.end).number; n++) if (!byLine.has(n) || s.relation === "self") byLine.set(n, new RelationMarker(s.relation, s.link));
      }
      value = RangeSet.of([...byLine].sort(([a], [b]) => a - b).map(([n, marker]) => marker.range(doc.line(n).from)));
    }
    return value;
  },
});

const relationGutter = gutter({ class: "cad-model__relation-gutter", markers: (view) => view.state.field(relationBars) });

const setCrossHover = StateEffect.define<{ start: number; end: number }[]>();
const crossHoverMark = Decoration.mark({ class: "cad-model__cross-hover" });

/** Marks the code of the features that made the face or edge hovered in the 3D view (research/12). */
const crossHover = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setCrossHover)) continue;
      const spans = effect.value.filter((s) => s.end <= tr.state.doc.length && s.start < s.end).sort((a, b) => a.start - b.start);
      value = Decoration.set(spans.map((s) => crossHoverMark.range(s.start, s.end)));
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

type CodemirrorExtensionDescription = PluginDescription & { supportedDatatypes?: "*" | string[] };

/**
 * The `codemirror:extension` plugins for our datatype, as Patchwork's own CodeMirror tool
 * (patchwork-base/codemirror-base) loads them. This is how the user's theme reaches the editor:
 * patchwork-base/theming registers one for every datatype.
 */
async function patchworkExtensions(): Promise<Extension[]> {
  const registry = getRegistry<CodemirrorExtensionDescription>("codemirror:extension");
  const applicable = registry.filter(({ supportedDatatypes: types }) => types === "*" || (Array.isArray(types) && types.includes("cad-model")));
  return (await registry.loadAll(applicable)).flatMap(({ module }) => (Array.isArray(module) ? module : [module]) as Extension[]);
}

export function CodeEditor(props: {
  handle: DocHandle<CadModelDoc>;
  errorLine: number | undefined;
  /**
   * A source span to mark, e.g. the timeline entry whose code was asked for: the editor takes the
   * focus, puts the cursor at its start and scrolls to it. The mark goes with the next click, key or
   * loss of focus in the editor, and `onFocusDone` says so.
   */
  focus?: { start: number; end: number } | undefined;
  onFocusDone?: () => void;
  /** The code past the timeline marker. */
  past?: { start: number; end: number } | undefined;
  /** Code to mark as related to the focused timeline entry. */
  related?: RelatedSpan[];
  /** The code position under the pointer, as it moves. */
  onHover?: (offset: number | undefined) => void;
  /** The cursor's position while the editor has focus, else undefined. */
  onCursor?: (offset: number | undefined) => void;
  /** Code to mark as the origin of what the 3D view hovers. */
  crossHover?: { start: number; end: number }[];
}) {
  let hovered: number | undefined;
  const hover = (offset: number | undefined) => {
    if (offset === hovered) return;
    hovered = offset;
    props.onHover?.(offset);
  };
  let cursor: number | undefined;
  const reportCursor = (offset: number | undefined) => {
    if (offset === cursor) return;
    cursor = offset;
    props.onCursor?.(offset);
  };
  const patchwork = new Compartment();
  /** Whether the `focus` span is marked. */
  let marked = false;
  /** Removes the mark, after the event or update that asked for it: nothing here may interfere with CodeMirror's input handling. */
  const unmark = () =>
    marked &&
    queueMicrotask(() => {
      if (!marked || disposed) return;
      marked = false;
      view.dispatch({ effects: setFocus.of(undefined) });
      props.onFocusDone?.();
    });
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
      patchwork.of([]),
      // Only applies when no theme provides a highlighter, e.g. outside Patchwork.
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      errorLine,
      focus,
      past,
      // Lowest precedence: its marks wrap the syntax tokens, so that greying the tokens past the marker keeps their colours.
      Prec.lowest(related),
      relationBars,
      relationGutter,
      // Losing the focus removes the mark; clicks and keys do through listeners on the DOM below.
      EditorView.updateListener.of((update) => update.focusChanged && !update.view.hasFocus && unmark()),
      Prec.lowest(crossHover),
      EditorView.domEventHandlers({
        // Precise: only over text, not in the empty space after a line.
        mousemove: (event, view) => hover(view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined),
        mouseleave: () => hover(undefined),
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.focusChanged || update.docChanged) reportCursor(update.view.hasFocus ? update.state.selection.main.head : undefined);
      }),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      automergeSyncPlugin({ handle: props.handle, path: ["source"] }),
    ],
  });

  let disposed = false;
  // Capturing listeners, which see clicks and keys before CodeMirror handles and possibly stops them.
  view.dom.addEventListener("mousedown", unmark, true);
  view.dom.addEventListener("keydown", unmark, true);
  patchworkExtensions().then(
    (extensions) => disposed || view.dispatch({ effects: patchwork.reconfigure(extensions) }),
    (error: unknown) => console.warn("[cad-model] couldn't load CodeMirror extensions", error),
  );

  createEffect(() => view.dispatch({ effects: setErrorLine.of(props.errorLine) }));
  createEffect(() => {
    const span = props.focus;
    const range = span && span.end <= view.state.doc.length ? { from: span.start, to: span.end } : undefined;
    if (!range) {
      marked = false;
      view.dispatch({ effects: setFocus.of(undefined) });
      return;
    }
    view.dispatch({ selection: { anchor: range.from }, effects: [setFocus.of(range), EditorView.scrollIntoView(range.from, { y: "center" })] });
    // Focusing may blur the editor's previous focus first: mark only once it has the focus.
    view.focus();
    marked = true;
  });
  // Both follow the source, which changes inside CodeMirror's own update when the user types here
  // (the sync plugin writes to the document then), and a dispatch during an update throws: dispatch after it.
  const dispatchSoon = (spec: Parameters<typeof view.dispatch>[0]) => queueMicrotask(() => disposed || view.dispatch(spec));
  createEffect(() => {
    const span = props.past;
    dispatchSoon({ effects: setPast.of(span ? { from: span.start, to: span.end } : undefined) });
  });
  createEffect(() => {
    const spans = props.related ?? [];
    dispatchSoon({ effects: setRelated.of(spans) });
  });
  createEffect(() => {
    const spans = props.crossHover ?? [];
    dispatchSoon({ effects: setCrossHover.of(spans) });
  });
  onCleanup(() => {
    hover(undefined);
    reportCursor(undefined);
    disposed = true;
    view.destroy();
  });

  return <div class="cad-model__code" ref={(el) => el.append(view.dom)} />;
}
