import { For } from "solid-js";
import { schemas, type FeatureType } from "@patchwork-cad/features/schema";
import type { Editor } from "./state.ts";

/** Adds features at the end of the timeline. */
export function Toolbar(props: { editor: Editor; codeOpen: boolean; onToggleCode: () => void }) {
  const types = Object.keys(schemas) as FeatureType[];
  return (
    <div class="cad-editor__toolbar" role="toolbar">
      <For each={types}>
        {(type) => (
          <button class="cad-editor__button" disabled={props.editor.syntaxError() !== undefined} onClick={() => props.editor.insert(type)}>
            {schemas[type].label}
          </button>
        )}
      </For>
      <span class="cad-editor__spacer" />
      <button class="cad-editor__button" aria-pressed={props.codeOpen} onClick={() => props.onToggleCode()}>
        Code
      </button>
    </div>
  );
}
