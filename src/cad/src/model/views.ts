import type { CadModelDoc, CameraState, NamedView } from "../types.ts";

/**
 * Named views (research/18-named-views.md): cameras that belong to the model, kept in its document
 * next to the code, under `cad.views`. The edits below run inside a `change` of the model document.
 */

export const namedViews = (doc: CadModelDoc | undefined): NamedView[] => doc?.cad?.views ?? [];

/** `base`, or the first of `base 2`, `base 3`, … that no view is called. */
export function freeName(base: string, views: readonly NamedView[]): string {
  const taken = new Set(views.map((v) => v.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Why view `id` can't be called `name`, if it can't. */
export function nameProblem(views: readonly NamedView[], id: string, name: string): string | undefined {
  if (!name) return "A view needs a name";
  if (views.some((v) => v.id !== id && v.name === name)) return `There already is a view called ${name}`;
  return undefined;
}

export const newViewId = () => crypto.randomUUID().slice(0, 8);

/** A copy that shares no arrays with `camera`, which may be another document's. */
const copy = (camera: CameraState): CameraState => ({ ...camera, direction: [...camera.direction], target: [...camera.target] });

export function addView(doc: CadModelDoc, view: NamedView): void {
  // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
  if (!doc.cad) doc.cad = {};
  if (!doc.cad.views) doc.cad.views = [];
  doc.cad.views.push({ id: view.id, name: view.name, camera: copy(view.camera) });
}

export function renameView(doc: CadModelDoc, id: string, name: string): void {
  const view = doc.cad?.views?.find((v) => v.id === id);
  if (view && view.name !== name) view.name = name;
}

export function updateView(doc: CadModelDoc, id: string, camera: CameraState): void {
  const view = doc.cad?.views?.find((v) => v.id === id);
  if (view) view.camera = copy(camera);
}

export function removeView(doc: CadModelDoc, id: string): void {
  const views = doc.cad?.views;
  const at = views?.findIndex((v) => v.id === id) ?? -1;
  if (views && at >= 0) views.splice(at, 1);
}
