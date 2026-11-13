import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

/** The thumb's least height in pixels. */
const MIN_THUMB = 24;

/**
 * A scrolling area with a scrollbar of its own, always shown and beside the content, not over it:
 * macOS overlays the browsers' scrollbars on the content and shows them only while scrolling, and
 * neither Chrome (once `scrollbar-color` is set) nor Firefox can be made to show them otherwise. Its
 * track scrolls the area with the wheel, as the content may take the wheel for itself, e.g. an
 * embedded document; a click on it pages, and its thumb drags.
 */
export function Scrolled(props: { class: string; children: JSX.Element }) {
  let area!: HTMLDivElement;
  let track!: HTMLDivElement;
  /** The thumb's place and size in the track, in pixels: as much of it as is shown, but at least big enough to grab. */
  const [thumb, setThumb] = createSignal({ top: 0, height: 0 });
  const update = () => {
    const { scrollTop, scrollHeight, clientHeight } = area;
    const room = track.clientHeight;
    const height = scrollHeight > clientHeight ? Math.max(MIN_THUMB, (clientHeight / scrollHeight) * room) : room;
    const top = scrollHeight > clientHeight ? (scrollTop / (scrollHeight - clientHeight)) * (room - height) : 0;
    setThumb({ top, height });
  };
  onMount(() => {
    // The content grows as embeds load and threads are written.
    const resized = new ResizeObserver(update);
    const observe = () => {
      resized.disconnect();
      resized.observe(area);
      resized.observe(track);
      for (const child of area.children) resized.observe(child);
      update();
    };
    const added = new MutationObserver(observe);
    added.observe(area, { childList: true });
    observe();
    onCleanup(() => {
      resized.disconnect();
      added.disconnect();
    });
  });

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    area.scrollTop += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  };
  let drag: { y: number; scrollTop: number } | undefined;
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const t = thumb();
    const thumbTop = track.getBoundingClientRect().top + t.top;
    const onThumb = event.clientY >= thumbTop && event.clientY <= thumbTop + t.height;
    if (!onThumb) {
      // A page towards the click.
      area.scrollTop += (event.clientY < thumbTop ? -1 : 1) * area.clientHeight * 0.9;
      return;
    }
    drag = { y: event.clientY, scrollTop: area.scrollTop };
    track.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    // The thumb follows the pointer: its free room in the track is the area's scrollable height.
    const free = track.clientHeight - thumb().height;
    if (free > 0) area.scrollTop = drag.scrollTop + ((event.clientY - drag.y) / free) * (area.scrollHeight - area.clientHeight);
  };
  const onPointerUp = () => (drag = undefined);

  return (
    <div class="cad-model__scrolled">
      <div ref={area} class={`cad-model__scrolled-area ${props.class}`} onScroll={update}>
        {props.children}
      </div>
      <div ref={track} class="cad-model__scrollbar" aria-hidden="true" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div class="cad-model__scrollbar-thumb" style={{ top: `${thumb().top}px`, height: `${thumb().height}px` }} />
      </div>
    </div>
  );
}
