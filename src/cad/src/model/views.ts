import type { CadModelDoc, CameraState, NamedView, StoredCamera } from "../types.ts";

/**
 * Named views (research/18-named-views.md): cameras that belong to the model, kept in its document
 * next to the code, under `cad.views`. The edits below run inside a `change` of the model document.
 */

export const namedViews = (doc: CadModelDoc | undefined): NamedView<StoredCamera>[] => doc?.cad?.views ?? [];

/** The id of the Home view, which every model has: an embed of it names it so (research/18, "Home"). */
export const HOME = "home";

/** Sets where the Home view looks from; `undefined` resets it to the ViewCube's Home framing. */
export function setHome(doc: CadModelDoc, camera: CameraState | undefined): void {
  if (camera) {
    if (!doc.cad) doc.cad = {};
    doc.cad.home = copy(camera);
  } else if (doc.cad?.home) delete doc.cad.home;
}

/** Named things in the model document: views and configurations. */
type Named = { id: string; name: string };

/** `base`, or the first of `base 2`, `base 3`, … that none of `items` is called. */
export function freeName(base: string, items: readonly Named[]): string {
  const taken = new Set(items.map((v) => v.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Why item `id` can't be called `name`, if it can't. */
export function nameProblem(items: readonly Named[], id: string, name: string, noun = "view"): string | undefined {
  if (!name) return `A ${noun} needs a name`;
  if (items.some((v) => v.id !== id && v.name === name)) return `There already is a ${noun} called ${name}`;
  return undefined;
}

/** A new id, never the Home view's. */
export const newId = () => crypto.randomUUID().slice(0, 8);

/** A copy that shares nothing with `camera`, which may be another document's, and has no undefined fields, which Automerge rejects. */
export const copyCamera = (camera: CameraState): CameraState => JSON.parse(JSON.stringify(camera)) as CameraState;
const copy = copyCamera;

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
