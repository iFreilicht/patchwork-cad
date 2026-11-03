import { createSignal, For, onCleanup } from "solid-js";

export interface MenuItem {
  label: string;
  /** Runs the action; a message is why it didn't happen. */
  run: () => void | Promise<string | undefined>;
  danger?: boolean;
  /** Asks again before running, e.g. to delete. */
  confirm?: string;
}

/**
 * The context menu of a timeline entry or a body in the browser (research/11, "Context menu"):
 * opened with a right-click, a ⋯ button or the context-menu key or Shift+F10, operated with the
 * arrow keys, Enter and Escape. It is positioned in `wrap`, upwards from where it was asked for (the
 * timeline is at the bottom), or downwards.
 */
export function Menu(props: { items: MenuItem[]; label: string; at: { x: number; y: number }; wrap: HTMLElement; down?: boolean; onClose: (refocus: boolean) => void }) {
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
      style={{ left: `${Math.max(0, props.at.x - box.left)}px`, ...(props.down ? { top: `${props.at.y - box.top}px` } : { bottom: `${box.bottom - props.at.y}px` }) }}
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
