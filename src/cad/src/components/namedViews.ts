import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { DocHandle } from "@automerge/automerge-repo";
import { addView, freeName, nameProblem, namedViews, newId, removeView, renameView, setHome, updateView } from "../model/views.ts";
import type { CadModelDoc, CameraState, NamedView } from "../types.ts";
import { cameraOf } from "./framing.ts";
import { nearestRegion, regionName } from "./ViewCube.ts";

export interface NamedViews {
  views: Accessor<NamedView[]>;
  /** Where the Home view looks from, if it was changed (research/18, "Home"). */
  home: Accessor<CameraState | undefined>;
  /** Changes the Home view; `undefined` resets it to the ViewCube's Home framing. */
  setHome(camera: CameraState | undefined): void;
  /** Adds a view of `camera`, named after the ViewCube region it looks from, and returns it. */
  add(camera: CameraState): NamedView;
  /** Renames view `id`, or says why it can't. */
  rename(id: string, name: string): string | undefined;
  update(id: string, camera: CameraState): void;
  remove(id: string): void;
}

/** The named views of a model (research/18-named-views.md), following its document. */
export function createNamedViews(handle: DocHandle<CadModelDoc>): NamedViews {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));
  // Edits of the code mustn't look like a change of the views.
  // Cameras stored before research/20 read as the new form.
  const views = createMemo(() => namedViews(doc()).map((v) => ({ ...v, camera: cameraOf(v.camera) })), [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const home = createMemo(() => {
    const stored = doc()?.cad?.home;
    return stored && cameraOf(stored);
  }, undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  return {
    views,
    home,
    setHome: (camera) => handle.change((d) => setHome(d, camera)),
    add(camera) {
      const view = { id: newId(), name: freeName(regionName(nearestRegion(camera.direction)), namedViews(handle.doc())), camera };
      handle.change((d) => addView(d, view));
      return view;
    },
    rename(id, name) {
      const why = nameProblem(namedViews(handle.doc()), id, name);
      if (!why) handle.change((d) => renameView(d, id, name));
      return why;
    },
    update: (id, camera) => handle.change((d) => updateView(d, id, camera)),
    remove: (id) => handle.change((d) => removeView(d, id)),
  };
}
