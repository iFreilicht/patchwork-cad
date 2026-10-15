import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { CadModelDoc, CadModelViewDoc, CameraState } from "../types.ts";

/** Creates a view document of `model`; it opens in the viewer. */
export function createViewDoc(model: AutomergeUrl, title: string, camera: CameraState): AutomergeUrl | undefined {
  const doc: CadModelViewDoc & { "@patchwork": { type: string } } = { "@patchwork": { type: "cad-model-view" }, title, model, camera };
  return globalThis.repo?.create(doc).url;
}

/** Creates view documents of `model` named after it and the view, for dragging out of the ViewCube. */
export const viewsOf = (model: DocHandle<CadModelDoc>) => (camera: CameraState, name: string) => {
  const title = `${model.doc()?.title || "CAD Model"} – ${name}`;
  const url = createViewDoc(model.url, title, camera);
  return url && { url, title };
};
