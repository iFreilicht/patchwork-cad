import type { JSX } from "solid-js";

/**
 * Renames something in place: Enter renames, Escape or leaving the field doesn't. `rename` resolves
 * to why not, which `onNotice` shows; the field stays open then.
 */
export function NameField(props: { from: string; rename: (to: string) => Promise<string | undefined>; onNotice: (why: string | undefined) => void; onDone: () => void; style?: JSX.CSSProperties }) {
  let busy = false;
  return (
    <input
      class="cad-editor__rename"
      aria-label={`New name for ${props.from}`}
      value={props.from}
      spellcheck={false}
      style={props.style}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.select();
        })
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") return props.onDone();
        if (event.key !== "Enter") return;
        // Else Enter's keypress activates the button that gets the focus back when the field closes.
        event.preventDefault();
        if (busy) return;
        busy = true;
        const to = event.currentTarget.value.trim();
        void props.rename(to).then((why) => {
          busy = false;
          props.onNotice(why);
          if (!why) props.onDone();
        });
      }}
      onBlur={() => !busy && props.onDone()}
    />
  );
}
