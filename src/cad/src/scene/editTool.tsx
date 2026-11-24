// Editing a CAD model where it stands in a scene (`scene:view` "cad-model-scene-edit"): the model's
// Open (the inspector's button, the menu, a double-click or Enter in Edit) puts a hand on the scene's stack, hides the object's built GLB from this
// viewer, and draws the editor's live build in its place (sceneViewer.ts), with the editor's panels
// laid over the scene's view. Escape steps out of the editor's picking and selection first, then
// puts the hand down. The scene's contract: patchwork-experiments/scene, STAGE.md ("View plugins",
// "Hands") and EDITOR.md ("A command", "Undo": the editor's writes are steps of the scene's undo).

import { render } from "solid-js/web";
import type { DocHandle } from "@automerge/automerge-repo";
import { WysiwygEditor, type EditorControls } from "../components/editor/WysiwygEditor.tsx";
import { UNDO_IGNORE } from "../model/locks.ts";
import type { CadModelDoc } from "../types.ts";
import { sceneView, type HandEvent, type SceneView } from "./sceneViewer.ts";
import "../styles.css";

/** The scene source whose objects this edits (index.ts). */
export const SOURCE_ID = "cad-model-scene";

/** The parts of the scene's api this uses: the view plugin's, and its focus stage's (`api.focus()`). */
type Stage = {
  THREE: SceneViewTHREE;
  signal: AbortSignal;
  repo: { find(url: string): Promise<DocHandle<CadModelDoc>> };
  scene(): { objects: Record<string, { providerId?: string; sourceUrl?: string; name?: string } | undefined> };
  world(o?: { onTop?: boolean }): import("three").Group;
  display(id: string, o: { hidden?: boolean }): () => void;
  worldOf(id: string): number[] | null;
  ray(x: number, y: number): { origin: number[]; dir: number[] } | null;
  /** A point in the stage's frame in port pixels, and whether the port shows it. */
  project(point: number[]): { x: number; y: number; visible: boolean } | null;
  camera: { get(): { position: number[]; target: number[]; fov: number; up: number[] } | null; set(camera: { position: number[]; target: number[] }): void; onEnd(fn: () => void): () => void };
  invalidate(): void;
  frame(fn: () => void): () => void;
};
type SceneViewTHREE = typeof import("three");
/** The scene's undo for a package's own writes (scene EDITOR.md, "Undo"). */
type Edits = { edit(doc: { url: string; doc(): unknown; change(fn: (d: unknown) => void): unknown[] }, fn: (d: unknown) => void, o?: { label?: string }): boolean };
type ViewApi = {
  use(name: string): unknown;
  focus(): Stage | null;
  overlay(): HTMLElement;
  hand(spec: { kind: string; name: string; input: object; pointer?: boolean; escape?: () => boolean; put?: () => void }): () => void;
  /** Calls `fn` after every frame the scene draws; → off. */
  afterRender(fn: () => void): () => void;
};

/**
 * The model's handle as the editor gets it in a scene: every write goes on the scene's undo, as one
 * step ("Edit ‹title›"), with what the CAD tool's own undo leaves out (locks, comments, `@` keys:
 * UNDO_IGNORE) left out of the step too. Without the scene's `edits` service, or where it refuses
 * (the scene can't be written here), the write goes to the model as it would anyway.
 */
