import { createEffect, createSignal, For, Index, on, Show, untrack } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { dragDocument } from "../embed.ts";
import type { NamedViews } from "../namedViews.ts";
import { nearCamera } from "../Viewer.tsx";
import type { CameraState, Configuration, NamedView } from "../../types.ts";
import type { ParamsController } from "./parameters.ts";
import { HOME } from "../../model/views.ts";
import type { Bodies, BodyRow } from "./bodies.ts";
import { PickButton } from "./FeatureDialog.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { NameField } from "./NameField.tsx";
import type { Editor, Selectable } from "./state.ts";
import type { DocumentRow, Documents } from "./documents.ts";
import { Icon } from "../icons.tsx";

/** An eye, crossed out when hidden (lucide's eye and eye-off). */
export const EyeIcon = (props: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <Show
      when={props.open}
      fallback={
        <>
          <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
          <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
          <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
          <path d="m2 2 20 20" />
        </>
      }
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Show>
  </svg>
);

/** What the browser's rows share: the row being renamed, by its key, opening a row's menu, and collaborators' selections. */
interface RowState {
  renaming: () => string | undefined;
  setRenaming(key: string | undefined): void;
  openMenu(row: BodyRow, x: number, y: number): void;
  peers: () => BrowserPeer[];
}

/** A collaborator's selection, as the browser marks it: the timeline entry, view or configuration they selected. */
export interface BrowserPeer {
  color: string;
  entry?: number;
  view?: string;
  configuration?: string;
  document?: string;
}

/**
 * Selects an item with a click, or closes it with a click on it if it is selected; not with a double
 * click's second click, which renames it (research/19-selection.md, "The selection").
 */
const toggle = (editor: Editor, item: Selectable, event: MouseEvent, selected = editor.isSelected(item)) => {
  if (!selected) editor.select(item, "browser");
  else if (event.detail < 2) editor.select(undefined, "browser");
};

/** The named views the browser lists (research/18-named-views.md, "In the editor"), and the camera they come from and go to. */
export interface ViewsSection {
  views: NamedViews;
  /** The camera the view shows now, for making or updating a view. */
  camera(): CameraState | undefined;
  /** The camera as the view last settled, reactively, to mark the view it is at. */
  current(): CameraState | undefined;
  goTo(view: NamedView): void;
  /** Goes Home, as the ViewCube's Home button does. */
  goHome(): void;
  /** Where Home goes now, to mark it when the camera is there. */
  homeCamera(): CameraState | undefined;
  setHomeHovered(hovered: boolean): void;
  /** Creates an embed of the model seen from view `view` (Home's id is `HOME`), for dragging it out. */
  embed(view: { id: string; name: string }): { url: AutomergeUrl; title: string } | undefined;
}

/**
 * One row: the eye and the name, which selects the body's last feature, or picks it. Its context menu
 * (a right-click, the context-menu key or Shift+F10) renames it, also F2 or a double click: a
 * returned body's key, else its variable (research/15, "Output").
 */
