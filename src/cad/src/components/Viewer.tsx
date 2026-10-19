import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getEdgeIndex, getFaceIndex, syncFaces, syncLines } from "replicad-threejs-helper";
import type { MeshedShape } from "../kernel/protocol.ts";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { CameraState } from "../types.ts";
import { contactToken } from "./presence.ts";
import { regionDirection, regionName, ViewCube, type Region } from "./ViewCube.ts";

export type EntityKind = "face" | "edge";

/**
 * Entities of a body to highlight, by index in the body. Highlights are drawn translucently through
 * the model, so that they show also where other faces hide them (research/12).
 */
export interface Highlight {
  body: string;
  kind: EntityKind;
  indices: number[];
  /** `hover`: what is hovered, e.g. a feature's faces; `accent`: what is selected, or what a reference resolves to; `peer`: what a collaborator hovers or selects, in `color`. */
  style: HighlightStyle;
  /** A CSS colour, for `peer`. */
  color?: string;
  /** The body's mesh, if it isn't shown, e.g. a feature's result past the timeline marker. */
  shape?: MeshedShape;
}

export type HighlightStyle = "hover" | "accent" | "peer";

export interface Entity {
  body: string;
  kind: EntityKind;
  index: number;
}

/** A polyline in world coordinates drawn over the model, e.g. a sketch preview. */
export interface Overlay {
  points: [number, number, number][];
  closed: boolean;
}

/** A collaborator's pointer on the model. */
export interface PeerMarker {
  key: string;
  point: [number, number, number];
  color: string;
  /** Labels the marker with the contact's name. */
  contactUrl: string;
}

/** Comments on faces or edges (research/13-collaboration.md, "Comments"): a pin on them, labelled with how many threads. */
export interface Pin {
  key: string;
  body: string;
  kind: EntityKind;
  indices: number[];
  label: string;
  /** One of its threads is focused, e.g. in the Comments panel. */
  focused: boolean;
}

export interface ViewerProps {
  shapes: MeshedShape[] | undefined;
  /** Which entities hover and click pick; nothing is pickable without it, and hover takes edges, else faces. */
  pick?: EntityKind | undefined;
  onPick?: (entity: Entity) => void;
  /** The hovered face or edge of a feature-library body, if any. */
  onHover?: (entity: Entity | undefined) => void;
  /**
   * Makes faces and edges selectable while nothing is picked: a click selects the one under the
   * pointer, a click elsewhere in the view clears it. Called with the selection as it changes.
   */
  onSelect?: (entity: Entity | undefined) => void;
  highlight?: Highlight[] | undefined;
  overlays?: Overlay[] | undefined;
  /** The point on the model under the pointer as it moves, undefined when it is off the model. */
  onPointer?: (point: [number, number, number] | undefined) => void;
  /** Collaborators' pointers. */
  peers?: PeerMarker[] | undefined;
  /** A camera to show, e.g. the one the user last left; it applies whenever it changes. */
  view?: CameraState | undefined;
  /** Called when the user has moved the camera: after an orbit, a ViewCube turn, Home or a projection switch. */
  onViewChange?: (view: CameraState) => void;
  /** Makes ViewCube regions draggable: a drag creates a view document from the region (e.g. "Front") with this and drags it. */
  createView?: (view: CameraState, name: string) => { url: AutomergeUrl; title: string } | undefined;
  /** Starts with the ViewCube collapsed to its toggle. The state is local to this mount. */
  collapseViewCube?: boolean;
  /** Comment pins, and what clicking one does, with the pin's position on the screen. */
  pins?: Pin[] | undefined;
  onPin?: (key: string, at: { x: number; y: number }) => void;
  /** A button at the selected face or edge, e.g. to comment on it. */
  selectionAction?: { label: string; run: (at: { x: number; y: number }) => void } | undefined;
}

/** Two cameras are the same; storage may reorder an object's keys. */
export const sameCamera = (a: CameraState | undefined, b: CameraState | undefined) => !!a && !!b && cameraKey(a) === cameraKey(b);
const cameraKey = (v: CameraState) => JSON.stringify([v.direction, v.target, v.distance, v.projection, v.zoom]);

/**
 * For tests: where on the screen an entity can be clicked. The e2e specs click real pixels, so
 * picking goes through the same raycasting as a user's click.
 */
export interface ViewerTestHook {
  screenPoint(entity: Entity): { x: number; y: number } | undefined;
  /** The pickable entities of the shown shapes. */
  entities(kind: EntityKind): Entity[];
  /** The highlighted entities of `style`, e.g. a hovered face or the faces of a feature hovered in the timeline. */
  highlighted(style: HighlightStyle): Entity[];
  /** The mean of an entity's mesh vertices. */
  centroid(entity: Entity): [number, number, number] | undefined;
  /** Where on the screen a ViewCube region can be clicked, if it faces the camera. */
  viewCubePoint(region: Region): { x: number; y: number } | undefined;
  /** The direction from the orbit target to the camera. */
  cameraDirection(): [number, number, number];
  /** Where collaborators' pointer markers are on the screen. */
  peerMarkers(): { key: string; x: number; y: number }[];
}

export type Projection = CameraState["projection"];

/** The direction the camera looks from at first and after Home: front, right and above. */
const HOME_DIRECTION = new THREE.Vector3(0.55, -0.85, 0.65).normalize();
/** How long the camera turns to a ViewCube region. */
const TURN_MS = 300;

