import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { bindUndo } from "@patchwork-cad/undo";
import type { MeshedShape, ShownSketch } from "../../kernel/protocol.ts";
import type { Span } from "../../model/analyze.ts";
import { ownersOf, type Entry, type FeatureEntry } from "../../model/timeline.ts";
import type { CadModelDoc } from "../../types.ts";
import { CodeEditor, type RelatedSpan } from "../CodeEditor.tsx";
import { createModel, modelAttributes } from "../createModel.ts";
import { StatusBar } from "../StatusBar.tsx";
import { Viewer, type Entity, type Highlight } from "../Viewer.tsx";
import { createEntityName } from "../entityName.ts";
import { FeatureDialog } from "./FeatureDialog.tsx";
import { createEditor } from "./state.ts";
import { Timeline } from "./Timeline.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { createUiState } from "../uiState.ts";
import { createPeerHighlights, joinPresence, peerMarkers } from "../presence.ts";
import type { TimelinePeer } from "./Timeline.tsx";
import { viewsOf } from "../viewDoc.ts";
import { createComments } from "../comments.ts";
import { CommentsPopover } from "../CommentsPopover.tsx";
import { createEntityComments, DetachedButton } from "../entityComments.tsx";
import { createFeatureHighlights } from "../featureHighlights.ts";

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
  const presence = joinPresence(props.element, props.handle, "editor");
  const comments = createComments(props.element, props.handle);
  // Comments and Patchwork's metadata (`@…`) aren't undone (research/16-undo-redo.md).
  const undo = bindUndo(props.element, props.handle, { ignore: (path) => String(path[0]).startsWith("@") });
  onCleanup(undo.unbind);
  const codeOpen = ui.codeOpen;
  const setCodeOpen = ui.setCodeOpen;
  const [codeFocus, setCodeFocus] = createSignal<Span>();
  const [pickError, setPickError] = createSignal<string>();
  const pick = (entity: Parameters<typeof editor.pick>[0]) => {
    setPickError(undefined);
    editor.pick(entity).catch((error: unknown) => setPickError(String((error as Error)?.message ?? error)));
  };

  /** The names of the features the last build ran in timeline entries. */
  const ran = (entry: Entry) => (entry.kind === "feature" ? (entry.trace ? [entry.trace.name] : []) : entry.features.map((f) => f.name));
  /**
   * The state at the timeline marker, if it isn't at the end: the bodies visible before the first
   * feature that runs after it, or else after the last one before it, or else none.
   */
  const atMarker = (): { feature: string; after: boolean } | "nothing" | undefined => {
    const entries = editor.timeline().entries;
    const marker = editor.marker();
    if (marker >= entries.length) return undefined;
    const next = entries.slice(marker).flatMap(ran)[0];
    if (next) return { feature: next, after: false };
    const previous = entries.slice(0, marker).flatMap(ran).at(-1);
    return previous ? { feature: previous, after: true } : "nothing";
  };
  // While a reference is picked, the view rolls back to the bodies the feature works on, as in
  // Fusion's timeline; the feature's resolved references are highlighted there. Otherwise it shows
  // the model at the timeline marker.
  const rollbackTo = () => {
    const entry = editor.open();
    return editor.pickTarget() && entry?.trace ? { feature: entry.trace.name, after: false } : atMarker();
  };
  const rollbackKey = () => JSON.stringify(rollbackTo() ?? null);
  const [rolledBackTo, setRolledBack] = createSignal<{ shapes: MeshedShape[]; sketches: ShownSketch[] }>();
  createEffect(() => {
    const to = rollbackTo();
    const key = rollbackKey();
    model.last();
    if (!to || to === "nothing") {
      setRolledBack(to ? { shapes: [], sketches: [] } : undefined);
      return;
    }
    model.engine.rollback(to.feature, to.after).then(
      (state) => rollbackKey() === key && setRolledBack(state),
      () => setRolledBack(undefined),
    );
  });
  const rolledBack = () => rolledBackTo()?.shapes;
  const shown = () => rolledBack() ?? model.shapes() ?? [];
  const shownSketches = () => rolledBackTo()?.sketches ?? model.sketches();
  const references = (): Highlight[] =>
    rolledBack() && editor.pickTarget() ? (editor.open()?.trace?.refs ?? []).map((d) => ({ body: d.body, kind: d.kind, indices: d.matches, style: "accent" })) : [];

  /** What the features hovered in the timeline or code made, by their schema's `hover`. */
  const featureHighlights = createFeatureHighlights(model, shown);
  const featureHighlight = (): Highlight[] => featureHighlights(editor.hoveredFeatures(), "hover");

  // Hovering a face or edge marks the features that made it in the timeline and code; the status bar names it, or the selected one.
  const hoverName = createEntityName(model, 100);
  const selectedName = createEntityName(model, 0);
  const [selectedEntity, setSelectedEntity] = createSignal<Entity>();
  const onSelect = (entity: Entity | undefined) => {
    setSelectedEntity(entity);
    selectedName.set(entity);
  };
  const [viewFeatures, setViewFeatures] = createSignal<string[]>([]);
  const onHover = (entity: Entity | undefined) => {
    hoverName.set(entity);
    const shape = entity && shown().find((s) => s.body === entity.body);
    const names = Object.entries(shape?.features ?? {}).flatMap(([name, owned]) => ((entity!.kind === "face" ? owned.faces : owned.edges).includes(entity!.index) ? [name] : []));
    setViewFeatures(names);
    editor.setViewHover(names);
  };
  /** The code of the features hovered in the 3D view: their statements, or in a Custom Script the lines that ran them. */
  const viewHoveredCode = (): Span[] => {
    const names = new Set(viewFeatures());
    if (names.size === 0 || editor.syntaxError()) return [];
    const text = editor.source();
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    return editor.timeline().entries.flatMap((e): Span[] => {
      if (e.kind === "feature") return ownersOf(e).some((n) => names.has(n)) ? [e.span] : [];
      return e.features.flatMap((f) => (names.has(f.name) && f.line !== undefined && lineStarts[f.line - 1] !== undefined ? [{ start: lineStarts[f.line - 1]!, end: (lineStarts[f.line] ?? text.length + 1) - 1 }] : []));
    });
  };

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

  /** The open sketch's profile, or the sketch of the open extrude, and the profiles of hovered sketches. */
  const overlays = () => {
    const entry = editor.open();
    const sketchName = entry?.type === "sketch" ? entry.name : entry?.type === "extrude" ? editor.source().slice(...spanOf(entry, "sketch")) : undefined;
    const names = new Set([...(sketchName ? [sketchName] : []), ...editor.hoveredFeatures()]);
    return model.trace().flatMap((t) => (names.has(t.name) && t.outline ? [{ points: t.outline, closed: true }] : []));
  };

  // What collaborators see of this view (research/13), and what this view shows of theirs.
  // Hovered and selected faces and edges go out as references once the worker has named them.
  createEffect(() => presence.set({ hover: hoverName.ref() }));
  createEffect(() => presence.set({ selected: selectedName.ref() }));
  createEffect(() => presence.set({ features: editor.hoveredFeatures() }));
  createEffect(() => presence.set({ marker: ui.marker() }));
  createEffect(() => presence.set({ open: editor.open()?.name }));
  const peers = presence.peers;
  const peerHighlights = createPeerHighlights(model, shown, peers);
  const entityComments = createEntityComments({
    comments,
    model,
    shown,
    entries: () => editor.timeline().entries,
    source: editor.source,
    selected: () => {
      const entity = selectedEntity();
      const ref = selectedName.ref();
      const name = selectedName.name();
      return entity && ref && name ? { entity, ref, name } : undefined;
    },
    current: () => !editor.syntaxError(),
    complete: () => !rolledBack(),
  });
  let stage!: HTMLDivElement;
  const timelinePeers = (): TimelinePeer[] => {
    const entries = editor.timeline().entries;
    return presence
      .peers()
      .filter((p) => p.state.tool === "editor")
      .map((p) => {
        const names = new Set(p.state.features ?? []);
        const marked = new Set(entries.flatMap((e, i) => ((e.kind === "feature" && e.name === p.state.open) || ownersOf(e).some((n) => names.has(n)) ? [i] : [])));
        return { key: p.key, color: p.color, contactUrl: p.contactUrl, marker: editor.markerOf(p.state.marker), entries: marked };
      });
  };

  /** Opens the code pane at an entry's code: a Custom Script's or a body()'s, which have no dialog. */
  const openCode = (span: Span) => {
    editor.openFeature(undefined);
    setCodeFocus({ ...span });
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
      <div class="cad-editor__stage" ref={stage}>
        <Viewer
          shapes={rolledBack() ?? model.shapes()}
          pick={editor.pickTarget()?.kind}
          onPick={pick}
          onHover={onHover}
          onSelect={onSelect}
          onPointer={(pointer) => presence.set({ pointer })}
          highlight={[...peerHighlights(), ...entityComments.highlight(), ...references(), ...featureHighlight()]}
          pins={entityComments.pins()}
          onPin={entityComments.onPin}
          selectionAction={entityComments.selectionAction()}
          peers={peerMarkers(peers())}
          overlays={overlays()}
          sketches={shownSketches()}
          view={ui.view(EDITOR_TOOL_ID)}
          onViewChange={(view) => ui.setView(EDITOR_TOOL_ID, view)}
          createView={viewsOf(props.handle)}
        />
        <Show when={editor.open()}>{(entry) => <FeatureDialog editor={editor} entry={entry()} onEditCode={editCode} />}</Show>
        <Show when={pickError()}>{(message) => <p class="cad-editor__banner" role="alert">Can't refer to that: {message()}</p>}</Show>
        <Show when={comments.enabled() && entityComments.detached().length}>
          <DetachedButton count={entityComments.detached().length} onOpen={entityComments.openDetached} />
        </Show>
        <Show when={entityComments.popover()} keyed>
          {(p) => <CommentsPopover comments={comments} threads={p.threads} create={p.create} createNow={p.createNow} caption={p.caption} actions={p.actions} label={p.label} at={p.at} wrap={stage} above={!!p.above} onClose={entityComments.close} />}
        </Show>
        <Show when={editor.syntaxError()}>{(message) => <p class="cad-editor__banner">The code doesn't parse ({message()}); the timeline shows its last valid state.</p>}</Show>
      </div>
      <Show when={codeOpen()}>
        <div class="cad-editor__code">
          <CodeEditor
            handle={props.handle}
            undo={undo.manager}
            errorLine={model.error()?.line}
            focus={codeFocus()}
            onFocusDone={() => setCodeFocus(undefined)}
            past={pastMarker()}
            related={relatedCode()}
            onHover={editor.setCodeHover}
            onCursor={editor.setCodeCursor}
            crossHover={viewHoveredCode()}
            onSelection={(code) => presence.set({ code })}
            peerSelections={presence.peers().flatMap((p) => (p.state.code ? [{ key: p.key, color: p.color, contactUrl: p.contactUrl, ...p.state.code }] : []))}
            comments={comments}
          />
        </div>
      </Show>
      <Timeline editor={editor} onOpenCode={openCode} peers={timelinePeers()} comments={comments} />
      <StatusBar model={model} notice={editor.notice()} reference={selectedName.name() ? { code: selectedName.name()!, selected: true } : hoverName.name() ? { code: hoverName.name()!, selected: false } : undefined} />
    </div>
  );
}
