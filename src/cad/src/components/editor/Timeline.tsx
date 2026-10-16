import { createEffect, createSignal, For, Index, Match, onCleanup, Show, Switch, type JSX } from "solid-js";
import { schemas } from "@patchwork-cad/features/schema";
import type { FeatureTrace } from "../../kernel/protocol.ts";
import type { Span } from "../../model/analyze.ts";
import type { Entry, FeatureEntry, ScriptEntry } from "../../model/timeline.ts";
import type { Editor } from "./state.ts";
import { ContactToken } from "../presence.ts";
import markerSvg from "../../assets/timeline-marker.svg?raw";

// U+FE0E asks for the text form of each symbol: browsers may draw some as emoji, which ignore CSS colors.
const GLYPHS: Record<string, string> = { sketch: "✎\uFE0E", extrude: "⬆\uFE0E", fillet: "◜\uFE0E", chamfer: "◸\uFE0E", body: "◆\uFE0E" };

/** A feature's status in the timeline; an unused result greys out a feature that built fine. */
const status = (trace: FeatureTrace | undefined) => (!trace ? "not-run" : trace.status === "ok" && trace.unused ? "unused" : trace.status);

const UNUSED = "\nUnused: no later feature uses its result, and the model doesn't return it.";

/** Attributes and handlers every timeline entry gets from the timeline: position, drag and highlight state. */
type ItemProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;

/**
 * A feature statement. Selecting it opens its dialog; a body() (research/11) has no form, so
 * selecting it opens its code.
 */
function FeatureItem(props: { editor: Editor; entry: FeatureEntry; item: ItemProps; onOpenCode: (span: Span) => void }) {
  const label = () => schemas[props.entry.type].label;
  const names = () => props.entry.names.join(", ");
  return (
    <button
      {...props.item}
      class="cad-editor__entry"
      data-kind="feature"
      data-type={props.entry.type}
      data-name={props.entry.name}
      data-status={status(props.entry.trace)}
      aria-pressed={props.editor.open()?.name === props.entry.name}
      title={`${label()} ${names()}${props.entry.trace?.message ? `\n${props.entry.trace.message}` : ""}${props.entry.trace?.unused ? UNUSED : ""}`}
      onClick={() => {
        if (props.entry.type === "body") return props.onOpenCode(props.entry.span);
        props.editor.openFeature(props.editor.open()?.name === props.entry.name ? undefined : props.entry);
      }}
    >
      <span class="cad-editor__glyph">{GLYPHS[props.entry.type]}</span>
      <span>{names()}</span>
    </button>
  );
}

/**
 * Code the timeline doesn't recognize as features (research/02, "Custom Script"). It lists the
 * feature calls the last build ran inside it, which is how references into it can be followed.
 */
