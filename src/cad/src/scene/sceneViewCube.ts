// The ViewCube in a scene (research/23-scene-editing.md, A6): Viewer.tsx's, with its Home and
// projection buttons, over the scene's view. It draws on a canvas of its own with this package's
// three.js, as the scene's renderer can't draw it, and turns and orbits the scene's camera
// (sceneCamera.ts). The scene has no orthographic camera, so the projection button is disabled.

import * as THREE from "three";
import { themeColor } from "../components/Viewer.tsx";
import { regionDirection, ViewCube, type Region } from "../components/ViewCube.ts";
import type { SceneCamera } from "./sceneCamera.ts";

const SVG = "http://www.w3.org/2000/svg";

/** A button of the cube's, as Viewer.tsx's, with its icon's path. */
function button(kind: string, label: string, title: string, paths: string[], circle?: [number, number, number]): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `cad-viewcube__button cad-viewcube__button--${kind}`;
  b.setAttribute("aria-label", label);
  b.title = title;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  if (circle) {
    const c = document.createElementNS(SVG, "circle");
    for (const [k, v] of [["cx", circle[0]], ["cy", circle[1]], ["r", circle[2]]] as const) c.setAttribute(k, String(v));
    svg.append(c);
  }
  b.append(svg);
  return b;
}

export interface SceneViewCube {
  /** Draws the cube for the camera as it is now. */
  render(): void;
  /** Where on the screen a region can be clicked, if it faces the camera. */
  point(region: Region): { x: number; y: number } | undefined;
  setHomeHovered(hovered: boolean): void;
  dispose(): void;
}

/** Puts the ViewCube into `view`, the scene view's element, which tells whether it orbits by `data-orbiting`. */
export function sceneViewCube(view: HTMLElement, camera: SceneCamera, collapsedAtFirst: boolean): SceneViewCube {
  const root = document.createElement("div");
  root.className = "cad-viewcube";
  const toggle = button("toggle", "ViewCube", "", ["M8 1.5 14 5V11L8 14.5 2 11V5ZM2 5 8 8.5 14 5M8 8.5V14.5"]);
  const home = button("home", "Home view", "Home view", ["M2 8 8 2.5 14 8M4 6.5V13.5H12V6.5"]);
  const projection = button("projection", "Orthographic", "Orthographic", ["M1.5 5.5H4L5.5 3.5H10.5L12 5.5H14.5V13H1.5Z"], [8, 9, 2.5]);
  projection.disabled = true;
  projection.setAttribute("aria-pressed", "false");
  const cubeElement = document.createElement("div");
  cubeElement.className = "cad-viewcube__cube";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display: block; width: 100%; height: 100%;";
  cubeElement.append(canvas);
  root.append(toggle, home, projection, cubeElement);
  view.append(root);
  // The view's element lets the pointer through to the scene; the cube takes it.
  root.style.pointerEvents = "auto";

  let collapsed = collapsedAtFirst;
  const setCollapsed = (c: boolean) => {
    collapsed = c;
    root.dataset["collapsed"] = String(c);
    toggle.title = c ? "Show ViewCube" : "Hide ViewCube";
    toggle.setAttribute("aria-expanded", String(!c));
    if (c) cube.hover(undefined);
    drawn = undefined;
    render();
  };

  const cube = new ViewCube({ face: themeColor(view, "--cad-model-panel"), hover: themeColor(view, "--cad-model-hover"), line: themeColor(view, "--cad-model-fg") });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  /** What the cube was last drawn for: the camera's turn and the hovered region. */
  let drawn: string | undefined;
  let hovered: Region | undefined;
  const render = () => {
    const c = camera.now();
    if (!c || collapsed) return;
    const size = cubeElement.clientWidth;
    const key = JSON.stringify([c.quaternion.toArray(), hovered, size]);
    if (key === drawn || !size) return;
    drawn = key;
    renderer.setSize(size, size, false);
    cube.orient(c);
    renderer.render(cube.scene, cube.camera);
    // For tests: the direction it was drawn for, from the target to the camera.
    root.dataset["direction"] = c.getWorldDirection(new THREE.Vector3()).negate().toArray().map((x) => x.toFixed(3)).join(",");
  };
  const hover = (region: Region | undefined) => {
    hovered = region;
    cube.hover(region);
    render();
  };

  /** A client position in the cube's normalised device coordinates. */
  const ndc = (clientX: number, clientY: number) => {
    const rect = cubeElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  };
  const regionAt = (clientX: number, clientY: number) => {
    const c = camera.now();
    if (!c) return undefined;
    cube.orient(c);
    return cube.regionAt(ndc(clientX, clientY));
  };
  /** A press on the cube: a click turns the view to the region under it, a drag orbits (research/18-named-views.md, "In the editor"). */
  let down: { x: number; y: number; last: { x: number; y: number }; orbiting: boolean; pointer: number } | undefined;
  const onMove = (event: PointerEvent) => {
    const d = down;
    if (!d || d.pointer !== event.pointerId) return hover(regionAt(event.clientX, event.clientY));
    if (!d.orbiting && Math.hypot(event.clientX - d.x, event.clientY - d.y) > 4) {
      d.orbiting = true;
      hover(undefined);
      view.dataset["orbiting"] = "true";
    }
    if (d.orbiting) camera.orbitBy(event.clientX - d.last.x, event.clientY - d.last.y);
    d.last = { x: event.clientX, y: event.clientY };
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || down) return;
    down = { x: event.clientX, y: event.clientY, last: { x: event.clientX, y: event.clientY }, orbiting: false, pointer: event.pointerId };
    cubeElement.setPointerCapture(event.pointerId);
  };
  const end = (event: PointerEvent, cancelled: boolean) => {
    const d = down;
    if (!d || d.pointer !== event.pointerId) return;
    down = undefined;
    if (cubeElement.hasPointerCapture(event.pointerId)) cubeElement.releasePointerCapture(event.pointerId);
    delete view.dataset["orbiting"];
    if (d.orbiting) return camera.orbitEnd();
    const region = cancelled ? undefined : regionAt(event.clientX, event.clientY);
    if (region) camera.turnTo(regionDirection(region).clone());
  };
  const onUp = (event: PointerEvent) => end(event, false);
  const onCancel = (event: PointerEvent) => end(event, true);
  const onLeave = () => !down && hover(undefined);
  cubeElement.addEventListener("pointermove", onMove);
  cubeElement.addEventListener("pointerdown", onDown);
  cubeElement.addEventListener("pointerup", onUp);
  cubeElement.addEventListener("pointercancel", onCancel);
  cubeElement.addEventListener("pointerleave", onLeave);
  toggle.addEventListener("click", () => setCollapsed(!collapsed));
  home.addEventListener("click", () => camera.home());
  setCollapsed(collapsedAtFirst);

  return {
    render,
    point(region) {
      const c = camera.now();
      if (collapsed || !c) return undefined;
      cube.orient(c);
      const p = cube.pointOf(region);
      if (!p) return undefined;
      const rect = cubeElement.getBoundingClientRect();
      return { x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height) };
    },
    setHomeHovered(h) {
      if (h) home.dataset["hovered"] = "true";
      else delete home.dataset["hovered"];
    },
    dispose() {
      cube.dispose();
      renderer.dispose();
      root.remove();
    },
  };
}
