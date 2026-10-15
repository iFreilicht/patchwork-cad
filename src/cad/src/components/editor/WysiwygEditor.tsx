import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import type { MeshedShape } from "../../kernel/protocol.ts";
import type { Span } from "../../model/analyze.ts";
import type { Entry, FeatureEntry } from "../../model/timeline.ts";
import type { CadModelDoc } from "../../types.ts";
import { CodeEditor, type RelatedSpan } from "../CodeEditor.tsx";
import { createModel, modelAttributes, type Model } from "../createModel.ts";
import { StatusBar } from "../StatusBar.tsx";
import { Viewer, type Entity, type Highlight } from "../Viewer.tsx";
import { FeatureDialog } from "./FeatureDialog.tsx";
import { createEditor, ownersOf } from "./state.ts";
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
 * The reference expression of a face or edge, e.g. `extrude1.side.front`, as a pick would write it
 * (research/12). `set` asks the worker for it after `delayMs`, so that a pointer moving across the
 * model doesn't flood the worker with requests.
 */
function createEntityName(model: Model, delayMs: number): { name: Accessor<string | undefined>; set: (entity: Entity | undefined) => void } {
  const [name, setName] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Entity | undefined;
  const set = (entity: Entity | undefined) => {
    clearTimeout(timer);
    current = entity;
    setName(undefined);
    if (!entity) return;
    timer = setTimeout(() => {
      model.engine.pick(entity.body, entity.kind, entity.index).then(
        (code) => current === entity && setName(code),
        () => undefined,
      );
    }, delayMs);
  };
  onCleanup(() => clearTimeout(timer));
  return { name, set };
}

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
  const [rolledBack, setRolledBack] = createSignal<MeshedShape[]>();
  createEffect(() => {
    const to = rollbackTo();
    const key = rollbackKey();
    model.last();
    if (!to || to === "nothing") {
      setRolledBack(to ? [] : undefined);
      return;
    }
    model.engine.rollback(to.feature, to.after).then(
      (shapes) => rollbackKey() === key && setRolledBack(shapes),
      () => setRolledBack(undefined),
    );
  });
  const shown = () => rolledBack() ?? model.shapes() ?? [];
  const references = (): Highlight[] =>
    rolledBack() && editor.pickTarget() ? (editor.open()?.trace?.refs ?? []).map((d) => ({ body: d.body, kind: d.kind, indices: d.matches, style: "accent" })) : [];

  // A hovered feature that made nothing in the shown bodies, e.g. one past the marker, or whose faces later features removed, is shown on its own result (research/12):
  // the body of that name, which owner names (ownersOf) are, too.
  let resultCache = new Map<string, Promise<MeshedShape | undefined>>();
  createEffect(() => {
    model.last();
    resultCache = new Map();
  });
  const [results, setResults] = createSignal<MeshedShape[]>([]);
  /** Counts requests, so that only the latest hover's answer shows. */
  let resultRequest = 0;
  createEffect(() => {
    const request = ++resultRequest;
    const names = editor.hoveredFeatures().filter((name) => model.trace().some((t) => t.results.includes(name)) && !shown().some((s) => s.features?.[name]));
    const requests = names.map((name) => {
      if (!resultCache.has(name)) resultCache.set(name, model.engine.result(name).catch(() => undefined));
      return resultCache.get(name)!;
    });
    void Promise.all(requests).then((found) => request === resultRequest && setResults(found.filter((s) => s !== undefined)));
  });
  /** What the features hovered in the timeline or code made: in the shown bodies, or else in their own results. */
  const featureHighlight = (): Highlight[] =>
    editor.hoveredFeatures().flatMap((name) => {
      const inShown = shown().filter((s) => s.features?.[name]);
      const sources = inShown.length ? inShown.map((s) => ({ s, own: false })) : results().filter((s) => s.features?.[name]).map((s) => ({ s, own: true }));
      return sources.flatMap(({ s, own }) => {
        const owned = s.features![name]!;
        const base = { body: s.body ?? s.name, style: "hover" as const, ...(own ? { shape: s } : {}) };
        return [
          { ...base, kind: "face" as const, indices: owned.faces },
          { ...base, kind: "edge" as const, indices: owned.edges },
        ];
      });
    });

  // Hovering a face or edge marks the features that made it in the timeline and code; the status bar names it, or the selected one.
  const hoverName = createEntityName(model, 100);
  const selectedName = createEntityName(model, 0);
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
      <div class="cad-editor__stage">
        <Viewer
          shapes={rolledBack() ?? model.shapes()}
          pick={editor.pickTarget()?.kind}
          onPick={pick}
          onHover={onHover}
          onSelect={selectedName.set}
          highlight={[...references(), ...featureHighlight()]}
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
          <CodeEditor
            handle={props.handle}
            errorLine={model.error()?.line}
            focus={codeFocus()}
            onFocusDone={() => setCodeFocus(undefined)}
            past={pastMarker()}
            related={relatedCode()}
            onHover={editor.setCodeHover}
            onCursor={editor.setCodeCursor}
            crossHover={viewHoveredCode()}
          />
        </div>
      </Show>
      <Timeline editor={editor} onOpenCode={openCode} />
      <StatusBar model={model} notice={editor.notice()} reference={selectedName.name() ? { code: selectedName.name()!, selected: true } : hoverName.name() ? { code: hoverName.name()!, selected: false } : undefined} />
    </div>
  );
}
