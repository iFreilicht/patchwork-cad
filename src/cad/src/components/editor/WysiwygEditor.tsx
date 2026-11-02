import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
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
import { createBodies } from "./bodies.ts";
import { Browser, ResultDialog } from "./Browser.tsx";

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
  const bodies = createBodies(editor, ui);
  /** Whether the return entry's dialog is open; it and a feature's dialog take turns. */
  const [resultOpen, setResultOpen] = createSignal(false);
  createEffect(() => editor.open() && setResultOpen(false));
  const [resultHovered, setResultHovered] = createSignal(false);
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
    // Past the return, the view shows what main returns.
    if (marker > entries.length) return undefined;
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
  /** What the view would show: what main returns, or what exists where it is rolled back to. */
  const built = () => rolledBack() ?? model.shapes() ?? [];

  // Bodies that don't show, e.g. hidden or consumed ones, as the browser or a pick hovers them,
  // meshed by the worker once per build (research/15, "Visibility").
  const [meshes, setMeshes] = createSignal(new Map<string, MeshedShape | null>());
  createEffect(on(model.last, () => setMeshes(new Map())));
  const hoveredRow = () => {
    const lane = editor.hoveredLane();
    return lane === undefined ? undefined : bodies.rows().find((r) => r.lane === lane);
  };
  /** While a body or sketch is picked, the version a click on the hovered timeline entry would pick. */
  const hoveredVersion = () => {
    const index = editor.hovered();
    return editor.pickingVersion() && index !== undefined ? editor.versionAt(index) : undefined;
  };
  const kindOf = (version: string | undefined) => (version ? editor.lanes()?.versions.get(version)?.kind : undefined);
  const wantedMeshes = createMemo(() => [hoveredRow()?.kind === "body" ? hoveredRow()!.version : undefined, kindOf(hoveredVersion()) === "body" ? hoveredVersion() : undefined].filter((n): n is string => !!n));
  createEffect(() => {
    const cache = meshes();
    for (const name of wantedMeshes()) {
      if (cache.has(name) || built().some((s) => s.body === name)) continue;
      cache.set(name, null);
      model.engine.result(name).then(
        (shape) => meshes() === cache && setMeshes(new Map(cache).set(name, shape ?? null)),
        () => undefined,
      );
    }
  });
  const meshOf = (name: string) => built().find((s) => s.body === name) ?? meshes().get(name) ?? undefined;
  /** The same shapes stay the same array: a new one would reset the view's selection. */
  const sameShapes = (a: MeshedShape[], b: MeshedShape[]) => a.length === b.length && a.every((s, i) => s === b[i]);
  /** What this user sees: what exists at the marker, without the bodies they hid. */
  const shown = createMemo(() => built().filter((s) => !s.body || bodies.shows(s.body)), [], { equals: sameShapes });
  /** Bodies the view would show but this user hid: collaborators' highlights on them show as ghosts. */
  const hidden = createMemo(() => built().filter((s) => s.body && !bodies.shows(s.body)), [], { equals: sameShapes });
  const shownSketches = () => (rolledBackTo()?.sketches ?? model.sketches()).filter((s) => bodies.shows(s.name));
  /** All faces of a shown body, or of a mesh of it as a ghost. */
  const wholeBody = (name: string, style: Highlight["style"]): Highlight[] => {
    const visible = shown().find((s) => s.body === name);
    const shape = visible ?? meshOf(name);
    if (!shape) return [];
    const indices = [...new Set((shape.faceIndex ?? []).filter((i) => i >= 0))];
    return [{ body: name, kind: "face", indices, style, ...(visible ? {} : { shape, ghost: true }) }];
  };
  /** While a body field or the return is picked, the bodies it holds; while a reference is, what it resolves to. */
  const references = (): Highlight[] => {
    const target = editor.pickTarget();
    if (target?.param === "return") return [...(editor.lanes()?.returned ?? [])].flatMap((n) => wholeBody(n, "accent"));
    const entry = editor.open();
    if (!rolledBack() || !target || !entry) return [];
    if (target.kind === "body" || target.kind === "sketch") {
      const value = entry.call.props?.find((p) => p.key === target.param)?.node;
      const names = value?.type === "Identifier" ? [value.name] : value?.type === "ArrayExpression" ? value.elements.flatMap((e) => (e?.type === "Identifier" ? [e.name] : [])) : [];
      return names.flatMap((n) => wholeBody(n, "accent"));
    }
    return (entry.trace?.refs ?? []).map((d) => ({ body: d.body, kind: d.kind, indices: d.matches, style: "accent" }));
  };
  /** The body hovered in the browser, what a pick would take, and what main returns while the return entry is hovered. */
  const bodyHighlights = (): Highlight[] => {
    const row = hoveredRow();
    const fromBrowser = row?.kind === "body" ? wholeBody(row.version, "hover") : [];
    const pointed = bodyUnderPointer();
    const fromView = pointed && editor.pickingVersion() ? wholeBody(pointed, "hover") : [];
    const version = hoveredVersion();
    const fromTimeline = version && kindOf(version) === "body" ? wholeBody(version, "hover") : [];
    const fromResult = resultHovered() ? [...(editor.lanes()?.returned ?? [])].flatMap((n) => wholeBody(n, "hover")) : [];
    return [...fromBrowser, ...fromView, ...fromTimeline, ...fromResult];
  };
  /** The sketch hovered in the browser, or in the timeline while a version is picked, as an overlay. */
  const hoveredSketch = () => {
    const row = hoveredRow();
    const name = row?.kind === "sketch" ? row.version : kindOf(hoveredVersion()) === "sketch" ? hoveredVersion() : undefined;
    return name ? model.trace().find((t) => t.name === name)?.outline : undefined;
  };

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
  /** While a body is picked, the body under the pointer, which a click picks as a whole. */
  const [bodyUnderPointer, setBodyUnderPointer] = createSignal<string>();
  const onHover = (entity: Entity | undefined) => {
    hoverName.set(entity);
    setBodyUnderPointer(editor.pickingVersion() ? entity?.body : undefined);
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
    if (editor.syntaxError()) return undefined;
    // Before the return, the return is rolled back.
    if (!first) return editor.marker() === entries.length ? editor.timeline().returned : undefined;
    return { start: first.span.start, end: editor.timeline().returned?.end ?? entries[entries.length - 1]!.span.end };
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
    const sketch = hoveredSketch();
    // While the return entry is hovered, the sketches main returns, as its bodies are highlighted.
    if (resultHovered()) for (const n of editor.lanes()?.returned ?? []) if (editor.lanes()?.versions.get(n)?.kind === "sketch") names.add(n);
    return [...model.trace().flatMap((t) => (names.has(t.name) && t.outline ? [{ points: t.outline, closed: true }] : [])), ...(sketch ? [{ points: sketch, closed: true }] : [])];
  };

  // What collaborators see of this view (research/13), and what this view shows of theirs.
  // Hovered and selected faces and edges go out as references once the worker has named them.
  createEffect(() => presence.set({ hover: hoverName.ref() }));
  createEffect(() => presence.set({ selected: selectedName.ref() }));
  createEffect(() => presence.set({ features: editor.hoveredFeatures() }));
  createEffect(() => presence.set({ marker: ui.marker() }));
  createEffect(() => presence.set({ open: editor.open()?.name }));
  const peers = presence.peers;
  const peerHighlights = createPeerHighlights(model, shown, peers, hidden);
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
  /** Opens the code pane at the return. */
  const editReturn = () => {
    const returned = editor.timeline().returned;
    if (returned) setCodeFocus({ ...returned });
    setCodeOpen(true);
  };
  const returnCount = () => (editor.returnEditable() ? (editor.lanes()?.returned.size ?? 0) : undefined);
  const editCode = () => {
    const entry = editor.open();
    if (entry) setCodeFocus({ ...entry.span });
    setCodeOpen(true);
  };

  return (
    <div class="cad-model cad-model--editor" classList={{ "cad-model--with-code": codeOpen(), "cad-model--with-browser": ui.browserOpen() }} {...modelAttributes(model)} data-open={editor.open()?.name ?? ""} data-rolled-back={rolledBack() ? "true" : "false"} data-marker={editor.marker()}>
      <Toolbar editor={editor} codeOpen={codeOpen()} onToggleCode={() => setCodeOpen(!codeOpen())} browserOpen={ui.browserOpen()} onToggleBrowser={() => ui.setBrowserOpen(!ui.browserOpen())} />
      <Show when={ui.browserOpen()}>
        <Browser editor={editor} bodies={bodies} />
      </Show>
      <div class="cad-editor__stage" ref={stage}>
        <Viewer
          shapes={rolledBack() || model.shapes() ? shown() : undefined}
          pick={editor.pickTarget()?.kind === "body" || editor.pickTarget()?.kind === "version" ? "face" : editor.pickTarget()?.kind === "sketch" ? undefined : (editor.pickTarget()?.kind as "face" | "edge" | undefined)}
          onPick={pick}
          hoverHighlight={!editor.pickingVersion()}
          onHover={onHover}
          onSelect={onSelect}
          onPointer={(pointer) => presence.set({ pointer })}
          highlight={[...peerHighlights(), ...entityComments.highlight(), ...references(), ...featureHighlight(), ...bodyHighlights()]}
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
        <Show when={resultOpen() && !editor.open()}>
          <ResultDialog
            editor={editor}
            onClose={() => {
              if (editor.pickTarget()?.param === "return") editor.setPickTarget(undefined);
              setResultOpen(false);
            }}
            onEditCode={editReturn}
          />
        </Show>
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
      <Timeline
        editor={editor}
        onOpenCode={openCode}
        peers={timelinePeers()}
        comments={comments}
        result={{
          get open() {
            return resultOpen() && !editor.open();
          },
          get count() {
            return returnCount();
          },
          onOpen: () => {
            const open = !resultOpen() || !!editor.open();
            editor.openFeature(undefined);
            setResultOpen(open);
          },
          onHover: setResultHovered,
        }}
      />
      <StatusBar model={model} notice={editor.notice()} reference={selectedName.name() ? { code: selectedName.name()!, selected: true } : hoverName.name() ? { code: hoverName.name()!, selected: false } : undefined} />
    </div>
  );
}