function Row(props: { editor: Editor; bodies: Bodies; row: BodyRow; state: RowState }) {
  const renaming = () => props.state.renaming() === props.row.key;
  const setRenaming = (on: boolean) => props.state.setRenaming(on ? props.row.key : undefined);
  let li!: HTMLLIElement;
  /** Ends renaming, with the focus back on the name, as in the timeline. */
  const done = () => {
    setRenaming(false);
    queueMicrotask(() => li.querySelector<HTMLElement>(".cad-editor__browser-name")?.focus());
  };
  const label = () => props.row.name;
  const detail = () => (props.row.version !== props.row.name ? props.row.version : undefined);
  const pickable = () => props.editor.pickingVersion() && props.editor.pickable(props.row.version);
  /** The timeline entry that made the row's version. */
  const entry = () => props.editor.lanes()?.versions.get(props.row.version)?.entry;
  const selected = () => entry() !== undefined && props.editor.selectedIndex() === entry();
  const peer = () => props.state.peers().find((p) => p.entry !== undefined && p.entry === entry())?.color;
  const select = (event: MouseEvent) => {
    if (props.editor.pickingVersion()) {
      props.editor.setNotice(props.editor.pickVersion(props.row.version));
      return;
    }
    const index = entry();
    if (index !== undefined) toggle(props.editor, { kind: "entry", index }, event, selected());
  };
  const hover = () => props.editor.setHoveredLane({ lane: props.row.lane, version: props.row.version });
  return (
    <li
      ref={li}
      class="cad-editor__browser-row"
      data-kind={props.row.kind}
      data-key={props.row.key}
      data-name={label()}
      data-version={props.row.version}
      data-visible={props.row.visible ? "true" : "false"}
      data-pickable={props.editor.pickingVersion() ? (pickable() ? "true" : "false") : undefined}
      data-picked={props.editor.pickedVersions().includes(props.row.version) ? "true" : undefined}
      data-hovered={props.editor.highlightedLanes().has(props.row.lane) ? "true" : undefined}
      data-selected={selected() ? "true" : undefined}
      data-peer={peer() ? "true" : undefined}
      style={peer() ? { "--peer-color": peer() } : {}}
      onPointerEnter={hover}
      onPointerLeave={() => props.editor.setHoveredLane(undefined)}
      onContextMenu={(event) => {
        if (props.editor.pickingVersion() || renaming()) return;
        event.preventDefault();
        props.state.openMenu(props.row, event.clientX, event.clientY);
      }}
    >
      <button
        class="cad-editor__icon-button"
        aria-pressed={props.row.visible}
        aria-label={`${props.row.visible ? "Hide" : "Show"} ${label()}`}
        title={`${props.row.visible ? "Hide" : "Show"} ${label()} (only for you)`}
        onClick={() => props.bodies.setVisible(props.row, !props.row.visible)}
      >
        <EyeIcon open={props.row.visible} />
      </button>
      <Show
        when={!renaming()}
        fallback={<NameField from={label()} rename={(to) => props.editor.renameBody(props.row.name, props.row.output, to)} onNotice={props.editor.setNotice} onDone={done} />}
      >
        <button
          class="cad-editor__browser-name"
          title={detail() ? `${label()}, as of ${detail()}` : label()}
          disabled={props.editor.pickingVersion() && !pickable()}
          aria-pressed={selected()}
          onClick={select}
          onDblClick={() => !props.editor.pickingVersion() && setRenaming(true)}
          onKeyDown={(event) => {
            if (props.editor.pickingVersion()) return;
            if (event.key === "F2") {
              event.preventDefault();
              setRenaming(true);
            } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
              event.preventDefault();
              const r = event.currentTarget.getBoundingClientRect();
              props.state.openMenu(props.row, r.left, r.bottom);
            }
          }}
          onFocus={hover}
          onBlur={() => props.editor.setHoveredLane(undefined)}
        >
          <span>{label()}</span>
          <Show when={detail()}>
            <span class="cad-editor__muted">{detail()}</span>
          </Show>
        </button>
      </Show>
    </li>
  );
}

/** The rows of the bodies or the sketches at the marker. */
function BodyList(props: { editor: Editor; bodies: Bodies; kind: "body" | "sketch"; state: RowState }) {
  const rows = () => props.bodies.rows().filter((r) => r.kind === props.kind);
  return (
    <ul class="cad-editor__browser-list" aria-label={props.kind === "body" ? "Bodies" : "Sketches"}>
      {/* By position: rows are new objects after every build, and their buttons should stay, e.g. while clicked. */}
      <Index each={rows()} fallback={<li class="cad-editor__muted cad-editor__browser-empty">none</li>}>
        {(row) => <Row editor={props.editor} bodies={props.bodies} row={row()} state={props.state} />}
      </Index>
    </ul>
  );
}

