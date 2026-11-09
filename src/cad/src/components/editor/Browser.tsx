import { createSignal, For, Index, Show } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { dragDocument } from "../embed.ts";
import type { NamedViews } from "../namedViews.ts";
import { sameCamera } from "../Viewer.tsx";
import type { CameraState, Configuration, NamedView } from "../../types.ts";
import type { ParamsController } from "./parameters.ts";
import type { Bodies, BodyRow } from "./bodies.ts";
import { PickButton } from "./FeatureDialog.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { NameField } from "./NameField.tsx";
import type { Editor } from "./state.ts";

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

/** What the browser's rows share: the row being renamed, by its key, and opening a row's menu. */
interface RowState {
  renaming: () => string | undefined;
  setRenaming(key: string | undefined): void;
  openMenu(row: BodyRow, x: number, y: number): void;
}

/** The named views the browser lists (research/18-named-views.md, "In the editor"), and the camera they come from and go to. */
export interface ViewsSection {
  views: NamedViews;
  /** The camera the view shows now, for making or updating a view. */
  camera(): CameraState | undefined;
  /** The camera as the view last settled, reactively, to mark the view it is at. */
  current(): CameraState | undefined;
  goTo(view: NamedView): void;
  /** Creates an embed of the model seen from `view`, for dragging it out. */
  embed(view: NamedView): { url: AutomergeUrl; title: string } | undefined;
}

/**
 * One row: the eye and the name, which opens the body's last feature or picks it. Its context menu
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
  const select = () => {
    if (props.editor.pickingVersion()) {
      props.editor.setNotice(props.editor.pickVersion(props.row.version));
      return;
    }
    const entry = props.editor.timeline().entries.find((e) => e.kind === "feature" && e.names.includes(props.row.version));
    if (entry?.kind === "feature" && entry.type !== "body") props.editor.openFeature(entry);
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
 * its features; clicking it opens its last feature, or picks it. Its context menu renames it, and
 * hides or shows it.
 */
export function Browser(props: { editor: Editor; bodies: Bodies; views: ViewsSection; params: ParamsController; embedConfiguration: (configuration: Configuration) => { url: AutomergeUrl; title: string } | undefined }) {
  let aside!: HTMLElement;
  const [renaming, setRenaming] = createSignal<string>();
  /** The open context menu: its items, and the key of the row it is for. */
  const [menu, setMenu] = createSignal<{ key: string; label: string; items: MenuItem[]; x: number; y: number }>();
  const state: RowState = { renaming, setRenaming, openMenu: (row, x, y) => setMenu({ key: row.key, label: `Actions for ${row.name}`, items: menuItems(row), x, y }) };
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
        <ViewList section={props.views} editor={props.editor} renaming={renaming} setRenaming={setRenaming} openMenu={(m) => setMenu(m)} dragFrom={() => aside} />
        <ConfigurationList params={props.params} embed={props.embedConfiguration} editor={props.editor} renaming={renaming} setRenaming={setRenaming} openMenu={(m) => setMenu(m)} dragFrom={() => aside} />
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
 * "In the editor"): "+" adds one, a click picks it, and its context menu renames it (also F2 or a
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
  select(item: T): void;
  selectTitle(item: T): string;
  rename(item: T, to: string): string | undefined;
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
  const open = (item: T, x: number, y: number) =>
    props.openMenu({ key: keyOf(item), label: `Actions for ${props.noun} ${item.name}`, items: [{ label: "Rename", run: () => void queueMicrotask(() => props.setRenaming(keyOf(item))) }, ...props.actions(item)], x, y });
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
                data-current={props.current(item) ? "true" : undefined}
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
                    onClick={() => props.select(item)}
                    onDblClick={() => props.setRenaming(key)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        props.setRenaming(key);
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

/** The named views: "+" adds one from the current camera; a click goes to one; one can be updated to the current camera. */
function ViewList(props: { section: ViewsSection; editor: Editor; renaming: () => string | undefined; setRenaming(key: string | undefined): void; openMenu: OpenMenu; dragFrom: () => HTMLElement }) {
  const views = props.section.views;
  return (
    <NamedList<NamedView>
      heading="Views"
      noun="view"
      items={views.views()}
      addLabel="New view from the current camera"
      onAdd={() => {
        const camera = props.section.camera();
        return camera ? views.add(camera) : "The view hasn't shown the model yet";
      }}
      current={(view) => sameCamera(props.section.current(), view.camera)}
      select={(view) => props.section.goTo(view)}
      selectTitle={(view) => `Look from ${view.name}`}
      rename={(view, to) => views.rename(view.id, to)}
      actions={(view) => [
        {
          label: "Update to current view",
          run: () => {
            const camera = props.section.camera();
            if (camera) views.update(view.id, camera);
          },
        },
        { label: "Delete", danger: true, run: () => views.remove(view.id) },
      ]}
      embed={(view) => props.section.embed(view)}
      editor={props.editor}
      renaming={props.renaming}
      setRenaming={props.setRenaming}
      openMenu={props.openMenu}
      dragFrom={props.dragFrom}
    />
  );
}

/** The configurations (research/17-parameters.md): "+" keeps the shown values as one; a click shows the model with one, only for this user. */
function ConfigurationList(props: { params: ParamsController; embed: (configuration: Configuration) => { url: AutomergeUrl; title: string } | undefined; editor: Editor; renaming: () => string | undefined; setRenaming(key: string | undefined): void; openMenu: OpenMenu; dragFrom: () => HTMLElement }) {
  const configurations = props.params.configurations;
  return (
    <NamedList<Configuration>
      heading="Configurations"
      noun="configuration"
      items={configurations.list()}
      addLabel="New configuration from the values the model is shown with"
      onAdd={() => props.params.saveAs()}
      current={(c) => props.params.selected()?.id === c.id}
      select={(c) => props.params.select(props.params.selected()?.id === c.id ? undefined : c.id)}
      selectTitle={(c) => (props.params.selected()?.id === c.id ? `Show the defaults again, not ${c.name}` : `Show the model with ${c.name}, only for you`)}
      rename={(c, to) => configurations.rename(c.id, to)}
      actions={(c) => [
        {
          label: "Update to the values you try",
          run: async () => props.params.apply(c.id),
        },
        { label: "Delete", danger: true, run: () => configurations.remove(c.id) },
      ]}
      embed={props.embed}
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
