import { createEffect, createSignal, Show } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape } from "../../kernel/protocol.ts";
import type { Span } from "../../model/analyze.ts";
import type { FeatureEntry, ScriptEntry } from "../../model/timeline.ts";
import type { CadModelDoc } from "../../types.ts";
import { CodeEditor, type RelatedSpan } from "../CodeEditor.tsx";
import { createModel, modelAttributes } from "../createModel.ts";
import { StatusBar } from "../StatusBar.tsx";
import { Viewer, type Highlight } from "../Viewer.tsx";
import { FeatureDialog } from "./FeatureDialog.tsx";
import { createEditor } from "./state.ts";
import { Timeline } from "./Timeline.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { createUiState } from "../uiState.ts";
import { viewsOf } from "../viewDoc.ts";

const EDITOR_TOOL_ID = "cad-model";

/** The source span of a feature's parameter value, or an empty span. */
const spanOf = (entry: FeatureEntry, key: string): [number, number] => {
  const p = entry.call.props?.find((x) => x.key === key);
  return p ? [p.value.start, p.value.end] : [0, 0];
};

/**
 * The Fusion-like editor (tool `cad-model`, the default): toolbar, 3D view, timeline and feature
 * dialogs on one kernel worker; the shared code editor opens next to it on demand.
 */
export function WysiwygEditor(props: { handle: DocHandle<CadModelDoc>; element: HTMLElement }) {
  const model = createModel(props.handle);
  const ui = createUiState(props.element, props.handle.url);
  const editor = createEditor(props.handle, model, ui);
  const codeOpen = ui.codeOpen;
  const setCodeOpen = ui.setCodeOpen;
  const [codeFocus, setCodeFocus] = createSignal<Span>();
  const [pickError, setPickError] = createSignal<string>();
  const pick = (entity: Parameters<typeof editor.pick>[0]) => {
    setPickError(undefined);
    editor.pick(entity).catch((error: unknown) => setPickError(String((error as Error)?.message ?? error)));
  };

  /** The first feature the last build ran at or after the timeline marker, if the marker isn't at the end. */
  const firstPastMarker = (): string | undefined => {
    for (const entry of editor.timeline().entries.slice(editor.marker())) {
      const name = entry.kind === "feature" ? entry.trace?.name : entry.features[0]?.name;
      if (name) return name;
    }
    return undefined;
  };
  // While a reference is picked, the view rolls back to the bodies the feature works on, as in
  // Fusion's timeline; the feature's resolved references are highlighted there. Otherwise it shows
  // the model at the timeline marker.
  const rollbackTo = () => {
    const entry = editor.open();
    return editor.pickTarget() && entry?.trace ? entry.trace.name : firstPastMarker();
  };
  const [rolledBack, setRolledBack] = createSignal<MeshedShape[]>();
  createEffect(() => {
    const name = rollbackTo();
    model.last();
    if (!name) return setRolledBack(undefined);
    model.engine.rollback(name).then(
      (shapes) => rollbackTo() === name && setRolledBack(shapes),
      () => setRolledBack(undefined),
    );
  });
  const highlight = (): Highlight[] =>
    rolledBack() && editor.pickTarget() ? (editor.open()?.trace?.refs ?? []).map((d) => ({ body: d.body, kind: d.kind, indices: d.matches })) : [];

  /** The code past the timeline marker, from the start of its first line. */
  const pastMarker = (): Span | undefined => {
    const entries = editor.timeline().entries;
    const first = entries[editor.marker()];
    if (!first || editor.syntaxError()) return undefined;
    return { start: first.span.start, end: entries[entries.length - 1]!.span.end };
  };
  /** The code of the entry whose dependencies are shown, and of its dependencies and dependents. */
  const relatedCode = (): RelatedSpan[] => {
    const index = editor.focused();
    const entries = editor.timeline().entries;
    if (index === undefined || editor.syntaxError() || !entries[index]) return [];
    return [{ ...entries[index]!.span, relation: "self" as const, link: "hard" as const }, ...[...editor.related().values()].map((r) => ({ ...entries[r.index]!.span, relation: r.relation, link: r.link }))];
  };

  /** The open sketch's profile, or the sketch of the open extrude. */
  const overlays = () => {
    const entry = editor.open();
    if (!entry) return [];
    const sketchName = entry.type === "sketch" ? entry.name : entry.type === "extrude" ? editor.source().slice(...spanOf(entry, "sketch")) : undefined;
    const sketch = model.trace().find((t) => t.name === sketchName && t.outline);
    return sketch?.outline ? [{ points: sketch.outline, closed: true }] : [];
  };

  const openScript = (entry: ScriptEntry) => {
    editor.openFeature(undefined);
    setCodeFocus({ ...entry.span });
    setCodeOpen(true);
  };
  const editCode = () => {
    const entry = editor.open();
    if (entry) setCodeFocus({ ...entry.span });
    setCodeOpen(true);
  };

  return (
    <div class="cad-model cad-model--editor" classList={{ "cad-model--with-code": codeOpen() }} {...modelAttributes(model)} data-open={editor.open()?.name ?? ""} data-rolled-back={rolledBack() ? "true" : "false"} data-marker={editor.marker()}>
      <Toolbar editor={editor} codeOpen={codeOpen()} onToggleCode={() => setCodeOpen(!codeOpen())} />
      <div class="cad-editor__stage">
        <Viewer
          shapes={rolledBack() ?? model.shapes()}
          pick={editor.pickTarget()?.kind}
          onPick={pick}
          highlight={highlight()}
          overlays={overlays()}
          view={ui.view(EDITOR_TOOL_ID)}
          onViewChange={(view) => ui.setView(EDITOR_TOOL_ID, view)}
          createView={viewsOf(props.handle)}
        />
        <Show when={editor.open()}>{(entry) => <FeatureDialog editor={editor} entry={entry()} onEditCode={editCode} />}</Show>
        <Show when={pickError()}>{(message) => <p class="cad-editor__banner" role="alert">Can't refer to that: {message()}</p>}</Show>
        <Show when={editor.syntaxError()}>{(message) => <p class="cad-editor__banner">The code doesn't parse ({message()}); the timeline shows its last valid state.</p>}</Show>
      </div>
      <Show when={codeOpen()}>
        <div class="cad-editor__code">
          <CodeEditor handle={props.handle} errorLine={model.error()?.line} focus={codeFocus()} past={pastMarker()} related={relatedCode()} />
        </div>
      </Show>
      <Timeline editor={editor} onOpenScript={openScript} />
      <StatusBar model={model} notice={editor.moveError()} />
    </div>
  );
}
