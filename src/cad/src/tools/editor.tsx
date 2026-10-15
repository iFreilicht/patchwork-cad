import { render } from "solid-js/web";
import type { DocHandle } from "@automerge/automerge-repo";
import { WysiwygEditor } from "../components/editor/WysiwygEditor.tsx";
import type { CadModelDoc } from "../types.ts";
import "../styles.css";

export default function mount(handle: DocHandle<CadModelDoc>, element: HTMLElement): () => void {
  return render(() => <WysiwygEditor handle={handle} element={element} />, element);
}
