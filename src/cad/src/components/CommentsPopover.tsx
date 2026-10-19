import { createSignal, For, onCleanup, onMount } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { threadView } from "./codeComments.ts";
import type { CommentStore } from "./comments.ts";

/**
 * The threads on a timeline entry or a face or edge, each in Patchwork's `comment-thread` tool, and
 * a button to start another. It opens above or below a point in `wrap`'s coordinates, and closes
 * on a click outside or Escape; threads started here and never written are removed then.
 */
export function CommentsPopover(props: {
  comments: CommentStore;
  /** The threads to show, by id. */
  threads: string[];
  /** Starts a thread on the target. */
  create: () => AutomergeUrl | undefined;
  /** Starts a thread at once, e.g. for a target without one. */
  createNow?: boolean;
  label: string;
  at: { x: number; y: number };
  wrap: HTMLElement;
  above: boolean;
  onClose: () => void;
}) {
  let el!: HTMLDivElement;
  const box = props.wrap.getBoundingClientRect();
  const created: AutomergeUrl[] = [];
  /** A thread started here, shown at once, before the threads of the target catch up with it. */
  const [fresh, setFresh] = createSignal<AutomergeUrl[]>([]);
  const create = () => {
    const url = props.create();
    if (!url) return;
    created.push(url);
    setFresh([...fresh(), url]);
  };
  const urls = () => [...new Set([...props.threads.map(props.comments.urlOf), ...fresh()])];
  const outside = (event: PointerEvent) => !el.contains(event.target as Node) && props.onClose();
  const escape = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
  onMount(() => {
    if (props.createNow) create();
    // After the click that opened it.
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", escape, true);
    });
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", escape, true);
    for (const url of created) props.comments.discardEmptyDraft(url);
  });
  return (
    <div
      ref={el}
      class="cad-model__comments-popover"
      role="dialog"
      aria-label={props.label}
      style={{ left: `${Math.max(0, props.at.x - box.left)}px`, ...(props.above ? { bottom: `${box.bottom - props.at.y}px` } : { top: `${props.at.y - box.top}px` }) }}
    >
      <For each={urls()}>{(url) => <div class="cad-model__comments-popover-thread">{threadView(url)}</div>}</For>
      <button class="cad-model__comment-new" onClick={create}>
        New comment
      </button>
    </div>
  );
}
