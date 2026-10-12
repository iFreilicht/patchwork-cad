import { render } from "solid-js/web";
import type { DocHandle } from "@automerge/automerge-repo";
import { CadEditor } from "../components/CadEditor.tsx";
import type { CadModelDoc } from "../types.ts";
import "../styles.css";

export default function mount(handle: DocHandle<CadModelDoc>, element: HTMLElement): () => void {
  return render(() => <CadEditor handle={handle} />, element);
}
