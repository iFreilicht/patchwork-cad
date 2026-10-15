import { render } from "solid-js/web";
import type { DocHandle } from "@automerge/automerge-repo";
import { createModel, modelAttributes } from "../components/createModel.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { createUiState } from "../components/uiState.ts";
import { Viewer } from "../components/Viewer.tsx";
import type { CadModelDoc } from "../types.ts";
import "../styles.css";

const VIEWER_TOOL_ID = "cad-model-viewer";

/** The model's 3D view alone, read-only: for embedding a model in other documents and as a building block. */
export default function mount(handle: DocHandle<CadModelDoc>, element: HTMLElement): () => void {
  return render(() => {
    const model = createModel(handle);
    const ui = createUiState(element, handle.url);
    return (
      <div class="cad-model cad-model--viewer" {...modelAttributes(model)}>
        <Viewer shapes={model.shapes()} view={ui.view(VIEWER_TOOL_ID)} onViewChange={(view) => ui.setView(VIEWER_TOOL_ID, view)} />
        <StatusBar model={model} />
      </div>
    );
  }, element);
}
