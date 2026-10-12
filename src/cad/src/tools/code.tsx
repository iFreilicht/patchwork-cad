import { render } from "solid-js/web";
import type { DocHandle } from "@automerge/automerge-repo";
import { CodeEditor } from "../components/CodeEditor.tsx";
import type { CadModelDoc } from "../types.ts";
import "../styles.css";

/** The model's code alone, without a kernel: a building block for other tools (unlisted). */
export default function mount(handle: DocHandle<CadModelDoc>, element: HTMLElement): () => void {
  return render(
    () => (
      <div class="cad-model cad-model--code">
        <CodeEditor handle={handle} errorLine={undefined} />
      </div>
    ),
    element,
  );
}
