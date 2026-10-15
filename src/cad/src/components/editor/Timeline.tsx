import { createEffect, createSignal, For, Index, Match, onCleanup, Show, Switch, type JSX } from "solid-js";
import { schemas } from "@patchwork-cad/features/schema";
import type { FeatureTrace } from "../../kernel/protocol.ts";
import type { Entry, FeatureEntry, ScriptEntry } from "../../model/timeline.ts";
import type { Editor } from "./state.ts";
import markerSvg from "../../assets/timeline-marker.svg?raw";

// U+FE0E asks for the text form of each symbol: browsers may draw some as emoji, which ignore CSS colors.
const GLYPHS: Record<string, string> = { sketch: "✎\uFE0E", extrude: "⬆\uFE0E", fillet: "◜\uFE0E", chamfer: "◸\uFE0E" };

/** A feature's status in the timeline; an unused result greys out a feature that built fine. */
const status = (trace: FeatureTrace | undefined) => (!trace ? "not-run" : trace.status === "ok" && trace.unused ? "unused" : trace.status);

const UNUSED = "\nUnused: no later feature uses its result, and the model doesn't return it.";

/** Attributes and handlers every timeline entry gets from the timeline: position, drag and highlight state. */
type ItemProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;

function FeatureItem(props: { editor: Editor; entry: FeatureEntry; item: ItemProps }) {
  const label = () => schemas[props.entry.type].label;
  return (
    <button
      {...props.item}
      class="cad-editor__entry"
      data-kind="feature"
      data-name={props.entry.name}
      data-status={status(props.entry.trace)}
      aria-pressed={props.editor.open()?.name === props.entry.name}
      title={`${label()} ${props.entry.name}${props.entry.trace?.message ? `\n${props.entry.trace.message}` : ""}${props.entry.trace?.unused ? UNUSED : ""}`}
      onClick={() => props.editor.openFeature(props.editor.open()?.name === props.entry.name ? undefined : props.entry)}
    >
      <span class="cad-editor__glyph">{GLYPHS[props.entry.type]}</span>
      <span>{props.entry.name}</span>
    </button>
  );
}

/**
 * Code the timeline doesn't recognize as features (research/02, "Custom Script"). It lists the
 * feature calls the last build ran inside it, which is how references into it can be followed.
 */
function ScriptItem(props: { entry: ScriptEntry; onOpen: (entry: ScriptEntry) => void; item: ItemProps }) {
  const broken = () => props.entry.features.find((f) => status(f) !== "ok");
  return (
    <button
      {...props.item}
      class="cad-editor__entry cad-editor__entry--script"
      data-kind="script"
      data-lines={props.entry.lines.join("-")}
      data-status={broken() ? status(broken()) : "ok"}
      title={`Custom Script, lines ${props.entry.lines.join("–")}`}
      onClick={() => props.onOpen(props.entry)}
    >
      <span class="cad-editor__glyph">{"{ }"}</span>
      <span>
        lines {props.entry.lines[0]}–{props.entry.lines[1]}
      </span>
      <For each={props.entry.features}>
        {(f) => (
          <span class="cad-editor__ran" data-name={f.name} data-status={status(f)} title={`${f.type} ${f.name}${f.message ? `\n${f.message}` : ""}${f.unused ? UNUSED : ""}`}>
            {GLYPHS[f.type]} {f.name}
          </span>
        )}
      </For>
    </button>
  );
}

/** Pixels a pointer moves before a press on an entry becomes a drag. */
const DRAG_THRESHOLD = 5;

/** The marker's drawing (an SVG of the head and stem) in pixels per SVG unit; its stem is 2 units wide. */
const MARKER_SCALE = 1.5;
const MARKER_SIZE = { width: 8 * MARKER_SCALE, height: 23.333 * MARKER_SCALE };

/**
 * CSS order of the timeline's children: entry i at 10i + 5; in the gap before entry p, a drop
 * indicator before the marker at 10p + 1, the marker at 10p + 2, a drop indicator after it at 10p + 3.
 */
const ORDER = { entry: (i: number) => 10 * i + 5, marker: (p: number) => 10 * p + 2, drop: (p: number, afterMarker: boolean) => 10 * p + (afterMarker ? 3 : 1) };

/** Where a dragged entry would be dropped: before entry `position`, past the marker or not. */
interface Drop {
  position: number;
  pastMarker: boolean;
  blocked: string | undefined;
}