/** Relative luminance (WCAG), from a colour's linear components. */
const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Reads a theme colour that the stylesheet derived for this tool. */
function themeColor(element: Element, name: string): THREE.Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  const color = new THREE.Color();
  // three.js parses rgb()/hex only, and a canvas normalises color-mix() to oklch(), which it can't
  // parse either. Painting a pixel converts any CSS colour to sRGB.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context && value) {
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  }
  return color;
}

interface Rendered {
  shape: MeshedShape;
  /** The body's name, or `#<index>` for a shape that isn't a feature-library body, which hovers but isn't picked. */
  id: string;
  mesh: THREE.Mesh;
  lines: THREE.LineSegments | undefined;
}

/** The entity of each mesh group: the body's index of it, or the group's own index for shapes that aren't bodies. */
const groupEntity = (indexOf: number[] | undefined, group: number) => (indexOf ? (indexOf[group] ?? -1) : group);

/** An entity as `body:kind:index`, for tests. */
const entityKey = (e: Entity | undefined) => (e ? `${e.body}:${e.kind}:${e.index}` : "");

const same = (a: Entity | undefined, b: Entity | undefined) => !!a && !!b && a.body === b.body && a.kind === b.kind && a.index === b.index;

/**
 * The outline of non-indexed triangles: the triangle edges that only one of them has. Vertices are
 * matched by position, as a mesh repeats them along seams and between faces, so edges between two
 * of the faces cancel out too.
 */
function outline(triangles: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = triangles.getAttribute("position");
  const key = (i: number) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const edges = new Map<string, [number, number] | undefined>();
  for (let t = 0; t + 2 < p.count; t += 3) {
    for (const [a, b] of [[t, t + 1], [t + 1, t + 2], [t + 2, t]] as const) {
      const [ka, kb] = [key(a), key(b)];
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      // A second triangle with this edge: it is inside.
      if (edges.has(k)) edges.set(k, undefined);
      else edges.set(k, [a, b]);
    }
  }
  const values: number[] = [];
  for (const edge of edges.values()) if (edge) for (const v of edge) values.push(p.getX(v), p.getY(v), p.getZ(v));
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
}

/**
 * A copy of the triangles or segments of the mesh groups whose entity is in `indices`, as a
 * non-indexed geometry of its own (a geometry that shares attributes would free them on dispose).
 */
function subset(source: THREE.BufferGeometry, indexOf: number[] | undefined, indices: number[]): THREE.BufferGeometry {
  const wanted = new Set(indices);
  const position = source.getAttribute("position");
  const index = source.getIndex();
  const values: number[] = [];
  source.groups.forEach((g, gi) => {
    if (!wanted.has(groupEntity(indexOf, gi))) return;
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = index ? index.getX(i) : i;
      values.push(position.getX(v), position.getY(v), position.getZ(v));
    }
  });
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
}

/**
 * Points on an entity's faces or edges, biggest first: triangle centroids by area, segment midpoints
 * by length. The first is where a pin goes; tests click them.
 */
function candidatesOf(r: Rendered, kind: EntityKind, indices: ReadonlySet<number>): { point: THREE.Vector3; size: number }[] {
  const candidates: { point: THREE.Vector3; size: number }[] = [];
  if (kind === "face") {
    const position = r.mesh.geometry.getAttribute("position");
    const index = r.mesh.geometry.getIndex();
    r.mesh.geometry.groups.forEach((g, gi) => {
      if (!indices.has(r.shape.faceIndex?.[gi] ?? -1) || !index) return;
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const [p0, p1, p2] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(position, index.getX(t + k))) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const area = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).length() / 2;
        candidates.push({ point: p0.clone().add(p1).add(p2).divideScalar(3), size: area });
      }
    });
  } else if (r.lines) {
    const position = r.lines.geometry.getAttribute("position");
    r.lines.geometry.groups.forEach((g, gi) => {
      if (!indices.has(r.shape.edgeIndex?.[gi] ?? -1)) return;
      for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(position, v);
        const b = new THREE.Vector3().fromBufferAttribute(position, v + 1);
        candidates.push({ point: a.clone().add(b).multiplyScalar(0.5), size: a.distanceTo(b) });
      }
    });
  }
  return candidates.sort((x, y) => y.size - x.size);
}