export function hostedHandle(handle: DocHandle<CadModelDoc>, edits: () => Edits | null): DocHandle<CadModelDoc> {
  const doc = {
    url: handle.url,
    doc: () => handle.doc(),
    change(fn: (d: unknown) => void) {
      let patches: { path: unknown[] }[] = [];
      handle.change(fn as (d: CadModelDoc) => void, { patchCallback: (p) => void (patches = p as never) });
      return patches.filter((p) => !UNDO_IGNORE(p.path));
    },
  };
  const change = (fn: (d: CadModelDoc) => void, opts?: object) => {
    if (opts || !edits()?.edit(doc, fn as (d: unknown) => void, { label: `Edit ${handle.doc()?.title || "model"}` })) handle.change(fn, opts as never);
  };
  return new Proxy(handle, {
    get(target, key) {
      if (key === "change") return change;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Session {
  id: string;
  view: SceneView;
  /** Ends it: the hand put down, the editor unmounted, the object shown again. */
  stop(): void;
}

export function create(api: ViewApi) {
  const overlay = api.overlay();
  let session: Session | undefined;

  function start(stage: Stage, id: string) {
    session?.stop();
    const object = stage.scene().objects[id];
    if (!object?.sourceUrl) return;
    const layer = stage.world();
    layer.userData["noPick"] = true;
    const show = stage.display(id, { hidden: true });
    const view = sceneView({
      THREE: stage.THREE,
      layer,
      frame: () => stage.worldOf(id),
      ray: (x, y) => stage.ray(x, y),
      port(clientX, clientY) {
        const r = overlay.getBoundingClientRect();
        const x = clientX - r.left;
        const y = clientY - r.top;
        return x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null;
      },
      camera: stage.camera,
      size() {
        const r = overlay.getBoundingClientRect();
        return r.width && r.height ? { width: r.width, height: r.height } : null;
      },
      project(point) {
        const p = stage.project(point);
        if (!p) return null;
        const r = overlay.getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y, visible: p.visible };
      },
      invalidate: () => stage.invalidate(),
      nextFrame: (fn) => void stage.frame(fn),
    });
    const element = document.createElement("div");
    element.className = "cad-scene-editor";
    element.style.cssText = "position: absolute; inset: 0; pointer-events: none;";
    overlay.append(element);
    let controls: EditorControls | undefined;
    let unmount = () => {};
    let stopped = false;
    let putDown = () => {};
    // What lies over the scene's view (the ViewCube, pins, collaborators' names) follows its camera in
    // every frame drawn: an orbit changes nothing that update() is told of (scene STAGE.md, "`instance`").
    const offRender = api.afterRender(() => view.update());
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (session?.id === id) session = undefined;
      offRender();
      putDown();
      unmount();
      element.remove();
      view.dispose();
      layer.removeFromParent();
      show();
    };
    stage.repo.find(object.sourceUrl).then(
      (handle) => {
        if (stopped) return;
        const hosted = hostedHandle(handle, () => (api.use("edits") as Edits | null) ?? null);
        unmount = render(() => <WysiwygEditor handle={hosted} element={element} viewer={view.Viewer} onControls={(c) => (controls = c)} />, element);
      },
      () => stop(),
    );
    putDown = api.hand({
      kind: "cad",
      name: `Editing ${object.name ?? "model"}`,
      pointer: true,
      input: {
        move: (ev: HandEvent) => view.input.move(ev),
        click: (ev: HandEvent) => view.input.click(ev),
        menu: (ev: HandEvent) => view.input.menu(ev),
        leave: () => view.input.leave(),
        cursor: () => view.input.cursor(),
      },
      escape: () => controls?.escape() ?? false,
      put: () => stop(),
    });
    // The focus leaving takes the layer and the display with it.
    stage.signal.addEventListener("abort", stop, { once: true });
    session = { id, view, stop };
  }

  const isModel = (target: unknown) => typeof target === "string" && api.focus()?.scene().objects[target]?.providerId === SOURCE_ID;

  return {
    commands: [
      {
        // the model's Open (scene EDITOR.md, "A command"): its editor, in place; double-click and Enter run it too
        id: "cad-edit",
        name: "Open",
        open: true,
        key: "Enter",
        edit: true,
        show: ["menu", "inspector"],
        state: (target: unknown) => (isModel(target) ? { label: session?.id === target ? "Close" : "Open", title: session?.id === target ? "Close the model's editor" : "Edit the model here, in place", checked: session?.id === target } : null),
        run(target: unknown) {
          const stage = api.focus();
          if (!stage || !isModel(target)) return;
          if (session && session.id === target) session.stop();
          else start(stage, target as string);
        },
      },
    ],
    update() {
      session?.view.moved();
    },
    dispose() {
      session?.stop();
    },
    /** For probes: what is edited, and what is hovered in it. */
    inspect: () => ({ editing: session?.id ?? null, hovered: session?.view.hovered() ?? null }),
    at: (x: number, y: number) => session?.view.at(x, y) ?? null,
  };
}

export default { create };