/**
 * The timeline: one entry per feature statement or Custom Script run, in text order, and the
 * timeline marker between them (research/07, "The timeline marker"). Entries are dragged to reorder
 * them within the range their dependencies allow ("Reordering"); hovering, dragging or opening one
 * marks what it depends on and what depends on it.
 */
export function Timeline(props: { editor: Editor; onOpenScript: (entry: ScriptEntry) => void }) {
  let nav!: HTMLElement;
  let wrap!: HTMLDivElement;
  let markerEl!: HTMLButtonElement;
  const editor = props.editor;
  const count = () => editor.timeline().entries.length;
  /** Where a dragged entry would go, if that changes anything. */
  const [drop, setDrop] = createSignal<Drop>();
  /** Where the marker is being dragged to. */
  const [markerDrag, setMarkerDrag] = createSignal<number>();
  const markerAt = () => markerDrag() ?? editor.marker();

  const entryElements = () => [...nav.querySelectorAll<HTMLElement>(".cad-editor__entry[data-index]")];
  const middle = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  };
  /** The gap nearest to `x`: before the first entry whose middle is right of it. */
  const gapAt = (x: number) => entryElements().filter((el) => middle(el) < x).length;

  /**
   * The layout when a drag starts. Drops are found in it, not in the current layout, which the drop
   * indicator changes as it moves, so that it doesn't jump back and forth.
   */
  let layout: { scroll: number; middles: number[]; marker: number } | undefined;

  let press: { index: number; x: number } | undefined;
  /** A drag ends with a click on the entry, which must not open it. */
  let suppressClick = false;
  const endDrag = () => {
    press = undefined;
    layout = undefined;
    editor.setDragging(undefined);
    setDrop(undefined);
  };

  /** The drop for entry `index` at `x`, or undefined if dropping there changes nothing. */
  const dropAt = (index: number, x: number): Drop | undefined => {
    if (!layout) return undefined;
    const at = x + nav.scrollLeft - layout.scroll;
    const position = layout.middles.filter((m) => m < at).length;
    const m = editor.marker();
    const pastMarker = position === m ? at > layout.marker : position > m;
    if ((position === index || position === index + 1) && pastMarker === index >= m) return undefined;
    return { position, pastMarker, blocked: editor.blocked(index, position) };
  };

  const item = (index: number): ItemProps => ({
    style: { order: ORDER.entry(index) },
    "data-index": String(index),
    get "data-past-marker"() {
      return index >= markerAt() ? "true" : undefined;
    },
    get "data-relation"() {
      return editor.related().get(index)?.relation;
    },
    get "data-link"() {
      return editor.related().get(index)?.link;
    },
    get "data-focused"() {
      return editor.focused() === index ? "true" : undefined;
    },
    get "data-dragging"() {
      return editor.dragging() === index ? "true" : undefined;
    },
    onPointerEnter: () => editor.setHovered(index),
    onPointerLeave: () => editor.setHovered(undefined),
    onFocus: () => editor.setHovered(index),
    onBlur: () => editor.setHovered(undefined),
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      suppressClick = false;
      press = { index, x: event.clientX };
      // At once: WebKit sends the moves after a press to the element under the pointer, not to the pressed one.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      if (!press) return;
      if (editor.dragging() === undefined) {
        if (Math.abs(event.clientX - press.x) < DRAG_THRESHOLD) return;
        layout = { scroll: nav.scrollLeft, middles: entryElements().map(middle), marker: middle(markerEl) };
        editor.setDragging(press.index);
        editor.setMoveError(undefined);
      }
      setDrop(dropAt(press.index, event.clientX));
    },
    onPointerUp: () => {
      const dragged = editor.dragging();
      const d = drop();
      endDrag();
      if (dragged === undefined) return;
      suppressClick = true;
      if (!d) return;
      if (d.blocked) editor.setMoveError(d.blocked);
      else void editor.move(dragged, d.position, d.pastMarker).then(editor.setMoveError);
    },
    onPointerCancel: endDrag,
  });
  // The click that ends a drag must not open the entry; this runs before Solid's delegated handlers.
  const swallowClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const markerKeys: Record<string, (at: number) => number> = {
    ArrowLeft: (at) => Math.max(0, at - 1),
    ArrowRight: (at) => Math.min(count(), at + 1),
    Home: () => 0,
    End: () => count(),
  };

  const markerDragHandlers = {
    onPointerDown: (event: PointerEvent & { currentTarget: Element }) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMarkerDrag(editor.marker());
    },
    onPointerMove: (event: PointerEvent) => markerDrag() !== undefined && setMarkerDrag(gapAt(event.clientX)),
    onPointerUp: () => {
      const to = markerDrag();
      setMarkerDrag(undefined);
      if (to !== undefined && to !== editor.marker()) editor.setMarker(to);
    },
    onPointerCancel: () => setMarkerDrag(undefined),
  };

  // The marker in the timeline is an invisible slot as wide as the drawing's stem; the drawing is
  // anchored to it above the layout, where the scrolling timeline doesn't clip its head.
  const [anchor, setAnchor] = createSignal<{ x: number; bottom: number }>();
  const place = () => {
    if (!markerEl || !nav || !wrap) return;
    const slot = markerEl.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const scroller = nav.getBoundingClientRect();
    const x = slot.left + slot.width / 2;
    setAnchor(x >= scroller.left && x <= scroller.right ? { x: x - box.left, bottom: slot.bottom - box.top } : undefined);
  };
  createEffect(() => {
    markerAt();
    drop();
    editor.timeline();
    requestAnimationFrame(place);
  });
  const observer = new ResizeObserver(place);
  queueMicrotask(() => {
    if (!nav) return;
    observer.observe(nav);
    nav.addEventListener("scroll", place);
  });
  onCleanup(() => {
    observer.disconnect();
    nav?.removeEventListener("scroll", place);
  });

  return (
    <div class="cad-editor__timeline-wrap" ref={wrap}>
      <nav
        class="cad-editor__timeline"
        aria-label="Timeline"
        ref={(el) => {
          nav = el;
          el.addEventListener("click", swallowClick, true);
        }}
      >
        {/* By position: entries are new objects after every change, and their buttons should stay. */}
        <Index each={editor.timeline().entries}>
          {(entry: () => Entry, index) => (
            <Switch>
              <Match when={entry().kind === "feature" && (entry() as FeatureEntry)}>{(e) => <FeatureItem editor={editor} entry={e()} item={item(index)} />}</Match>
              <Match when={entry().kind === "script" && (entry() as ScriptEntry)}>{(e) => <ScriptItem entry={e()} onOpen={props.onOpenScript} item={item(index)} />}</Match>
            </Switch>
          )}
        </Index>
        {/* One element, placed with CSS order, so that it keeps focus while it moves. */}
        <button
          ref={markerEl}
          class="cad-editor__marker"
          role="slider"
          aria-label="Timeline marker"
          aria-valuemin={0}
          aria-valuemax={count()}
          aria-valuenow={markerAt()}
          title="Timeline marker: drag it back to roll the model back; new features go here"
          style={{ order: ORDER.marker(markerAt()), width: `${2 * MARKER_SCALE}px` }}
          onKeyDown={(event) => {
            const to = markerKeys[event.key];
            if (!to) return;
            event.preventDefault();
            editor.setMarker(to(editor.marker()));
          }}
          {...markerDragHandlers}
        />
        <Show when={drop()}>
          {(d) => (
            <span
              class="cad-editor__drop"
              data-position={d().position}
              data-past-marker={d().pastMarker ? "true" : "false"}
              data-blocked={d().blocked ? "true" : undefined}
              title={d().blocked}
              style={{ order: ORDER.drop(d().position, d().pastMarker && d().position === editor.marker()) }}
            />
          )}
        </Show>
        <Show when={editor.marker() < count()}>
          <button class="cad-editor__to-end" style={{ order: ORDER.entry(count()) + 1 }} aria-label="Move the timeline marker to the end" title="Move the timeline marker to the end" onClick={() => editor.setMarker(count())}>
            ⏭{"\uFE0E"}
          </button>
        </Show>
      </nav>
      <Show when={anchor()}>
        {(a) => (
          <span
            class="cad-editor__marker-drawing"
            aria-hidden="true"
            innerHTML={markerSvg}
            style={{ left: `${a().x - MARKER_SIZE.width / 2}px`, top: `${a().bottom - MARKER_SIZE.height}px`, width: `${MARKER_SIZE.width}px`, height: `${MARKER_SIZE.height}px` }}
            {...markerDragHandlers}
          />
        )}
      </Show>
    </div>
  );
}