/**
 * The browser (research/15, "The browser"): what exists at the timeline marker, with an eye that
 * shows or hides it for this user only. Before the return, that is every body and sketch that no
 * feature used yet; past it, what main returns. Hovering a row highlights the body, its lane and
 * its features; clicking it selects its last feature, or picks it. Its context menu renames it, and
 * hides or shows it. The rows of the selected item are marked, and scroll into view when it is
 * selected elsewhere (research/19-selection.md).
 */
export function Browser(props: {
  editor: Editor;
  bodies: Bodies;
  views: ViewsSection;
  params: ParamsController;
  documents: Documents;
  peers: BrowserPeer[];
  onHoverConfiguration: (hovered: boolean) => void;
  embedConfiguration: (configuration: Configuration | undefined) => { url: AutomergeUrl; title: string } | undefined;
}) {
  let aside!: HTMLElement;
  const [renaming, setRenaming] = createSignal<string>();
  /** The open context menu: its items, and the key of the row it is for. */
  const [menu, setMenu] = createSignal<{ key: string; label: string; items: MenuItem[]; x: number; y: number }>();
  const state: RowState = { renaming, setRenaming, openMenu: (row, x, y) => setMenu({ key: row.key, label: `Actions for ${row.name}`, items: menuItems(row), x, y }), peers: () => props.peers };
  createEffect(
    on(props.editor.selection, (s) => {
      if (!s || s.from === "browser") return;
      // Once the rows have followed it, e.g. a configuration chosen elsewhere.
      requestAnimationFrame(() => untrack(props.editor.selection) === s && aside.isConnected && aside.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }),
  );
  const nameOf = (key: string) => aside.querySelector<HTMLElement>(`.cad-editor__browser-row[data-key="${CSS.escape(key)}"] .cad-editor__browser-name`);
  /** Closes the menu, and gives the focus back to its row if it was operated with the keyboard. */
  const closeMenu = (refocus: boolean) => {
    const m = menu();
    setMenu(undefined);
    if (refocus && m) nameOf(m.key)?.focus();
  };
  // What main returns is the return entry's to edit, not the browser's (research/15, "Output").
  const menuItems = (row: BodyRow): MenuItem[] => [
    { label: "Rename", run: () => void queueMicrotask(() => setRenaming(row.key)) },
    { label: row.visible ? "Hide" : "Show", run: () => props.bodies.setVisible(row, !row.visible) },
  ];
  const at = () => {
    const n = props.editor.timeline().entries.length;
    if (props.editor.pickingAt() !== undefined) return `Before ${props.editor.open()?.name ?? "the open feature"}`;
    const marker = props.editor.marker();
    return marker > n ? "Returned" : marker === n ? "Before the return" : "At the timeline marker";
  };
  return (
    <>
      <aside class="cad-editor__browser" aria-label="Browser" ref={aside}>
        <p class="cad-editor__muted cad-editor__browser-note">{at()}</p>
        <h3 class="cad-editor__browser-heading">Bodies</h3>
        <BodyList editor={props.editor} bodies={props.bodies} kind="body" state={state} />
        <Show when={props.bodies.rows().some((r) => r.kind === "sketch")}>
          <h3 class="cad-editor__browser-heading">Sketches</h3>
          <BodyList editor={props.editor} bodies={props.bodies} kind="sketch" state={state} />
        </Show>
        <Show when={props.documents.rows().length > 0}>
          <DocumentList documents={props.documents} editor={props.editor} openMenu={(m) => setMenu(m)} peers={() => props.peers} />
        </Show>
        <ViewList section={props.views} editor={props.editor} renaming={renaming} setRenaming={setRenaming} openMenu={(m) => setMenu(m)} dragFrom={() => aside} peers={() => props.peers} />
        <ConfigurationList params={props.params} onHover={props.onHoverConfiguration} embed={props.embedConfiguration} editor={props.editor} renaming={renaming} setRenaming={setRenaming} openMenu={(m) => setMenu(m)} dragFrom={() => aside} peers={() => props.peers} />
      </aside>
      {/* In the editor, not the browser, which would clip it. */}
      <Show when={menu()}>{(m) => <Menu items={m().items} label={m().label} at={m()} wrap={aside.parentElement!} down onClose={closeMenu} />}</Show>
    </>
  );
}

/** A row's menu, as the browser opens it. */
type OpenMenu = (menu: { key: string; label: string; items: MenuItem[]; x: number; y: number }) => void;

/**
 * Named things of the model in the browser, named views and configurations (research/18-named-views.md,
 * "In the editor"): "+" adds one, a click selects it, and its context menu renames it (also F2 or a
 * double click) and has the given actions. The grip drags it out as an embed.
 */
function NamedList<T extends { id: string; name: string }>(props: {
  /** The heading, also the list's label. */
  heading: string;
  /** The kind, in labels: "view" or "configuration". */
  noun: string;
  items: T[];
  addLabel: string;
  onAdd(): T | string | undefined;
  current(item: T): boolean;
  /** As what it is selected (research/19-selection.md). */
  selectable(item: T): Selectable;
  /** Whether it is selected: as itself, or as what it stands for, e.g. the configuration the parameters are shown with. */
  selected(item: T): boolean;
  /** The colour of the first collaborator who has it selected. */
  peer(item: T): string | undefined;
  /** Selects it, beyond the selection, e.g. moving the camera to a view. */
  onSelect(item: T): void;
  /** What a click on it does while it is selected instead of closing it, if anything; whether it did. */
  again?(item: T): boolean;
  selectTitle(item: T): string;
  rename(item: T, to: string): string | undefined;
  /** The model's own items, Home and Defaults, which keep their name. */
  fixed(item: T): boolean;
  /** Called with the hovered item, and with `undefined` when none is. */
  onHover?(item: T | undefined): void;
  actions(item: T): MenuItem[];
  embed(item: T): { url: AutomergeUrl; title: string } | undefined;
  editor: Editor;
  renaming: () => string | undefined;
  setRenaming(key: string | undefined): void;
  openMenu: OpenMenu;
  dragFrom: () => HTMLElement;
}) {
  const keyOf = (item: T) => `${props.noun}:${item.id}`;
  const add = () => {
    const added = props.onAdd();
    if (typeof added === "string") return props.editor.setNotice(added);
    if (added) queueMicrotask(() => props.setRenaming(keyOf(added)));
  };
  const rename = (item: T) => !props.fixed(item) && props.setRenaming(keyOf(item));
  const open = (item: T, x: number, y: number) => {
    const items = [...(props.fixed(item) ? [] : [{ label: "Rename", run: () => void queueMicrotask(() => rename(item)) }]), ...props.actions(item)];
    if (items.length) props.openMenu({ key: keyOf(item), label: `Actions for ${props.noun} ${item.name}`, items, x, y });
  };
  return (
    <>
      <h3 class="cad-editor__browser-heading cad-editor__browser-heading--named">
        {props.heading}
        <button class="cad-editor__icon-button" aria-label={props.addLabel} title={props.addLabel} onClick={add}>
          +
        </button>
      </h3>
      <ul class="cad-editor__browser-list" aria-label={props.heading}>
        <For each={props.items} fallback={<li class="cad-editor__muted cad-editor__browser-empty">none</li>}>
          {(item) => {
            const key = keyOf(item);
            const renaming = () => props.renaming() === key;
            let li!: HTMLLIElement;
            const done = () => {
              props.setRenaming(undefined);
              queueMicrotask(() => li.querySelector<HTMLElement>(".cad-editor__browser-name")?.focus());
            };
            return (
              <li
                ref={li}
                class="cad-editor__browser-row cad-editor__named-row"
                data-kind={props.noun}
                data-key={key}
                data-name={item.name}
                data-fixed={props.fixed(item) ? "true" : undefined}
                data-current={props.current(item) ? "true" : undefined}
                data-selected={props.selected(item) ? "true" : undefined}
                data-peer={props.peer(item) ? "true" : undefined}
                style={props.peer(item) ? { "--peer-color": props.peer(item) } : {}}
                onPointerEnter={() => props.onHover?.(item)}
                onPointerLeave={() => props.onHover?.(undefined)}
                onContextMenu={(event) => {
                  if (renaming()) return;
                  event.preventDefault();
                  open(item, event.clientX, event.clientY);
                }}
              >
                <span
                  class="cad-editor__grip"
                  draggable="true"
                  aria-hidden="true"
                  title={`Drag ${item.name} into Patchwork to embed the model with it`}
                  onDragStart={(event) => {
                    const embed = props.embed(item);
                    if (!embed) return event.preventDefault();
                    dragDocument(event, { ...embed, type: "cad-model-embed" }, props.dragFrom());
                  }}
                >
                  ⠿
                </span>
                <Show when={!renaming()} fallback={<NameField from={item.name} rename={async (to) => props.rename(item, to)} onNotice={props.editor.setNotice} onDone={done} />}>
                  <button
                    class="cad-editor__browser-name"
                    title={props.selectTitle(item)}
                    aria-pressed={props.selected(item)}
                    onClick={(event) => {
                      const selected = props.selected(item);
                      if (selected && props.again?.(item)) return;
                      if (!selected) props.onSelect(item);
                      toggle(props.editor, props.selectable(item), event, selected);
                    }}
                    onDblClick={() => rename(item)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        rename(item);
                      } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                        event.preventDefault();
                        const r = event.currentTarget.getBoundingClientRect();
                        open(item, r.left, r.bottom);
                      }
                    }}
                  >
                    <span>{item.name}</span>
                  </button>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </>
  );
}

/** A named view or Home, whose camera is unset until it is changed (research/18, "Home"). */
export type ViewItem = { id: string; name: string; camera: CameraState | undefined };

/** Home and the named views, as the browser lists them. */
export const viewItems = (views: NamedViews): ViewItem[] => [{ id: HOME, name: "Home", camera: views.home() }, ...views.views()];

/** Moves the camera to a view. */
const goToView = (section: ViewsSection, view: ViewItem) => (view.camera ? section.goTo({ ...view, camera: view.camera }) : section.goHome());

/** What a view's dialog and context menu offer: updating it to the current camera, and deleting it, or for Home resetting it if it was changed. */
function viewActions(section: ViewsSection, view: ViewItem): (MenuItem & { disabled?: boolean })[] {
  const views = section.views;
  const update = () => {
    const camera = section.camera();
    if (!camera) return;
    if (view.id === HOME) views.setHome(camera);
    else views.update(view.id, camera);
  };
  return [
    { label: "Update to current view", run: update },
    view.id !== HOME
      ? { label: "Delete", danger: true, run: () => views.remove(view.id) }
      : {
          label: "Reset to default",
          disabled: !view.camera,
          run: () => {
            views.setHome(undefined);
            // Goes there, to show where that is, once the view knows Home moved.
            queueMicrotask(() => section.goHome());
          },
        },
  ];
}

/** A view's dialog (research/19-selection.md, "A view's dialog"): its name, and what its context menu offers. */
export function ViewDialog(props: { section: ViewsSection; view: ViewItem; onClose: () => void }) {
  return (
    <section class="cad-editor__dialog" aria-label={`View ${props.view.name}`} data-feature="view" data-view={props.view.id}>
      <header class="cad-editor__dialog-header">
        <strong>View</strong> <span>{props.view.name}</span>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <footer class="cad-editor__dialog-footer">
        <For each={viewActions(props.section, props.view)}>
          {(action) => (
            <button class="cad-editor__button" classList={{ "cad-editor__button--danger": !!action.danger }} disabled={action.disabled} onClick={() => void action.run()}>
              {action.label}
            </button>
          )}
        </For>
      </footer>
    </section>
  );
}

/**
 * The named views, Home first: "+" adds one from the current camera; a click goes to one; one can
 * be updated to the current camera, Home also reset to the ViewCube's framing.
 */
function ViewList(props: { section: ViewsSection; editor: Editor; renaming: () => string | undefined; setRenaming(key: string | undefined): void; openMenu: OpenMenu; dragFrom: () => HTMLElement; peers: () => BrowserPeer[] }) {
  const views = props.section.views;
  const items = () => viewItems(views);
  const current = (view: ViewItem) => nearCamera(props.section.current(), view.id === HOME ? props.section.homeCamera() : view.camera);
  return (
    <NamedList<ViewItem>
      heading="Views"
      noun="view"
      items={items()}
      addLabel="New view from the current camera"
      onAdd={() => {
        const camera = props.section.camera();
        return camera ? views.add(camera) : "The view hasn't shown the model yet";
      }}
      current={current}
      selectable={(view) => ({ kind: "view", id: view.id })}
      selected={(view) => props.editor.isSelected({ kind: "view", id: view.id })}
      peer={(view) => props.peers().find((p) => p.view === view.id)?.color}
      onSelect={(view) => goToView(props.section, view)}
      // Back to the selected view once the camera has left it: going there is what its row is for.
      again={(view) => !current(view) && (goToView(props.section, view), true)}
      selectTitle={(view) => `Look from ${view.name}`}
      rename={(view, to) => views.rename(view.id, to)}
      fixed={(view) => view.id === HOME}
      actions={(view) => viewActions(props.section, view).filter((a) => !a.disabled)}
      onHover={(view) => props.section.setHomeHovered(view?.id === HOME)}
      embed={(view) => props.section.embed({ id: view.id, name: view.name })}
      editor={props.editor}
      renaming={props.renaming}
      setRenaming={props.setRenaming}
      openMenu={props.openMenu}
      dragFrom={props.dragFrom}
    />
  );
}

/** The model's defaults in the configurations list: no configuration. */
const DEFAULTS: Configuration = { id: "", name: "Defaults", params: {} };

/** The configurations (research/17-parameters.md), Defaults first: "+" keeps the shown values as one; a click shows the model with one, only for this user. */
function ConfigurationList(props: {
  params: ParamsController;
  onHover: (hovered: boolean) => void;
  embed: (configuration: Configuration | undefined) => { url: AutomergeUrl; title: string } | undefined;
  editor: Editor;
  renaming: () => string | undefined;
  setRenaming(key: string | undefined): void;
  openMenu: OpenMenu;
  dragFrom: () => HTMLElement;
  peers: () => BrowserPeer[];
}) {
  const configurations = props.params.configurations;
  return (
    <NamedList<Configuration>
      heading="Configurations"
      noun="configuration"
      items={[DEFAULTS, ...configurations.list()]}
      addLabel="New configuration from the values the model is shown with"
      onAdd={() => props.params.saveAs()}
      current={(c) => (props.params.selected()?.id ?? "") === c.id}
      selectable={(c) => ({ kind: "configuration", id: c.id })}
      // The parameters entry selects the shown configuration's row (research/19-selection.md, "The selection").
      selected={(c) => props.editor.selection()?.kind === "params" ? (props.params.selected()?.id ?? "") === c.id : props.editor.isSelected({ kind: "configuration", id: c.id })}
      peer={(c) => props.peers().find((p) => p.configuration === c.id)?.color}
      onSelect={(c) => props.params.select(c.id || undefined)}
      selectTitle={(c) => `Show the model with ${c === DEFAULTS ? "its defaults" : c.name}, only for you`}
      rename={(c, to) => configurations.rename(c.id, to)}
      fixed={(c) => c === DEFAULTS}
      actions={(c) => (c === DEFAULTS ? [] : [{ label: "Delete", danger: true, run: () => configurations.remove(c.id) }])}
      onHover={(c) => props.onHover(!!c)}
      embed={(c) => props.embed(c === DEFAULTS ? undefined : c)}
      editor={props.editor}
      renaming={props.renaming}
      setRenaming={props.setRenaming}
      openMenu={props.openMenu}
      dragFrom={props.dragFrom}
    />
  );
}

/**
 * A returned version's chip: its key, and its variable if that differs. F2 or a double click on the
 * key renames it; × makes the version private.
 */
function OutputChip(props: { editor: Editor; output: string; name: string }) {
  const [renaming, setRenaming] = createSignal(false);
  return (
    <span class="cad-editor__version" data-kind={props.editor.lanes()?.versions.get(props.name)?.kind ?? "body"} data-key={props.output} title={props.output === props.name ? props.output : `${props.output}: ${props.name}`}>
      <Show
        when={!renaming()}
        fallback={<NameField from={props.output} rename={(to) => props.editor.renameOutput(props.output, to)} onNotice={props.editor.setNotice} onDone={() => setRenaming(false)} />}
      >
        <code
          tabindex="0"
          aria-label={`rename ${props.output}`}
          onDblClick={() => setRenaming(true)}
          onKeyDown={(event) => {
            if (event.key !== "F2") return;
            event.preventDefault();
            setRenaming(true);
          }}
        >
          {props.output}
        </code>
        <Show when={props.output !== props.name}>
          <span class="cad-editor__muted">{props.name}</span>
        </Show>
      </Show>
      <button class="cad-editor__link" aria-label={`remove ${props.output}`} onClick={() => props.editor.setOutput(props.name, false)}>
        ×
      </button>
    </span>
  );
}

/**
 * The return entry's dialog (research/15, "Output"): what main returns, a chip per name, filled by
 * picking any body or sketch in the view, the browser or the timeline.
 */
export function ResultDialog(props: { editor: Editor; onClose: () => void; onEditCode: () => void }) {
  const editable = () => props.editor.returnEditable();
  const code = () => {
    const span = props.editor.timeline().returned;
    return span ? props.editor.source().slice(span.start, span.end).replace(/^return\s*|;$/g, "") : "";
  };
  return (
    <section class="cad-editor__dialog" aria-label="Result" data-feature="return">
      <header class="cad-editor__dialog-header">
        <strong>Result</strong> <code>return</code>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <div class="cad-editor__field" data-param="return">
        <span>Returns</span>
        <div class="cad-editor__refs">
          <Show
            when={editable()}
            fallback={
              <span class="cad-editor__version" data-kind="code">
                <code>{code()}</code>
              </span>
            }
          >
            <Index each={props.editor.outputs()} fallback={<span class="cad-editor__muted">nothing</span>}>
              {(output) => <OutputChip editor={props.editor} output={output().key} name={output().name} />}
            </Index>
          </Show>
          <PickButton editor={props.editor} param="return" kind="version" multi disabled={!editable()} label="Select" />
        </div>
      </div>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" onClick={() => props.onEditCode()}>
          Edit code
        </button>
      </footer>
    </section>
  );
}

/** What a document row's context menu and the document dialog offer (research/21, "The documents list"). */
export function documentActions(documents: Documents, row: DocumentRow): (MenuItem & { disabled?: boolean })[] {
  const state = documents.state(row).state;
  const own = row.role === "import";
  return [
    { label: "Open", disabled: !row.doc, run: () => documents.open(row) },
    row.pinned ? { label: "Follow", disabled: !own, run: () => documents.follow(row) } : { label: "Pin to this version", disabled: !own || !documents.builtWith(row), run: () => documents.pin(row) },
    { label: "Update", disabled: !own || state !== "newer", run: () => documents.update(row) },
    { label: "Remove", danger: true, disabled: !documents.removable(row), run: () => documents.remove(row) },
  ];
}

/**
 * The documents the model refers to (research/21, "The documents list"): a row each, with its
 * datatype's icon, its title and the path it names, and its state; a click selects it, which opens
 * its dialog. Hovering or selecting a row highlights the features that use it, and hovering or
 * selecting a feature the rows of the documents it uses.
 */
function DocumentList(props: { documents: Documents; editor: Editor; openMenu: OpenMenu; peers: () => BrowserPeer[] }) {
  const open = (row: DocumentRow, x: number, y: number) => {
    const items = documentActions(props.documents, row).filter((a) => !a.disabled);
    if (items.length) props.openMenu({ key: `document:${row.id}`, label: `Actions for ${props.documents.title(row)}`, items, x, y });
  };
  return (
    <>
      <h3 class="cad-editor__browser-heading">Documents</h3>
      <ul class="cad-editor__browser-list" aria-label="Documents">
        {/* By position, as the bodies: rows are new objects after every edit, and their buttons should stay, e.g. while clicked. */}
        <Index each={props.documents.rows()}>
          {(row) => {
            const item = () => ({ kind: "document", id: row().id }) as const;
            const selected = () => props.editor.isSelected(item());
            const focused = () => props.editor.focused();
            const hovered = () => props.editor.hoveredDocument() === row().id || (focused() !== undefined && row().users.entries.includes(focused()!));
            const peer = () => props.peers().find((p) => p.document === row().id)?.color;
            const state = () => props.documents.state(row());
            const info = () => props.documents.info(row());
            const via = () => {
              const parent = props.documents.rows().find((r) => r.id === row().via);
              return parent && props.documents.title(parent);
            };
            return (
              <li
                class="cad-editor__browser-row cad-editor__document-row"
                data-kind="document"
                data-key={`document:${row().id}`}
                data-role={row().role}
                data-name={info().title}
                data-state={state().state}
                data-selected={selected() ? "true" : undefined}
                data-hovered={hovered() ? "true" : undefined}
                data-peer={peer() ? "true" : undefined}
                style={peer() ? { "--peer-color": peer() } : {}}
                onPointerEnter={() => props.editor.setHoveredDocument(row().id)}
                onPointerLeave={() => props.editor.setHoveredDocument(undefined)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  open(row(), event.clientX, event.clientY);
                }}
              >
                <span class="cad-editor__document-icon" title={info().datatype}>
                  <Icon name={info().icon} />
                </span>
                <button
                  class="cad-editor__browser-name"
                  title={`${props.documents.title(row())}${row().path ?? ""}${row().role === "indirect" ? `, imported by ${via() ?? "an imported file"}` : row().role === "link" ? ", linked to by a configuration" : ""}`}
                  aria-pressed={selected()}
                  onClick={(event) => toggle(props.editor, item(), event, selected())}
                  onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                      event.preventDefault();
                      const r = event.currentTarget.getBoundingClientRect();
                      open(row(), r.left, r.bottom);
                    }
                  }}
                  onFocus={() => props.editor.setHoveredDocument(row().id)}
                  onBlur={() => props.editor.setHoveredDocument(undefined)}
                >
                  <span>{props.documents.title(row())}</span>
                  <Show when={row().path}>
                    <span class="cad-editor__muted">{row().path}</span>
                  </Show>
                  <Show when={row().type}>
                    <span class="cad-editor__muted">{row().type}</span>
                  </Show>
                </button>
                <span class="cad-editor__document-state" data-state={state().state} title={state().label} aria-label={state().label} role="img">
                  <Icon name={state().icon} size={12} />
                </span>
              </li>
            );
          }}
        </Index>
      </ul>
    </>
  );
}
