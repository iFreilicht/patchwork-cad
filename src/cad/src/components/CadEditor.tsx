import type { DocHandle } from "@automerge/automerge-repo";
import type { CadModelDoc } from "../types.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { createModel, modelAttributes } from "./createModel.ts";
import { StatusBar } from "./StatusBar.tsx";
import { Viewer } from "./Viewer.tsx";

/** The code editor next to the 3D view (tool `cad-model-code-preview`). */
export function CadEditor(props: { handle: DocHandle<CadModelDoc> }) {
  const model = createModel(props.handle);
  return (
    <div class="cad-model cad-model--code-preview" {...modelAttributes(model)}>
      <CodeEditor handle={props.handle} errorLine={model.error()?.line} />
      <Viewer shapes={model.shapes()} />
      <StatusBar model={model} />
    </div>
  );
}
