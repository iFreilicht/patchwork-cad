import { createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { annotationView, type AnnotationStore } from "./annotations.tsx";
import { threadView } from "./codeComments.ts";
import { Scrolled } from "./Scrolled.tsx";
import type { CommentStore } from "./comments.ts";

/** How wide the popover is at most, to keep it within the view. */
const WIDTH = 360;
/** Below this much room under its point, the popover opens above it if there is more room there. */
const MIN_BELOW = 240;
/** How far a pin reaches above the point it opens at (research/21, "Annotation"). */
const PIN_HEIGHT = 22;

/** An action below a thread or an annotation. */
type Action = { label: string; run: () => void };

/**
 * The threads on a timeline entry, or what is pinned to a face or edge or the model: threads, each
 * in Patchwork's `comment-thread` tool, then annotations, each in Patchwork's embed frame
 * (research/21, "Annotation"), each a bordered item of one scrolling list, and New comment below it.
 * In the editor it is the selected pin's dialog (`dialog`), which the selection opens and closes
 * (research/19); elsewhere a popover above or below a point in `wrap`'s coordinates, as high as the
 * view has room, which follows the pin it was opened at as the camera moves and closes on a click
 * outside or Escape. Threads started here and never written are removed when it closes. A press
 * outside that becomes a drag keeps it, e.g. a document dragged from Patchwork's sidebar into a
 * draft, which embeds it (research/21, "Dropping, pasting, inserting").
 */
export function CommentsPopover(props: {
  comments: CommentStore;
  /** The threads to show, by id. */
  threads: string[];
  /** Starts a thread on the target; without it, e.g. for threads whose target is gone, there is no New comment. */
  create?: (() => AutomergeUrl | undefined | Promise<AutomergeUrl | undefined>) | undefined;
  /** A line above a thread, e.g. what it was about, and buttons below it, by thread URL. */
  caption?: ((url: AutomergeUrl) => string | undefined) | undefined;
  actions?: ((url: AutomergeUrl) => Action[]) | undefined;
  /** Starts a thread at once, e.g. for a target without one. */
  createNow?: boolean;
  /** Annotations after the threads, by id, with a line above and buttons below each; hovering or focusing one tells `hover`. */
  annotations?: { ids: string[]; store: AnnotationStore; caption?: (id: string) => string | undefined; actions?: (id: string) => Action[]; hover?: ((id: string | undefined) => void) | undefined } | undefined;
  /** The key of the pin it was opened at, which a popover follows. */
  follow?: string | undefined;
  label: string;
  /** A dialog in the editor's dialog area, closed by the selection, with a close button that calls this. */
  dialog?: { onClose: () => void } | undefined;
  /** A popover's place and closing. */
  at?: { x: number; y: number };
  wrap?: HTMLElement;
  above?: boolean;
  onClose?: () => void;
}) {
  let el!: HTMLElement;
  const box = () => props.wrap?.getBoundingClientRect() ?? new DOMRect();
  /** Where it opens, and the view's box, followed every frame while it hangs from a pin. */
  const [place, setPlace] = createSignal({ at: props.at ?? { x: 0, y: 0 }, box: box() });
  let frame = 0;
  const follow = (key: string) => {
    const pin = props.wrap?.querySelector<HTMLElement>(`.cad-model__pin[data-key="${CSS.escape(key)}"]`);
    if (pin && !pin.hidden) {
      const r = pin.getBoundingClientRect();
      const b = box();
      const p = place();
      if (r.left !== p.at.x || r.bottom !== p.at.y || b.left !== p.box.left || b.top !== p.box.top || b.height !== p.box.height) setPlace({ at: { x: r.left, y: r.bottom }, box: b });
    }
    frame = requestAnimationFrame(() => follow(key));
  };
  if (props.follow && !props.dialog) {
    const key = props.follow;
    frame = requestAnimationFrame(() => follow(key));
  }
  const created: AutomergeUrl[] = [];
  /** A thread started here, shown at once, before the threads of the target catch up with it. */
  const [fresh, setFresh] = createSignal<AutomergeUrl[]>([]);
  let closed = false;
  const create = async () => {
    const url = await props.create?.();
    if (!url) return;
    // Closed meanwhile: the thread started for nothing goes again.
    if (closed) return props.comments.discardEmptyDraft(url);
    created.push(url);
    setFresh([...fresh(), url]);
  };
  const urls = () => [...new Set([...props.threads.map(props.comments.urlOf), ...fresh()])];
  /**
   * Where the last press outside was: its click closes the popover, unless it moved 4px or more, as
   * a drag that orbits keeps the editor's dialogs (research/19, "Closing"); a drag and drop doesn't click.
   */
  let pressedOutside: { x: number; y: number } | undefined;
  const press = (event: PointerEvent) => (pressedOutside = el.contains(event.target as Node) ? undefined : { x: event.clientX, y: event.clientY });
  const outside = (event: MouseEvent) => pressedOutside && Math.hypot(event.clientX - pressedOutside.x, event.clientY - pressedOutside.y) < 4 && !el.contains(event.target as Node) && props.onClose?.();
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Closing it is all Escape does: not the dialog, too.
    event.preventDefault();
    props.onClose?.();
  };
  onMount(() => {
    if (props.createNow) void create();
    if (props.dialog) return;
    // After the click that opened it.
    setTimeout(() => {
      document.addEventListener("pointerdown", press, true);
      document.addEventListener("click", outside, true);
      document.addEventListener("keydown", escape, true);
    });
  });
  onCleanup(() => {
    closed = true;
    cancelAnimationFrame(frame);
    props.annotations?.hover?.(undefined);
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", escape, true);
    for (const url of created) props.comments.discardEmptyDraft(url);
  });

  /**
   * A popover's place in `wrap`: below its point, or above it where there is more room, as high as
   * the tool has room there, e.g. above the timeline it was opened from.
   */
  const style = (): JSX.CSSProperties => {
    const { at, box: b } = place();
    const room = props.wrap?.closest(".cad-model")?.getBoundingClientRect() ?? b;
    // Opened from a button at the bottom, e.g. the model's pin or a timeline entry, it starts at the button's top; at a pin, above the pin.
    const top = props.above ? at.y : at.y - PIN_HEIGHT;
    const below = room.bottom - at.y;
    const up = props.above || (below < MIN_BELOW && top - room.top > below);
    const left = `${Math.max(0, Math.min(at.x - b.left, b.width - WIDTH))}px`;
    return up ? { left, bottom: `${b.bottom - top}px`, "max-height": `${top - room.top - 16}px` } : { left, top: `${at.y - b.top}px`, "max-height": `${below - 16}px` };
  };

  const buttons = (actions: Action[]) => (
    <Show when={actions.length}>
      <div class="cad-model__pin-actions">
        <For each={actions}>
          {(action) => (
            <button class="cad-editor__button" onClick={action.run}>
              {action.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
  const list = (
    <Scrolled class="cad-model__pin-list">
      <For each={urls()}>
        {(url) => (
          <div class="cad-model__pin-item" data-thread={url}>
            <Show when={props.caption?.(url)}>{(caption) => <p class="cad-model__comment-caption">{caption()}</p>}</Show>
            {threadView(url)}
            {buttons(props.actions?.(url) ?? [])}
          </div>
        )}
      </For>
      <For each={props.annotations?.ids ?? []}>
        {(id) => {
          const store = props.annotations!.store;
          const annotation = store.list().find((a) => a.id === id);
          // Made once per item: made in the JSX, it would be made anew, and the frame reset to its default tool, whenever an annotation changed, e.g. its tool was picked.
          const view = annotation && untrack(() => annotationView(annotation, store));
          const hover = (on: boolean) => props.annotations?.hover?.(on ? id : undefined);
          return (
            <Show when={view}>
              {(v) => (
                <div
                  class="cad-model__pin-item"
                  data-annotation={id}
                  onPointerEnter={() => hover(true)}
                  onPointerLeave={(event) => !event.currentTarget.contains(document.activeElement) && hover(false)}
                  onFocusIn={() => hover(true)}
                  onFocusOut={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && hover(false)}
                >
                  <Show when={props.annotations?.caption?.(id)}>{(caption) => <p class="cad-model__comment-caption">{caption()}</p>}</Show>
                  {v()}
                  {buttons(props.annotations?.actions?.(id) ?? [])}
                </div>
              )}
            </Show>
          );
        }}
      </For>
    </Scrolled>
  );
  const footer = (
    <Show when={props.create}>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" onClick={() => void create()}>
          New comment
        </button>
      </footer>
    </Show>
  );
  return (
    <Show
      when={props.dialog}
      fallback={
        <div ref={(e) => (el = e)} class="cad-model__comments-popover" role="dialog" aria-label={props.label} style={style()}>
          {list}
          {footer}
        </div>
      }
    >
      {(dialog) => (
        <section ref={(e) => (el = e)} class="cad-editor__dialog cad-editor__pin-dialog" role="dialog" aria-label={props.label} data-feature="pin">
          <header class="cad-editor__dialog-header">
            <strong>{props.label}</strong>
            <button class="cad-editor__link" aria-label="close" onClick={() => dialog().onClose()}>
              ×
            </button>
          </header>
          {list}
          {footer}
        </section>
      )}
    </Show>
  );
}