function ScriptItem(props: { entry: ScriptEntry; onOpen: (span: Span) => void; item: ItemProps }) {
  const broken = () => props.entry.features.find((f) => status(f) !== "ok");
  return (
    <button
      {...props.item}
      class="cad-editor__entry cad-editor__entry--script"
      data-kind="script"
      data-lines={props.entry.lines.join("-")}
      data-status={broken() ? status(broken()) : "ok"}
      title={`Custom Script, lines ${props.entry.lines.join("–")}`}
      onClick={() => props.onOpen(props.entry.span)}
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

/** A collaborator in the timeline: where their marker is, and the entries they hover or have open. */
export interface TimelinePeer {
  key: string;
  color: string;
  contactUrl: string;
  marker: number;
  entries: Set<number>;
}

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
export function Timeline(props: { editor: Editor; onOpenCode: (span: Span) => void; peers?: TimelinePeer[] }) {
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

  /** The open context menu: whose, and where it was asked for. */
  const [menu, setMenu] = createSignal<{ index: number; x: number; y: number }>();
  /** The entry that has the keyboard focus. */
  const [keyboard, setKeyboard] = createSignal<number>();
  /** The Custom Script or body() last selected, which has no dialog to show that it is. */
  const [picked, setPicked] = createSignal<number>();
  /**
   * The selected entry, which shows the ⋯ button of its context menu: the one whose menu is open,
   * that has the keyboard focus, or that was selected, a feature by its open dialog.
   */
  const active = () => {
    const open = editor.timeline().entries.findIndex((e) => e === editor.open());
    return menu()?.index ?? keyboard() ?? picked() ?? (open < 0 ? undefined : open);
  };
  // Using the pointer ends a selection by keyboard focus, and selecting anything else unselects a
  // Custom Script or a body().
  const unpick = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target?.closest(".cad-editor__more, .cad-editor__menu")) setKeyboard(undefined);
    if (!target?.closest(".cad-editor__entry, .cad-editor__more, .cad-editor__menu")) setPicked(undefined);
  };
  document.addEventListener("pointerdown", unpick, true);
  onCleanup(() => document.removeEventListener("pointerdown", unpick, true));
  /** The variable being renamed in place. */
  const [renaming, setRenaming] = createSignal<{ index: number; from: string }>();
  /** An entry whose deletion waits for a second Delete. */
  let pendingDelete: number | undefined;
  const entryAt = (index: number) => editor.timeline().entries[index];
  const entryLabel = (index: number) => {
    const e = entryAt(index);
    return !e ? "" : e.kind === "feature" ? e.names.join(", ") : `the Custom Script at lines ${e.lines.join("–")}`;
  };
  const entryElement = (index: number) => nav.querySelector<HTMLElement>(`.cad-editor__entry[data-index="${index}"]`);
  const openMenu = (index: number, x: number, y: number) => setMenu({ index, x, y });
  /** Closes the menu, and gives the focus back to its entry if it was operated with the keyboard. */
  const closeMenu = (refocus: boolean) => {
    const m = menu();
    setMenu(undefined);
    if (refocus && m) entryElement(m.index)?.focus();
  };
  const startRename = (index: number, from: string) => void setRenaming({ index, from });
  const endRename = (index: number) => {
    setRenaming(undefined);
    queueMicrotask(() => entryElement(index)?.focus());
  };
  /** Runs an action of the editor and shows why it didn't happen, if it didn't. */
  const report = (action: Promise<string | undefined>) => void action.then(editor.setNotice);

  /** The context menu's actions for an entry: secondary ones; selecting the entry opens it. */
  const menuItems = (index: number): MenuItem[] => {
    const e = entryAt(index);
    if (!e) return [];
    const items: MenuItem[] = [];
    if (e.kind === "feature" && e.type !== "body") items.push({ label: "Edit", run: () => editor.openFeature(e) });
    items.push({ label: "Edit code", run: () => props.onOpenCode(e.span) });
    items.push({ label: "Roll back to here", run: () => editor.setMarker(index + 1) });
    if (e.kind === "feature") for (const name of e.names) items.push({ label: e.names.length > 1 ? `Rename ${name}` : "Rename", run: () => startRename(index, name) });
    if (e.kind === "script") items.push({ label: "Wrap in body()", run: () => report(editor.wrap(index)) });
    if (e.kind === "feature" && e.type === "body") items.push({ label: "Unwrap", run: () => report(editor.unwrap(index)) });
    items.push({ label: "Delete", confirm: `Delete ${entryLabel(index)}`, danger: true, run: () => report(editor.remove(index)) });
    return items;
  };

  /** Keys on a focused entry: its context menu, F2 to rename, Delete twice to delete. */
  const entryKeys = (index: number, event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    const e = entryAt(index);
    if (!e) return;
    if (event.key !== "Delete") pendingDelete = undefined;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const r = event.currentTarget.getBoundingClientRect();
      openMenu(index, r.left, r.top);
    } else if (event.key === "F2" && e.kind === "feature") {
      event.preventDefault();
      startRename(index, e.name);
    } else if (event.key === "Delete") {
      event.preventDefault();
      if (pendingDelete === index) {
        pendingDelete = undefined;
        report(editor.remove(index));
      } else {
        pendingDelete = index;
        editor.setNotice(`Press Delete again to delete ${entryLabel(index)}.`);
      }
    }
  };

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

  /** The colour of the first collaborator who hovers or has open entry `index`. */
  const peerColor = (index: number) => props.peers?.find((p) => p.entries.has(index))?.color;
  const item = (index: number): ItemProps => ({
    get style() {
      const color = peerColor(index);
      return { order: ORDER.entry(index), ...(color ? { "--peer-color": color } : {}) };
    },
    get "data-peer"() {
      return peerColor(index) ? "true" : undefined;
    },
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
    get "data-cross-hover"() {
      return editor.crossHovered().has(index) ? "true" : undefined;
    },
    get "data-dragging"() {
      return editor.dragging() === index ? "true" : undefined;
    },
    onPointerEnter: () => editor.setHovered(index),
    onPointerLeave: () => editor.setHovered(undefined),
    onFocus: (event) => {
      editor.setHovered(index);
      // Only keyboard focus: a click focuses a button in some browsers, and selects in its own way.
      if (event.currentTarget.matches(":focus-visible")) setKeyboard(index);
    },
    onBlur: () => {
      editor.setHovered(undefined);
      setKeyboard(undefined);
      pendingDelete = undefined;
    },
    onKeyDown: (event) => entryKeys(index, event),
    onContextMenu: (event) => {
      event.preventDefault();
      openMenu(index, event.clientX, event.clientY);
    },
    onPointerDown: (event) => {
      const e = entryAt(index);
      setPicked(e && (e.kind === "script" || e.type === "body") ? index : undefined);
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
        editor.setNotice(undefined);
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
      if (d.blocked) editor.setNotice(d.blocked);
      else void editor.move(dragged, d.position, d.pastMarker).then(editor.setNotice);
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
  // anchored to it above the layout, where the scrolling timeline doesn't clip its head. The ⋯
  // button of the selected entry floats above it the same way, so that it shifts no entries.
  const [anchor, setAnchor] = createSignal<{ x: number; bottom: number }>();
  const [moreAt, setMoreAt] = createSignal<{ right: number; top: number }>();
  /** Where collaborators' markers are, for their names above the timeline, by key. */
  const [peerAt, setPeerAt] = createSignal<Record<string, { x: number; top: number }>>({});
  const place = () => {
    if (!markerEl || !nav || !wrap) return;
    const slot = markerEl.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const scroller = nav.getBoundingClientRect();
    const x = slot.left + slot.width / 2;
    setAnchor(x >= scroller.left && x <= scroller.right ? { x: x - box.left, bottom: slot.bottom - box.top } : undefined);
    const index = active();
    const entry = index === undefined || renaming() ? null : entryElement(index);
    const r = entry?.getBoundingClientRect();
    setMoreAt(r && r.right > scroller.left && r.right <= scroller.right ? { right: r.right - box.left, top: r.top - box.top } : undefined);
    const peers: Record<string, { x: number; top: number }> = {};
    for (const el of nav.querySelectorAll<HTMLElement>(".cad-editor__peer-marker")) {
      const p = el.getBoundingClientRect();
      if (p.left >= scroller.left && p.left <= scroller.right) peers[el.dataset["key"]!] = { x: p.left - box.left, top: p.top - box.top };
    }
    setPeerAt(peers);
  };
  createEffect(() => {
    markerAt();
    drop();
    active();
    renaming();
    editor.timeline();
    props.peers?.map((p) => p.marker);
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
              <Match when={renaming()?.index === index && renaming()}>{(r) => <RenameField editor={editor} index={index} from={r().from} onDone={() => endRename(index)} />}</Match>
              <Match when={entry().kind === "feature" && (entry() as FeatureEntry)}>{(e) => <FeatureItem editor={editor} entry={e()} item={item(index)} onOpenCode={props.onOpenCode} />}</Match>
              <Match when={entry().kind === "script" && (entry() as ScriptEntry)}>{(e) => <ScriptItem entry={e()} onOpen={props.onOpenCode} item={item(index)} />}</Match>
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
        {/* By position, so that the name tokens don't remount on every update. */}
        <Index each={props.peers ?? []}>
          {(peer) => (
            <span class="cad-editor__peer-marker" data-key={peer().key} data-position={peer().marker} data-contact={peer().contactUrl} style={{ order: ORDER.marker(peer().marker), "--peer-color": peer().color }} />
          )}
        </Index>
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
      <Show when={moreAt() !== undefined && active() !== undefined && active()! < count()}>
        <button
          class="cad-editor__more"
          aria-label={`Actions for ${entryLabel(active()!)}`}
          aria-haspopup="menu"
          aria-expanded={menu()?.index === active()}
          title={`Actions for ${entryLabel(active()!)}`}
          style={{ left: `${moreAt()!.right}px`, top: `${moreAt()!.top}px` }}
          onClick={(event) => {
            const r = event.currentTarget.getBoundingClientRect();
            openMenu(active()!, r.left, r.top);
          }}
        >
          ⋯
        </button>
      </Show>
      <Index each={props.peers ?? []}>
        {(peer) => (
          <Show when={peerAt()[peer().key]}>
            {(at) => (
              <span class="cad-editor__peer-name" style={{ left: `${at().x}px`, top: `${at().top}px`, "--peer-color": peer().color }}>
                <ContactToken contactUrl={peer().contactUrl} />
              </span>
            )}
          </Show>
        )}
      </Index>
      <Show when={menu()}>{(m) => <Menu items={menuItems(m().index)} label={`Actions for ${entryLabel(m().index)}`} at={m()} wrap={wrap} onClose={closeMenu} />}</Show>
    </div>
  );
}

interface MenuItem {
  label: string;
  /** Runs the action; a message is why it didn't happen. */
  run: () => void | Promise<string | undefined>;
  danger?: boolean;
  /** Asks again before running, e.g. to delete. */
  confirm?: string;
}

/**
 * The context menu of a timeline entry (research/11, "Context menu"): opened with a right-click, the
 * ⋯ button or the context-menu key or Shift+F10, operated with the arrow keys, Enter and Escape.
 */
function Menu(props: { items: MenuItem[]; label: string; at: { x: number; y: number }; wrap: HTMLElement; onClose: (refocus: boolean) => void }) {
  let el!: HTMLDivElement;
  const [confirming, setConfirming] = createSignal<string>();
  const box = props.wrap.getBoundingClientRect();
  const focusItem = (delta: number | "first" | "last") => {
    const items = [...el.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = delta === "first" ? 0 : delta === "last" ? items.length - 1 : (at + delta + items.length) % items.length;
    items[next]?.focus();
  };
  const outside = (event: PointerEvent) => {
    if (!el.contains(event.target as Node)) props.onClose(false);
  };
  queueMicrotask(() => {
    focusItem("first");
    document.addEventListener("pointerdown", outside, true);
  });
  // WebKit sometimes moves the focus back after the key that opened the menu: focus again once it has rendered.
  requestAnimationFrame(() => el.isConnected && !el.contains(document.activeElement) && focusItem("first"));
  onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  const keys: Record<string, () => void> = {
    ArrowDown: () => focusItem(1),
    ArrowUp: () => focusItem(-1),
    Home: () => focusItem("first"),
    End: () => focusItem("last"),
    Escape: () => props.onClose(true),
    Tab: () => props.onClose(false),
  };
  return (
    <div
      ref={el}
      class="cad-editor__menu"
      role="menu"
      aria-label={props.label}
      // It opens upwards from where it was asked for: the timeline is at the bottom.
      style={{ left: `${Math.max(0, props.at.x - box.left)}px`, bottom: `${box.bottom - props.at.y}px` }}
      onKeyDown={(event) => {
        const key = keys[event.key];
        if (!key) return;
        event.preventDefault();
        key();
      }}
    >
      <For each={props.items}>
        {(item) => (
          <button
            role="menuitem"
            tabIndex={-1}
            class="cad-editor__menu-item"
            data-danger={item.danger ? "true" : undefined}
            onClick={() => {
              if (item.confirm && confirming() !== item.label) {
                setConfirming(item.label);
                return;
              }
              props.onClose(true);
              void item.run();
            }}
          >
            {item.confirm && confirming() === item.label ? item.confirm : item.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** Renames a variable of an entry in place; Enter renames, Escape or leaving the field doesn't. */
function RenameField(props: { editor: Editor; index: number; from: string; onDone: () => void }) {
  let busy = false;
  return (
    <input
      class="cad-editor__rename"
      aria-label={`New name for ${props.from}`}
      value={props.from}
      spellcheck={false}
      style={{ order: ORDER.entry(props.index) }}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.select();
        })
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") return props.onDone();
        if (event.key !== "Enter" || busy) return;
        busy = true;
        const to = event.currentTarget.value.trim();
        void props.editor.rename(props.index, props.from, to).then((why) => {
          busy = false;
          props.editor.setNotice(why);
          if (!why) props.onDone();
        });
      }}
      onBlur={() => !busy && props.onDone()}
    />
  );
}