export function Viewer(props: ViewerProps) {
  let container!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let cubeElement!: HTMLDivElement;
  const [hovered, setHovered] = createSignal<Entity>();
  const [selected, setSelected] = createSignal<Entity>();
  const [projection, setProjection] = createSignal<Projection>("perspective");
  const [collapsed, setCollapsed] = createSignal(props.collapseViewCube ?? false);
  let home = () => {};
  let toggleProjection = (_byUser?: boolean) => {};

  onMount(() => {
    const scene = new THREE.Scene();
    const perspective = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    perspective.up.set(0, 0, 1);
    perspective.position.set(80, -120, 90);
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10_000);
    orthographic.up.set(0, 0, 1);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective;
    /** The height the orthographic camera shows at zoom 1. */
    let orthoHeight = 1;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const controls = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(camera, renderer.domElement);

    // Bodies in a grey between the background and the text, lit from the camera, so that the shading
    // follows it and edges in the text colour read on every face (research/14-edge-contrast.md).
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    scene.add(light, light.target);
    /** Places the key light above and to the left of the camera. */
    const placeLight = () => {
      light.position.copy(camera.position).add(new THREE.Vector3(-0.4, 0.7, 0).applyQuaternion(camera.quaternion).multiplyScalar(distance()));
      light.target.position.copy(controls.target);
    };
    // Soft reflections, which move with the camera too.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    const faceMaterial = new THREE.MeshStandardMaterial({ color: themeColor(container, "--cad-model-shape"), roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 1 });
    // Lines in CSS pixels, as WebGL's own lines are never wider than one; wider with `prefers-contrast: more`.
    const contrast = matchMedia("(prefers-contrast: more)").matches ? 1.5 : 1;
    const wideLine = (color: THREE.Color, width: number, overlay: boolean) =>
      new LineMaterial({ color: color.getHex(), linewidth: width * contrast, ...(overlay ? { transparent: true, depthTest: false, depthWrite: false } : {}) });
    const edgeMaterial = wideLine(themeColor(container, "--cad-model-edge"), 1.5, false);
    // Picking raycasts 1 px lines, which aren't drawn.
    const lineMaterial = new THREE.LineBasicMaterial({ visible: false });
    const accent = themeColor(container, "--cad-model-accent");
    // Lines need the contrast of the text variant, e.g. a sketch outline against a light background.
    const accentLine = themeColor(container, "--cad-model-accent-text");
    const hover = themeColor(container, "--cad-model-hover");
    const overlayMaterial = new THREE.LineBasicMaterial({ color: accentLine, depthTest: false });
    // Highlights show through the model, so that they also show what other faces hide.
    const highlightFace = (color: THREE.Color, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    // A highlighted edge is a line over a wider halo in the theme's dark or light ink, whichever
    // contrasts with it, so one of the two contrasts with whatever is behind it.
    const inks = [themeColor(container, "--cad-model-bg"), themeColor(container, "--cad-model-fg")].sort((a, b) => luminance(a) - luminance(b));
    const inkFor = (color: THREE.Color) => (luminance(color) > 0.35 ? inks[0]! : inks[1]!);
    const highlightLine = (color: THREE.Color, width: number) => ({ core: wideLine(color, width, true), halo: wideLine(inkFor(color), width + 3.5, true) });
    // Hovering a selected edge adds the hover's thin line as a ring around the selection, in its halo.
    const ringMaterials = { line: wideLine(accentLine, 10, true), halo: wideLine(inkFor(accentLine), 13.5, true) };
    // Hovered and selected edges have one colour; a hover is thinner.
    const highlightMaterials: Record<Exclude<HighlightStyle, "peer">, { face: THREE.Material; line: { core: LineMaterial; halo: LineMaterial } }> = {
      hover: { face: highlightFace(hover, 0.35), line: highlightLine(accentLine, 2) },
      accent: { face: highlightFace(accent, 0.5), line: highlightLine(accentLine, 3.5) },
    };
    const wideSegments = (geometry: THREE.BufferGeometry, material: LineMaterial) => new LineSegments2(new LineSegmentsGeometry().setPositions(geometry.getAttribute("position").array as Float32Array), material);
    /** Collaborators' highlights, by colour. */
    const peerMaterials = new Map<string, { face: THREE.Material; line: { core: LineMaterial; halo: LineMaterial }; marker: THREE.Material }>();
    const peerMaterial = (css: string) => {
      let m = peerMaterials.get(css);
      if (!m) {
        const color = new THREE.Color().setStyle(css, THREE.SRGBColorSpace);
        m = { face: highlightFace(color, 0.3), line: highlightLine(color, 3), marker: new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }) };
        peerMaterials.set(css, m);
      }
      return m;
    };
    const materialsOf = (h: Highlight) => (h.style === "peer" ? peerMaterial(h.color ?? "#888") : highlightMaterials[h.style]);
    const group = new THREE.Group();
    const overlayGroup = new THREE.Group();
    overlayGroup.renderOrder = 1;
    const highlightGroup = new THREE.Group();
    highlightGroup.renderOrder = 2;
    const peerGroup = new THREE.Group();
    peerGroup.renderOrder = 3;
    scene.add(group, overlayGroup, highlightGroup, peerGroup);
    let rendered: Rendered[] = [];

    const cube = new ViewCube({
      face: themeColor(container, "--cad-model-panel"),
      hover: hover,
      line: themeColor(container, "--cad-model-fg"),
    });

    const direction = () => camera.position.clone().sub(controls.target).normalize();
    const distance = () => camera.position.distanceTo(controls.target);

    let width = 1;
    let height = 1;
    const updateProjection = () => {
      perspective.aspect = width / height;
      orthographic.top = orthoHeight / 2;
      orthographic.bottom = -orthoHeight / 2;
      orthographic.left = (-orthoHeight / 2) * perspective.aspect;
      orthographic.right = (orthoHeight / 2) * perspective.aspect;
      perspective.updateProjectionMatrix();
      orthographic.updateProjectionMatrix();
    };
    /** The orthographic height that shows as much at the target as the perspective camera from `d`. */
    const heightAt = (d: number) => 2 * d * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));

    /** Where the camera is: it looks from `direction` at `target`, `distance` away, and the orthographic camera zooms by `zoom`. */
    interface Pose {
      direction: THREE.Vector3;
      target: THREE.Vector3;
      distance: number;
      zoom: number;
    }
    const pose = (): Pose => ({ direction: direction(), target: controls.target.clone(), distance: distance(), zoom: orthographic.zoom });
    const place = (p: Pose) => {
      controls.target.copy(p.target);
      camera.position.copy(p.target).addScaledVector(p.direction, p.distance);
      for (const c of [perspective, orthographic]) {
        c.near = p.distance / 300;
        c.far = p.distance * 33;
      }
      orthoHeight = heightAt(p.distance);
      orthographic.zoom = p.zoom;
      updateProjection();
      controls.update();
      camera.updateMatrixWorld();
    };

    /** A running move of the camera, e.g. to a ViewCube region; `data-turning` tells tests to wait for its end. */
    let turn: { from: Pose; to: Pose; rotation: THREE.Quaternion; start: number; report: boolean } | undefined;
    const setTurn = (next: typeof turn) => {
      turn = next;
      container.dataset["turning"] = String(!!turn);
    };
    /** Moves the camera to `to`, animated unless the user prefers reduced motion; `report` calls onViewChange at the end. */
    const moveTo = (to: Partial<Pose>, report: boolean) => {
      const from = pose();
      const end = { ...from, ...to };
      setTurn({ from, to: end, rotation: new THREE.Quaternion().setFromUnitVectors(from.direction, end.direction), start: performance.now(), report });
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) turn!.start -= TURN_MS;
      step(performance.now());
    };
    /** Advances the move to `now`. */
    const step = (now: number) => {
      if (!turn) return;
      const t = Math.min(1, (now - turn.start) / TURN_MS);
      const eased = t * t * (3 - 2 * t);
      const { from, to } = turn;
      place({
        direction: from.direction.clone().applyQuaternion(new THREE.Quaternion().slerp(turn.rotation, eased)),
        target: from.target.clone().lerp(to.target, eased),
        distance: THREE.MathUtils.lerp(from.distance, to.distance, eased),
        zoom: THREE.MathUtils.lerp(from.zoom, to.zoom, eased),
      });
      if (t === 1) {
        const done = turn;
        setTurn(undefined);
        if (done.report) report();
      }
    };
    /** Whether the view has shown a camera yet; until then, cameras apply at once instead of moving there. */
    let shown = false;

    let radius = 50;
    let framed: THREE.Sphere | undefined;
    /**
     * Frames the model, unless it still fits in the framed view (so that edits don't move the camera).
     * Framing keeps the camera's direction; only the first frame and Home look from `towards`. Home
     * moves there animated and reports the new camera.
     */
    const frame = (force = false, towards?: THREE.Vector3, animate = false) => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      radius = sphere.radius;
      if (!force && framed && framed.radius >= sphere.radius && framed.radius <= sphere.radius * 3 && framed.containsPoint(sphere.center) && sphere.center.distanceTo(framed.center) + sphere.radius <= framed.radius * 1.1) return;
      const to = { direction: (towards ?? (framed ? direction() : HOME_DIRECTION)).clone(), target: sphere.center.clone(), distance: sphere.radius * 3, zoom: 1 };
      framed = sphere;
      shown = true;
      if (animate) return moveTo(to, true);
      setTurn(undefined);
      place(to);
    };

    /** The ViewCube's square in the canvas, in CSS pixels from the bottom left, as three.js's viewport wants it. */
    const cubeViewport = () => {
      const cubeRect = cubeElement.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      return { x: cubeRect.left - rect.left, y: rect.bottom - cubeRect.bottom, size: cubeRect.width };
    };
    const resize = () => {
      width = container.clientWidth || 1;
      height = container.clientHeight || 1;
      updateProjection();
      renderer.setSize(width, height, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const turnTo = (to: THREE.Vector3) => moveTo({ direction: to }, true);
    controls.addEventListener("start", () => setTurn(undefined));

    home = () => frame(true, HOME_DIRECTION, true);
    toggleProjection = (byUser = true) => {
      setTurn(undefined);
      const d = distance();
      if (camera === perspective) {
        orthographic.position.copy(perspective.position);
        orthographic.quaternion.copy(perspective.quaternion);
        orthoHeight = heightAt(d);
        orthographic.zoom = 1;
        camera = orthographic;
      } else {
        perspective.position.copy(controls.target).addScaledVector(direction(), d / orthographic.zoom);
        camera = perspective;
      }
      controls.object = camera;
      updateProjection();
      controls.update();
      setProjection(camera === perspective ? "perspective" : "orthographic");
      if (byUser) report();
    };

    // Rounded: Automerge 3.4.1 stores 0.9999999999999999 in a list as 0 (research/10-view-state.md).
    const round = (x: number) => Math.round(x * 1e9) / 1e9;
    const vector = (v: THREE.Vector3) => v.toArray().map(round) as [number, number, number];
    const cameraState = (): CameraState => ({
      direction: vector(direction()),
      target: vector(controls.target),
      distance: round(distance()),
      projection: camera === perspective ? "perspective" : "orthographic",
      zoom: round(orthographic.zoom),
    });
    const key = cameraKey;
    /** The camera this view last reported or applied, so that it doesn't apply its own state again. */
    let reported: string | undefined;
    const report = () => {
      const state = cameraState();
      reported = key(state);
      props.onViewChange?.(state);
    };
    controls.addEventListener("end", report);

    /** Shows `view`: animated once the view has shown a camera, e.g. on Reset, at once when it opens. */
    const apply = (view: CameraState) => {
      setTurn(undefined);
      if (view.projection !== projection()) toggleProjection(false);
      const to = { direction: new THREE.Vector3(...view.direction).normalize(), target: new THREE.Vector3(...view.target), distance: view.distance, zoom: view.zoom };
      // As if framed from there, so that a build only reframes if the model doesn't fit.
      framed = new THREE.Sphere(to.target.clone(), view.distance / 3);
      radius = framed.radius;
      if (shown) return moveTo(to, false);
      shown = true;
      place(to);
    };
    createEffect(() => {
      const view = props.view;
      if (!view || key(view) === reported) return;
      reported = key(view);
      apply(view);
    });

    let frameId = 0;
    const tick = (now: number) => {
      step(now);
      controls.update();
      placeLight();
      placeMarkers();
      placeFloating();
      renderer.render(scene, camera);
      if (!collapsed()) renderCube();
      frameId = requestAnimationFrame(tick);
    };
    const renderCube = () => {
      cube.orient(camera);
      const { x, y, size } = cubeViewport();
      renderer.setScissorTest(true);
      renderer.setScissor(x, y, size, size);
      renderer.setViewport(x, y, size, size);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(cube.scene, cube.camera);
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
    };
    frameId = requestAnimationFrame(tick);

    const dispose = (objects: THREE.Object3D[]) => {
      for (const child of objects) if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) child.geometry.dispose();
    };

    /** Counts renders of the shapes, which the highlights are drawn from. */
    const [renders, setRenders] = createSignal(0);
    createEffect(() => {
      const shapes = props.shapes;
      if (!shapes) return;
      dispose([...group.children]);
      group.clear();
      let vertices = 0;
      rendered = shapes.map((shape, i) => {
        const faces = new THREE.BufferGeometry();
        syncFaces(faces, shape.faces);
        const mesh = new THREE.Mesh(faces, faceMaterial);
        group.add(mesh);
        vertices += shape.faces.vertices.length / 3;
        let lines: THREE.LineSegments | undefined;
        if (shape.edges) {
          const geometry = new THREE.BufferGeometry();
          syncLines(geometry, shape.edges);
          lines = new THREE.LineSegments(geometry, lineMaterial);
          group.add(lines);
          group.add(wideSegments(geometry, edgeMaterial));
        }
        return { shape, id: shape.body ?? `#${i}`, mesh, lines };
      });
      container.dataset["vertices"] = String(vertices);
      // Indices may name other entities in the new shapes.
      setHovered(undefined);
      setSelected(undefined);
      frame();
      setRenders((n) => n + 1);
    });

    /** The highlighted entities by style, for tests. */
    let highlighted: { style: HighlightStyle; entity: Entity }[] = [];
    createEffect(() => {
      renders();
      dispose([...highlightGroup.children]);
      highlightGroup.clear();
      const own = (entity: Entity | undefined, style: HighlightStyle): Highlight[] => (entity ? [{ body: entity.body, kind: entity.kind, indices: [entity.index], style }] : []);
      const all = [...(props.highlight ?? []), ...own(selected(), "accent"), ...own(hovered(), "hover")];
      /** The selected edge is hovered: it gets the ring, and the hover no line of its own. */
      const ringed = selected()?.kind === "edge" && same(selected(), hovered());
      /** The selected face is hovered: it keeps the selection's fill, and gets the hover's outline. */
      const hoveredSelectedFace = selected()?.kind === "face" && same(selected(), hovered());
      highlighted = all.flatMap((h) => h.indices.map((index) => ({ style: h.style, entity: { body: h.body, kind: h.kind, index } })));
      for (const h of all) {
        const r = h.shape ? undefined : rendered.find((x) => x.id === h.body);
        const shape = h.shape ?? r?.shape;
        if (!shape) continue;
        const indexOf = h.kind === "face" ? shape.faceIndex : shape.edgeIndex;
        // A shape that isn't shown is meshed for this highlight only.
        let source = h.kind === "face" ? r?.mesh.geometry : r?.lines?.geometry;
        let temporary: THREE.BufferGeometry | undefined;
        if (!source) {
          temporary = new THREE.BufferGeometry();
          if (h.kind === "face") syncFaces(temporary, shape.faces);
          else if (shape.edges) syncLines(temporary, shape.edges);
          source = temporary;
        }
        const geometry = subset(source, indexOf, h.indices);
        temporary?.dispose();
        const { face, line } = materialsOf(h);
        if (h.kind === "face") {
          const ownHover = h.style === "hover" && h.indices.length === 1 && same({ body: h.body, kind: h.kind, index: h.indices[0]! }, hovered());
          if (!(hoveredSelectedFace && ownHover)) highlightGroup.add(new THREE.Mesh(geometry, face));
          // A hover, of a face or of a feature's faces, is outlined with the hover's thin line, also over a selection.
          if (h.style === "hover") {
            const edges = outline(geometry);
            highlightGroup.add(...[line.halo, line.core].map((material, i) => Object.assign(wideSegments(edges, material), { renderOrder: i })));
            edges.dispose();
          }
          if (hoveredSelectedFace && ownHover) geometry.dispose();
        }
        else if (!(ringed && h.style === "hover" && same({ body: h.body, kind: h.kind, index: h.indices[0]! }, hovered()))) {
          const ring = ringed && h.style === "accent" && same({ body: h.body, kind: h.kind, index: h.indices[0]! }, selected());
          // Outermost first.
          const layers = [...(ring ? [ringMaterials.halo, ringMaterials.line] : []), line.halo, line.core];
          highlightGroup.add(...layers.map((material, i) => Object.assign(wideSegments(geometry, material), { renderOrder: i })));
          geometry.dispose();
        } else geometry.dispose();
      }
    });

    createEffect(() => {
      dispose([...overlayGroup.children]);
      overlayGroup.clear();
      for (const overlay of props.overlays ?? []) {
        const geometry = new THREE.BufferGeometry().setFromPoints(overlay.points.map((p) => new THREE.Vector3(...p)));
        overlayGroup.add(overlay.closed ? new THREE.LineLoop(geometry, overlayMaterial) : new THREE.Line(geometry, overlayMaterial));
      }
    });

    // ---------- collaborators' pointers ----------

    /** A marker per collaborator: a dot on the model and their name next to it, which the render loop places. */
    const markers = new Map<string, { dot: THREE.Mesh; label: HTMLDivElement; point: THREE.Vector3 }>();
    const dotGeometry = new THREE.SphereGeometry(1, 12, 8);
    createEffect(() => {
      const peers = props.peers ?? [];
      const keys = new Set(peers.map((p) => p.key));
      for (const [key, m] of markers) {
        if (keys.has(key)) continue;
        peerGroup.remove(m.dot);
        m.label.remove();
        markers.delete(key);
      }
      for (const peer of peers) {
        let m = markers.get(peer.key);
        if (!m) {
          const label = document.createElement("div");
          label.className = "cad-model__peer";
          label.append(contactToken(peer.contactUrl));
          container.append(label);
          m = { dot: new THREE.Mesh(dotGeometry), label, point: new THREE.Vector3() };
          peerGroup.add(m.dot);
          markers.set(peer.key, m);
        }
        m.dot.material = peerMaterial(peer.color).marker;
        m.label.style.setProperty("--peer-color", peer.color);
        m.point.set(...peer.point);
        m.dot.position.copy(m.point);
      }
      container.dataset["peerMarkers"] = String(markers.size);
    });
    /** Places the markers' labels and sizes their dots to a constant few pixels. */
    const placeMarkers = () => {
      if (!markers.size) return;
      const rect = canvas.getBoundingClientRect();
      for (const m of markers.values()) {
        const v = m.point.clone().project(camera);
        const visible = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
        m.label.hidden = !visible;
        m.label.style.transform = `translate(${((v.x + 1) / 2) * rect.width}px, ${((1 - v.y) / 2) * rect.height}px)`;
        const unitsPerPixel = camera === perspective ? (2 * m.point.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2))) / rect.height : orthoHeight / orthographic.zoom / rect.height;
        m.dot.scale.setScalar(4 * unitsPerPixel);
      }
    };

    // ---------- comment pins and the selection's action ----------

    /** Where a pin on entities goes: on their biggest triangle or longest segment. */
    const anchorOf = (body: string, kind: EntityKind, indices: number[]) => {
      const r = rendered.find((x) => x.shape.body === body);
      return r && candidatesOf(r, kind, new Set(indices))[0]?.point;
    };
    /** Buttons over the canvas at points on the model, which the render loop places. */
    const floating = new Map<string, { el: HTMLButtonElement; point: THREE.Vector3 | undefined; onClick: (at: { x: number; y: number }) => void }>();
    const float = (key: string, className: string, onClick: (at: { x: number; y: number }) => void) => {
      let f = floating.get(key);
      if (!f) {
        const el = document.createElement("button");
        const created = { el, point: undefined, onClick };
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          const r = el.getBoundingClientRect();
          created.onClick({ x: r.left, y: r.bottom });
        });
        container.append(el);
        floating.set(key, created);
        f = created;
      }
      f.onClick = onClick;
      f.el.className = className;
      return f;
    };
    const unfloat = (keep: (key: string) => boolean) => {
      for (const [key, f] of floating) {
        if (keep(key)) continue;
        f.el.remove();
        floating.delete(key);
      }
    };
    createEffect(() => {
      props.shapes;
      const pins = props.pins ?? [];
      const keys = new Set(pins.map((p) => `pin:${p.key}`));
      unfloat((key) => !key.startsWith("pin:") || keys.has(key));
      for (const pin of pins) {
        const f = float(`pin:${pin.key}`, "cad-model__pin", (at) => props.onPin?.(pin.key, at));
        f.el.textContent = pin.label;
        f.el.title = "Comments";
        f.el.setAttribute("aria-label", `Comments (${pin.label})`);
        f.el.dataset["key"] = pin.key;
        f.el.dataset["focused"] = pin.focused ? "true" : "false";
        f.point = anchorOf(pin.body, pin.kind, pin.indices);
      }
    });
    createEffect(() => {
      props.shapes;
      const entity = selected();
      const action = props.selectionAction;
      unfloat((key) => key !== "action" || (!!entity && !!action));
      if (!entity || !action) return;
      const f = float("action", "cad-model__selection-action", action.run);
      f.el.textContent = action.label;
      f.point = anchorOf(entity.body, entity.kind, [entity.index]);
    });
    const placeFloating = () => {
      if (!floating.size) return;
      const rect = canvas.getBoundingClientRect();
      for (const f of floating.values()) {
        const v = f.point?.clone().project(camera);
        const visible = !!v && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
        f.el.hidden = !visible;
        if (v) f.el.style.transform = `translate(${((v.x + 1) / 2) * rect.width}px, ${((1 - v.y) / 2) * rect.height}px)`;
      }
    };

    // ---------- picking ----------

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    /** The entity of kind `kind` under a canvas position, unless a face hides it. */
    const entityAt = (clientX: number, clientY: number, kind: EntityKind): Entity | undefined => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      raycaster.params.Line = { threshold: radius * 0.015 };
      const faceHit = raycaster.intersectObjects(rendered.map((r) => r.mesh), false)[0];
      if (kind === "face") {
        const r = faceHit && rendered.find((x) => x.mesh === faceHit.object);
        if (!r || faceHit?.faceIndex == null) return undefined;
        const index = groupEntity(r.shape.faceIndex, getFaceIndex(faceHit.faceIndex, r.mesh.geometry));
        return index < 0 ? undefined : { body: r.id, kind, index };
      }
      const lineHit = raycaster.intersectObjects(rendered.flatMap((r) => (r.lines ? [r.lines] : [])), false)[0];
      if (!lineHit || lineHit.index == null) return undefined;
      // An edge behind a face is hidden; the threshold lets edges on the face's border through.
      if (faceHit && faceHit.distance < lineHit.distance - radius * 0.01) return undefined;
      const r = rendered.find((x) => x.lines === lineHit.object);
      if (!r?.lines) return undefined;
      const index = groupEntity(r.shape.edgeIndex, getEdgeIndex(lineHit.index, r.lines.geometry));
      return index < 0 ? undefined : { body: r.id, kind, index };
    };
    /** What hovering at a position shows: the pick kind's entity, or else an edge if one is there, else a face. */
    const hoverAt = (clientX: number, clientY: number): Entity | undefined =>
      props.pick ? entityAt(clientX, clientY, props.pick) : (entityAt(clientX, clientY, "edge") ?? entityAt(clientX, clientY, "face"));
    /** Whether an entity is of a feature-library body, which can be picked and named. */
    const isBody = (entity: Entity | undefined): entity is Entity => !!entity && rendered.some((r) => r.shape.body === entity.body);

    /** The point on the model under a canvas position. */
    const pointAt = (clientX: number, clientY: number): [number, number, number] | undefined => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(rendered.map((r) => r.mesh), false)[0];
      return hit ? (hit.point.toArray().map((x) => Math.round(x * 1000) / 1000) as [number, number, number]) : undefined;
    };

    let down: { x: number; y: number } | undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons) return;
      const entity = hoverAt(event.clientX, event.clientY);
      if (!same(entity, hovered())) setHovered(entity);
      if (props.onPointer) props.onPointer(pointAt(event.clientX, event.clientY));
    };
    const onPointerDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = undefined;
      // A drag orbits the camera; only a click picks or selects.
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      if (props.pick) {
        const entity = entityAt(event.clientX, event.clientY, props.pick);
        if (isBody(entity)) props.onPick?.(entity);
      } else if (props.onSelect) {
        const entity = hoverAt(event.clientX, event.clientY);
        setSelected(isBody(entity) ? entity : undefined);
      }
    };
    const onPointerLeave = () => {
      setHovered(undefined);
      props.onPointer?.(undefined);
    };

    /** A client position in the ViewCube's normalised device coordinates. */
    const cubeNdc = (clientX: number, clientY: number) => {
      const rect = cubeElement.getBoundingClientRect();
      return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    };
    let cubeDown: { x: number; y: number } | undefined;
    const onCubeMove = (event: PointerEvent) => cube.hover(cube.regionAt(cubeNdc(event.clientX, event.clientY)));
    const onCubeDown = (event: PointerEvent) => (cubeDown = { x: event.clientX, y: event.clientY });
    const onCubeUp = (event: PointerEvent) => {
      const start = cubeDown;
      cubeDown = undefined;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const region = cube.regionAt(cubeNdc(event.clientX, event.clientY));
      if (region) turnTo(regionDirection(region));
    };
    const onCubeLeave = () => cube.hover(undefined);
    createEffect(() => {
      if (collapsed()) cube.hover(undefined);
    });
    const onCubeDragStart = (event: DragEvent) => {
      const start = cubeDown ?? { x: event.clientX, y: event.clientY };
      cubeDown = undefined;
      const region = cube.regionAt(cubeNdc(start.x, start.y));
      const name = region && regionName(region);
      const created = region && name ? props.createView?.({ ...cameraState(), direction: vector(regionDirection(region)) }, name) : undefined;
      if (!created || !event.dataTransfer) return event.preventDefault();
      const { url, title } = created;
      // The payload Patchwork's drop targets read, as in the pandoc tool. "all", as the sideboard's
      // own drags: its list asks for "move", and a drop effect the drag doesn't allow cancels the drop.
      event.dataTransfer.effectAllowed = "all";
      event.dataTransfer.setData("text/x-patchwork-urls", JSON.stringify([url]));
      event.dataTransfer.setData("text/x-patchwork-dnd", JSON.stringify({ source: "patchwork-cad", items: [{ url, name: title, type: "cad-model-view" }] }));
      event.dataTransfer.setData("text/plain", url);
      // The cube's element is transparent; drag the region's name instead.
      const image = document.createElement("div");
      image.className = "cad-viewcube__drag";
      image.textContent = title;
      container.append(image);
      event.dataTransfer.setDragImage(image, 0, 0);
      setTimeout(() => image.remove());
    };
    cubeElement.addEventListener("dragstart", onCubeDragStart);
    cubeElement.addEventListener("pointermove", onCubeMove);
    cubeElement.addEventListener("pointerdown", onCubeDown);
    cubeElement.addEventListener("pointerup", onCubeUp);
    cubeElement.addEventListener("pointerleave", onCubeLeave);

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    createEffect(() => {
      // Hover changes kind with the pick target, and picking ends a selection.
      container.dataset["pick"] = props.pick ?? "";
      setHovered(undefined);
      if (props.pick) setSelected(undefined);
    });
    createEffect(() => {
      const entity = hovered();
      props.onHover?.(isBody(entity) ? entity : undefined);
    });
    createEffect(() => props.onSelect?.(selected()));

    const toScreen = (p: THREE.Vector3) => {
      const v = p.clone().project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    };
    const hook: ViewerTestHook = {
      entities: (kind) =>
        rendered.flatMap((r) => {
          const body = r.shape.body;
          const indices = (kind === "face" ? r.shape.faceIndex : r.shape.edgeIndex) ?? [];
          return body ? indices.filter((i) => i >= 0).map((index) => ({ body, kind, index })) : [];
        }),
      highlighted: (style) => highlighted.filter((h) => h.style === style).map((h) => h.entity),
      centroid(entity) {
        const r = rendered.find((x) => x.shape.body === entity.body);
        const geometry = entity.kind === "face" ? r?.mesh.geometry : r?.lines?.geometry;
        const groups = entity.kind === "face" ? r?.shape.faceIndex : r?.shape.edgeIndex;
        if (!geometry || !groups) return undefined;
        const position = geometry.getAttribute("position");
        const index = entity.kind === "face" ? geometry.getIndex() : null;
        const sum = new THREE.Vector3();
        let n = 0;
        geometry.groups.forEach((g, gi) => {
          if (groups[gi] !== entity.index) return;
          for (let i = g.start; i < g.start + g.count; i++) {
            sum.add(new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i));
            n++;
          }
        });
        return n ? (sum.divideScalar(n).toArray() as [number, number, number]) : undefined;
      },
      viewCubePoint(region) {
        if (collapsed()) return undefined;
        cube.orient(camera);
        const ndc = cube.pointOf(region);
        if (!ndc) return undefined;
        const rect = cubeElement.getBoundingClientRect();
        return { x: Math.round(rect.left + ((ndc.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - ndc.y) / 2) * rect.height) };
      },
      cameraDirection: () => direction().toArray() as [number, number, number],
      peerMarkers: () =>
        [...markers].map(([key, m]) => {
          const p = toScreen(m.point);
          return { key, x: Math.round(p.x), y: Math.round(p.y) };
        }),
      screenPoint(entity) {
        const r = rendered.find((x) => x.shape.body === entity.body);
        if (!r) return undefined;
        const candidates = candidatesOf(r, entity.kind, new Set([entity.index]));
        // A point that a click hits reliably: whole pixels, and the same entity a few pixels around it.
        const margin = entity.kind === "face" ? 3 : 1;
        for (const { point } of candidates) {
          const p = toScreen(point);
          const x = Math.round(p.x);
          const y = Math.round(p.y);
          const around = [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]];
          // Overlays such as a dialog or the ViewCube may cover the canvas.
          const onCanvas = around.every(([dx, dy]) => document.elementFromPoint(x + dx!, y + dy!) === canvas);
          if (onCanvas && around.every(([dx, dy]) => same(entityAt(x + dx!, y + dy!, entity.kind), entity))) return { x, y };
        }
        return undefined;
      },
    };
    (container as HTMLDivElement & { cadViewer?: ViewerTestHook }).cadViewer = hook;

    onCleanup(() => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      cubeElement.removeEventListener("pointermove", onCubeMove);
      cubeElement.removeEventListener("pointerdown", onCubeDown);
      cubeElement.removeEventListener("pointerup", onCubeUp);
      cubeElement.removeEventListener("pointerleave", onCubeLeave);
      cubeElement.removeEventListener("dragstart", onCubeDragStart);
      cube.dispose();
      dispose([...group.children, ...overlayGroup.children, ...highlightGroup.children]);
      for (const m of markers.values()) m.label.remove();
      dotGeometry.dispose();
      pmrem.dispose();
      scene.environment?.dispose();
      for (const m of [ringMaterials.line, ringMaterials.halo, faceMaterial, edgeMaterial, lineMaterial, overlayMaterial, ...Object.values(highlightMaterials).flatMap((m) => [m.face, m.line.core, m.line.halo]), ...[...peerMaterials.values()].flatMap((m) => [m.face, m.line.core, m.line.halo, m.marker])]) m.dispose();
      renderer.dispose();
    });
  });

  return (
    <div class="cad-model__viewer" ref={container} data-hovered={entityKey(hovered())} data-selected={entityKey(selected())} data-projection={projection()}>
      <canvas ref={canvas} />
      <div class="cad-viewcube" data-collapsed={collapsed() ? "true" : "false"}>
        <button class="cad-viewcube__button cad-viewcube__button--toggle" aria-label="ViewCube" title={collapsed() ? "Show ViewCube" : "Hide ViewCube"} aria-expanded={!collapsed()} onClick={() => setCollapsed(!collapsed())}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5 14 5V11L8 14.5 2 11V5ZM2 5 8 8.5 14 5M8 8.5V14.5" />
          </svg>
        </button>
        <button class="cad-viewcube__button cad-viewcube__button--home" aria-label="Home view" title="Home view" onClick={() => home()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 8 8 2.5 14 8M4 6.5V13.5H12V6.5" />
          </svg>
        </button>
        <button class="cad-viewcube__button cad-viewcube__button--projection" aria-label="Orthographic" title="Orthographic" aria-pressed={projection() === "orthographic"} onClick={() => toggleProjection()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 5.5H4L5.5 3.5H10.5L12 5.5H14.5V13H1.5Z" />
            <circle cx="8" cy="9" r="2.5" />
          </svg>
        </button>
        <div class="cad-viewcube__cube" ref={cubeElement} draggable={props.createView ? "true" : undefined} />
      </div>
    </div>
  );
}
