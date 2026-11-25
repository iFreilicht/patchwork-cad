import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getEdgeIndex, getFaceIndex, syncFaces, syncLines } from "replicad-threejs-helper";
import type { MeshedShape, RefData, ShownSketch } from "../kernel/protocol.ts";
import type { CameraState, Margins, StoredCamera } from "../types.ts";
import { cameraOf, corners, DEFAULT_MARGINS, expand, fitLens, fitted, inside, marginsOf, meet, overlaps, TAN, tanToShow, trimmed, visibleAt, type Lens, type Rect, type Shot } from "./framing.ts";
import { contactToken } from "./presence.ts";
import { regionDirection, ViewCube, type Region } from "./ViewCube.ts";
import { iconElement } from "./icons.tsx";
import { DOCUMENT_FRAME, DOCUMENT_PX, measureFramesAsLaidOut, presetCamera, scaleCamera, storedCamera } from "./documentCanvases.ts";
import type { DocumentCamera } from "../types.ts";

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
  /** A volume a feature added or removed: its faces without the hover's outline, its edges as thin as the model's. */
  ghost?: boolean;
}

export type HighlightStyle = "hover" | "accent" | "peer";

export interface Entity {
  body: string;
  kind: EntityKind;
  index: number;
}

/** The points of a sketch's paths. */
const sketchVertices = (s: ShownSketch) => s.outline.flatMap((line) => line.points);

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

/**
 * A pin on a face or edge (`createPins`): what is pinned there, comments (research/13-collaboration.md,
 * "Comments") and annotations (research/21, "Annotation"), drawn as their icons, and how many there
 * are if more than one of a kind.
 */
export interface Pin {
  key: string;
  body: string;
  kind: EntityKind;
  indices: number[];
  /** Its tooltip and accessible name, e.g. "2 comments, notes". */
  label: string;
  icons: string[];
  count: number | undefined;
  /** How many threads and annotations it has, for tests and styles. */
  threads: number;
  annotations: number;
  /** One of its threads is focused, e.g. in the Comments panel, or one of its annotations selected or it is open. */
  focused: boolean;
  /** One of its annotations' documents is unavailable. */
  state?: string | undefined;
  /** It is on the selected face or edge. */
  selected?: boolean;
  /** It is new: to comment on the selected face or edge, which has no pin. */
  new?: boolean;
}

/** A canvas (research/21, "Canvas"): an image on a plane, drawn translucently, over the model if `through`. */
export interface ShownCanvas {
  id: string;
  /** The image, drawn once, which the view makes a texture of. */
  image?: HTMLCanvasElement | undefined;
  /** Experiment: any other document, shown live by its tool in a `<patchwork-view>` placed on the plane. */
  document?:
    | {
        url: string;
        tool?: string | undefined;
        bare?: boolean | undefined;
        camera?: DocumentCamera | undefined;
        /** The tool takes its camera from the view's `data-camera` and follows it, as the CAD canvas view of tldraw does; else it is set in `localStorage` before the tool mounts. */
        cameraAttribute?: boolean | undefined;
      }
    | undefined;
  /** Its corners in world coordinates, counterclockwise from the image's bottom left. */
  corners: [number, number, number][];
  opacity: number;
  through: boolean;
  /** Outlined, as a hovered face is, or as a selected one. */
  highlight?: "hover" | "accent" | undefined;
}

/** A region of a sketch to pick, e.g. an extrusion's profile (research/21, "Sketch from a drawing"). */
export interface ShownRegion {
  key: string;
  /** Its triangles in world coordinates: x, y and z of each corner, three corners each. */
  triangles: number[];
  /** Chosen, e.g. extruded: accented. */
  chosen: boolean;
}

export interface ViewerProps {
  shapes: MeshedShape[] | undefined;
  /** Which entities hover and click pick; nothing is pickable without it, and hover takes edges, else faces. */
  pick?: EntityKind | undefined;
  onPick?: (entity: Entity) => void;
  /** Whether the hovered face or edge is highlighted; not while whole bodies are picked, which the caller highlights. */
  hoverHighlight?: boolean;
  /** While picking, the bodies whose entities can be picked; the others fade, and neither hover nor take clicks. All, if not given. */
  pickable?: ((body: string) => boolean) | undefined;
  /** The hovered face or edge of a feature-library body, if any. */
  onHover?: (entity: Entity | undefined) => void;
  /**
   * Makes faces and edges selectable while nothing is picked: a click selects the one under the
   * pointer, a click elsewhere in the view clears it. Called with the selection as it changes.
   */
  onSelect?: (entity: Entity | undefined) => void;
  /** A right click, not a drag, which pans: the face or edge of a feature-library body under the pointer, if any, and where it was. */
  onContextMenu?: (entity: Entity | undefined, at: { x: number; y: number }) => void;
  highlight?: Highlight[] | undefined;
  /**
   * While a build's progress shows, the features it is done with (research/23, "The view"): faces of
   * the shown shapes whose owning features aren't all done are drawn stale.
   */
  built?: { has(feature: string): boolean } | undefined;
  /** Outlines drawn over the model, e.g. of the open sketch, as a hovered edge is. */
  overlays?: Overlay[] | undefined;
  /** The sketches the model shows, drawn as lines on it. */
  sketches?: ShownSketch[] | undefined;
  /** The point on the model under the pointer as it moves, undefined when it is off the model. */
  onPointer?: (point: [number, number, number] | undefined) => void;
  /** Collaborators' pointers. */
  peers?: PeerMarker[] | undefined;
  /** A camera to show, e.g. the one the user last left; it applies whenever it changes. */
  view?: StoredCamera | undefined;
  /** Called when the user has moved the camera: after an orbit, a ViewCube turn, Home or a projection switch. */
  onViewChange?: (view: CameraState) => void;
  /** Where Home goes, the model's Home view if it was changed; else Home frames the model from the front, right and above. */
  home?: StoredCamera | undefined;
  /** Turns faces into references and back, so that a view of a close-up follows what it shows (research/20, "Close-ups"). */
  faceRefs?: FaceRefs | undefined;
  /** Marks the ViewCube's Home button as hovered, e.g. while the Home view is hovered in the browser. */
  homeHovered?: boolean;
  /** Hands over what the view can tell its owner at any time, once it is mounted. */
  onApi?: (api: ViewerApi) => void;
  /** Starts with the ViewCube collapsed to its toggle. The state is local to this mount. */
  collapseViewCube?: boolean;
  /** Pins of comments and annotations, what clicking one does, with the pin's position on the screen, and hovering one. */
  pins?: Pin[] | undefined;
  onPin?: (key: string, at: { x: number; y: number }) => void;
  onPinHover?: (key: string | undefined) => void;
  canvases?: ShownCanvas[] | undefined;
  /**
   * While points of a canvas are picked, e.g. to calibrate it: its id. A click on it gives the point,
   * as fractions of its image from the bottom left; the pointer over it, the point it is over, and
   * nothing of the model is hovered meanwhile.
   */
  canvasPick?: string | undefined;
  onCanvasPick?: (id: string, point: [number, number]) => void;
  onCanvasHover?: (id: string, point: [number, number] | undefined) => void;
  /**
   * While regions of a sketch are picked, e.g. an extrusion's profiles: fills on the sketch's plane,
   * drawn over the model, the chosen ones accented. The pointer hovers the region it is over, a click
   * gives it; nothing of the model is hovered or picked meanwhile.
   */
  regions?: ShownRegion[] | undefined;
  onRegionPick?: (key: string) => void;
  onRegionHover?: (key: string | undefined) => void;
  /**
   * Experiment: a document canvas edited in place, laid over its rectangle on the screen without a
   * 3D transform, at `url`, editable, once the camera has stopped; it is placed for the camera at
   * the start, and should end when the camera moves. Where its tldraw camera was left is reported.
   */
  editing?: { id: string; url: string; tool?: string | undefined; camera?: DocumentCamera | undefined } | undefined;
  onEditCamera?: (id: string, camera: DocumentCamera) => void;
}

export interface FaceRefs {
  /** The references to faces of shown bodies, null for a face that has none. */
  refs(faces: { body: string; index: number }[]): Promise<(RefData | null)[]>;
  /** For each of `refs`, the faces it names in bodies `bodies`. */
  locate(bodies: string[], refs: RefData[]): Promise<{ body: string; indices: number[] }[][]>;
}

export interface ViewerApi {
  /** The camera the view shows now, as onViewChange reports it, once it shows one. */
  camera(): CameraState | undefined;
  /** Goes Home, as the ViewCube's Home button does. */
  home(): void;
  /** Where Home goes now: the model's Home view, or the framing from the front, right and above. */
  homeCamera(): CameraState | undefined;
  /** The world point under a position on the screen, on the model if it is there. */
  pointAt(clientX: number, clientY: number): [number, number, number] | undefined;
  /** The face of a feature-library body at a point on the screen, unless it is off the model, e.g. where a document is dropped (research/21). */
  faceAt(clientX: number, clientY: number): Entity | undefined;
}

/**
 * Two cameras are the same up to rounding, e.g. one reported after moving to the other. A camera
 * with margins or a subject is where it fits them, wherever its target and extent were when stored.
 */
export const nearCamera = (a: StoredCamera | undefined, b: StoredCamera | undefined, tolerance = 1e-6) => {
  if (!a || !b) return false;
  const [x, y] = [cameraOf(a), cameraOf(b)];
  const near = (p: readonly number[], q: readonly number[]) => p.length === q.length && p.every((v, i) => Math.abs(v - q[i]!) <= tolerance * Math.max(1, Math.abs(v)));
  if (x.projection !== y.projection || !near([...x.direction, x.eye ?? 1], [...y.direction, y.eye ?? 1]) || !x.fit !== !y.fit || !x.subject !== !y.subject) return false;
  if (x.fit && y.fit) return near(x.fit, y.fit);
  if (x.subject && y.subject) return near(x.subject.fit, y.subject.fit) && canonical([x.subject.faces, x.subject.sketches]) === canonical([y.subject.faces, y.subject.sketches]);
  return near([...x.target, ...x.extent], [...y.target, ...y.extent]);
};

/** Two cameras are the same; storage may reorder an object's keys. */
export const sameCamera = (a: StoredCamera | undefined, b: StoredCamera | undefined) => !!a && !!b && cameraKey(a) === cameraKey(b);
const cameraKey = (stored: StoredCamera) => {
  const v = cameraOf(stored);
  return canonical([v.direction, v.target, v.extent, v.projection, v.eye ?? 1, v.fit ?? null, v.subject ? [v.subject.faces, v.subject.sketches, v.subject.fit] : null]);
};
/** JSON with every object's keys sorted, as Automerge returns a map's keys in its own order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

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
  /**
   * Where points are on the screen, the model's mesh vertices by default: whether all are in the
   * view, and how much of the view's width or height they span, whichever is more.
   */
  onScreen(points?: [number, number, number][]): { inView: boolean; fill: number; center: [number, number]; clipped: boolean };
  /** The camera's projection, field of view in degrees, zoom, distance from the target and clipping planes. */
  lens(): { projection: Projection; fov: number; zoom: number; distance: number; near: number; far: number };
  /** The camera the view is meant to show (research/20). */
  intent(): CameraState | undefined;
  /** Where the eye is, which decides the perspective. */
  eye(): [number, number, number];
  /** The canvases drawn, with whether their texture is there, their opacity, and their corners on the screen. */
  canvases(): { id: string; opacity: number; through: boolean; highlight: string | undefined; world: [number, number, number][]; corners: { x: number; y: number }[] }[];
  /** Where a point of a canvas's image, as fractions of it from the bottom left, is on the screen. */
  canvasPoint(id: string, u: number, v: number): { x: number; y: number } | undefined;
  /** The regions drawn, whether they are drawn as chosen and as hovered, and for each a point on the screen where a click picks it, if one is in the view. */
  regions(): { key: string; chosen: boolean; hovered: boolean; point: { x: number; y: number } | undefined }[];
}

export type Projection = CameraState["projection"];

/** The direction the camera looks from at first and after Home: front, right and above. */
const HOME_DIRECTION = new THREE.Vector3(0.55, -0.85, 0.65).normalize();
/** The user's own camera refits when a build would show the model, with its margins, less than this part as large (research/20, "When the geometry changes"). */
const REFIT_BELOW = 0.5;
/** A camera that cuts off at most this part of the view's width or height of the model, on a side, was meant to show all of it. */
const SLIVER = 0.02;
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
  /** The drawn edges, of which `lines` is the invisible pick target. */
  wide: LineSegments2 | undefined;
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
/** The sides of triangles (x, y and z of each corner, three corners each) that only one of them has: the outline of what they cover, as pairs of points. */
function boundaryOf(triangles: readonly number[]): number[] {
  const key = (i: number) => `${triangles[3 * i]},${triangles[3 * i + 1]},${triangles[3 * i + 2]}`;
  const sides = new Map<string, { a: number; b: number; count: number }>();
  for (let t = 0; t < triangles.length / 9; t++)
    for (let k = 0; k < 3; k++) {
      const a = 3 * t + k;
      const b = 3 * t + ((k + 1) % 3);
      const id = [key(a), key(b)].sort().join(";");
      const side = sides.get(id);
      if (side) side.count++;
      else sides.set(id, { a, b, count: 1 });
    }
  return [...sides.values()].filter((s) => s.count === 1).flatMap(({ a, b }) => [...triangles.slice(3 * a, 3 * a + 3), ...triangles.slice(3 * b, 3 * b + 3)]);
}

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
    /**
     * The height the orthographic camera shows: always as much as the perspective camera shows at the
     * target from the same distance, so that the distance means the same in both and switching keeps
     * the view. Its zoom is folded into the distance.
     */
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
    // Bodies that can't be picked: see-through, so that they don't hide the ones that can.
    const fadedFaceMaterial = new THREE.MeshStandardMaterial({ color: themeColor(container, "--cad-model-shape"), roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false });
    const fadedEdgeMaterial = new LineMaterial({ color: themeColor(container, "--cad-model-edge").getHex(), linewidth: 1.5 * contrast, transparent: true, opacity: 0.3, depthWrite: false });
    // Picking raycasts 1 px lines, which aren't drawn.
    const lineMaterial = new THREE.LineBasicMaterial({ visible: false });
    const accent = themeColor(container, "--cad-model-accent");
    const background = themeColor(container, "--cad-model-bg");
    // Faces of the last result that a running build hasn't reached (research/23, "The view"): see-through as unpickable bodies are, which reads as "not there yet" in both themes, whatever the shading.
    const staleMaterial = fadedFaceMaterial;
    // Lines need the contrast of the text variant, e.g. a sketch outline against a light background.
    const accentLine = themeColor(container, "--cad-model-accent-text");
    const hover = themeColor(container, "--cad-model-hover");
    const sketchMaterial = wideLine(accentLine, 1.5, false);
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
    /** A ghost's edges, as wide as the model's, in the highlight's colour. */
    const ghostLines = new Map<string, LineMaterial>();
    const ghostLine = (h: Highlight) => {
      const css = h.style === "peer" ? (h.color ?? "#888") : "";
      let m = ghostLines.get(css);
      if (!m) {
        m = wideLine(css ? new THREE.Color().setStyle(css, THREE.SRGBColorSpace) : accentLine, 1.5, true);
        ghostLines.set(css, m);
      }
      return m;
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
    const overlayMaterials = [highlightMaterials.hover.line.halo, highlightMaterials.hover.line.core];
    const materialsOf = (h: Highlight) => (h.style === "peer" ? peerMaterial(h.color ?? "#888") : highlightMaterials[h.style]);
    const group = new THREE.Group();
    const sketchGroup = new THREE.Group();
    const overlayGroup = new THREE.Group();
    overlayGroup.renderOrder = 1;
    const highlightGroup = new THREE.Group();
    highlightGroup.renderOrder = 2;
    const peerGroup = new THREE.Group();
    peerGroup.renderOrder = 3;
    const canvasGroup = new THREE.Group();
    // Documents on canvases (experiment): DOM placed in 3D, below the WebGL canvas, which punches
    // transparent holes where they lie so that the model hides them where it is in front; or, drawn
    // through the model, above it.
    const cssLayers = (["below", "above"] as const).map((where) => {
      const css = new CSS3DRenderer();
      css.domElement.className = `cad-model__documents cad-model__documents--${where}`;
      css.domElement.style.position = "absolute";
      css.domElement.style.inset = "0";
      css.domElement.style.pointerEvents = "none";
      css.domElement.style.zIndex = where === "below" ? "0" : "1";
      return { css, scene: new THREE.Scene() };
    });
    canvas.after(cssLayers[0]!.css.domElement);
    cssLayers[0]!.css.domElement.after(cssLayers[1]!.css.domElement);
    /**
     * While documents lie below the view's canvas's other layers, a second WebGL canvas above them draws
     * the scene again, behind a depth-only pass of the documents' rectangles: only what is in front of a
     * document. The page then composes the scene, the documents with their own opacity and transparency,
     * and what is in front of them. Made once a document is shown; it has its own context, so its own
     * environment map.
     */
    let upper: { renderer: THREE.WebGLRenderer; environment: THREE.Texture } | undefined;
    const upperRenderer = () => {
      if (!upper) {
        const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        r.setPixelRatio(renderer.getPixelRatio());
        r.setSize(width, height, false);
        r.domElement.className = "cad-model__front";
        r.domElement.style.pointerEvents = "none";
        r.domElement.style.zIndex = "0";
        cssLayers[0]!.css.domElement.after(r.domElement);
        const generator = new THREE.PMREMGenerator(r);
        upper = { renderer: r, environment: generator.fromScene(new RoomEnvironment(), 0.04).texture };
        generator.dispose();
      }
      return upper;
    };
    const regionGroup = new THREE.Group();
    regionGroup.renderOrder = 1;
    scene.add(group, canvasGroup, sketchGroup, regionGroup, overlayGroup, highlightGroup, peerGroup);
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

    /** Where the camera is: it looks from `direction` at `target`, `distance` away. */
    interface Pose {
      direction: THREE.Vector3;
      target: THREE.Vector3;
      distance: number;
      /** The perspective camera's vertical field of view, in degrees. */
      fov: number;
    }
    const pose = (): Pose => ({ direction: direction(), target: controls.target.clone(), distance: distance(), fov: perspective.fov });
    const place = (p: Pose) => {
      perspective.fov = p.fov;
      controls.target.copy(p.target);
      camera.position.copy(p.target).addScaledVector(p.direction, p.distance);
      orthoHeight = heightAt(p.distance);
      orthographic.zoom = 1;
      updateProjection();
      controls.update();
      camera.updateMatrixWorld();
      clip();
    };
    /** OrbitControls zoom the orthographic camera: folded into its distance, which then shows as much (`orthoHeight`). */
    const foldZoom = () => {
      if (camera !== orthographic || orthographic.zoom === 1) return;
      const d = distance() / orthographic.zoom;
      const along = direction();
      orthographic.position.copy(controls.target).addScaledVector(along, d);
      orthographic.zoom = 1;
      orthoHeight = heightAt(d);
      updateProjection();
      orthographic.updateMatrixWorld();
    };
    // Before "end", which measures the camera.
    controls.addEventListener("change", foldZoom);
    const drawn = new THREE.Box3();
    const drawnSphere = new THREE.Sphere();
    /**
     * Puts the clipping planes around everything drawn, as the camera is now: a range fixed when the
     * camera was placed cuts off the model's front once it dollies close, and all of it once it dollies
     * far away. The orthographic camera's near plane may be behind the eye, which it shows past.
     */
    const clip = () => {
      const d = distance();
      let near = d / 300;
      let far = d * 33;
      if (!drawn.setFromObject(scene).isEmpty()) {
        drawn.getBoundingSphere(drawnSphere);
        const depth = camera.position.clone().sub(drawnSphere.center).dot(direction());
        const reach = drawnSphere.radius * 1.01 + d * 1e-3;
        far = Math.max(far, depth + reach);
        if (camera === orthographic) near = Math.min(near, depth - reach);
      }
      if (camera.near === near && camera.far === far) return;
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    };

    // Rounded: Automerge 3.4.1 stores 0.9999999999999999 in a list as 0 (research/10-view-state.md).
    const round = (x: number) => Math.round(x * 1e9) / 1e9;
    const vector = (v: THREE.Vector3) => v.toArray().map(round) as [number, number, number];
    const roundRef = (ref: RefData): RefData => (ref.near ? { ...ref, near: ref.near.map(round) as [number, number, number] } : ref);

    /**
     * A running move of the camera, e.g. to a ViewCube region; `data-turning` tells tests to wait for
     * its end. One that shows `intent` follows it when the viewport resizes or the model changes.
     */
    let turn: { from: Pose; to: Pose; rotation: THREE.Quaternion; start: number; onEnd: (() => void) | undefined; intent: Intent | undefined } | undefined;
    const setTurn = (next: typeof turn) => {
      turn = next;
      container.dataset["turning"] = String(!!turn);
    };
    /** Moves the camera to `to`, animated unless the user prefers reduced motion, and calls `onEnd` at the end. */
    const moveTo = (to: Partial<Pose>, onEnd?: () => void, shows?: Intent) => {
      const from = pose();
      const end = { ...from, ...to };
      setTurn({ from, to: end, rotation: new THREE.Quaternion().setFromUnitVectors(from.direction, end.direction), start: performance.now(), onEnd, intent: shows });
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
        fov: THREE.MathUtils.lerp(from.fov, to.fov, eased),
      });
      if (t === 1) {
        const done = turn;
        setTurn(undefined);
        done.onEnd?.();
      }
    };
    /** Whether the view has shown a camera yet; until then, cameras apply at once instead of moving there. */
    let shown = false;

    // ---------- framing (research/20-view-framing.md) ----------

    /** The model's size, for picking tolerances. */
    let radius = 50;
    /** The corners of each shown body's bounding box, which a fit of the whole model uses (research/20, "Fitting"). */
    let bodyCorners: THREE.Vector3[] = [];
    const modelPoints = () => [...bodyCorners, ...(props.sketches ?? []).flatMap((s) => sketchVertices(s).map((p) => new THREE.Vector3(...p)))];
    const lens = (): Lens => ({ perspective: camera === perspective, aspect: width / height, tan: Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2)) });
    /** What the camera shows now: its height at the target. */
    const shot = (): Shot => ({ direction: direction(), target: controls.target.clone(), height: heightAt(distance()) });

    /**
     * What the camera is meant to show: a camera given to the view, e.g. a named view, which a build
     * fits again exactly, or the user's own, which follows builds less eagerly; resizes refit both.
     * A close-up's `subject` is located in the shown bodies, `points` once it is.
     */
    interface Intent {
      camera: CameraState;
      given: boolean;
      points?: THREE.Vector3[];
      /** It has only a region, e.g. it was stored before research/20, and is classified once the model shows (`classify`). */
      classify?: boolean;
    }
    let intent: Intent | undefined;

    /** The rectangle `i` shows now: its margins around the model or its subject's points, else its extent around its target. */
    const rectOf = (i: Intent): Rect => {
      const { camera: c } = i;
      const along = new THREE.Vector3(...c.direction).normalize();
      const around = (points: THREE.Vector3[], margins: Margins) => {
        const fit = fitted(points, along, fitLens(camera === perspective));
        return fit && expand(fit, margins, along);
      };
      const rect = c.fit ? around(modelPoints(), c.fit) : c.subject && i.points?.length ? around(i.points, c.subject.fit) : undefined;
      return rect ?? { center: new THREE.Vector3(...c.target), width: c.extent[0], height: c.extent[1] };
    };
    /**
     * Where `i` puts the camera: the eye at its distance from the rectangle it shows, which doesn't
     * depend on the viewport, so that a resize doesn't change the perspective; the field of view
     * widens or narrows to show the rectangle (research/20, "The design").
     */
    const poseOf = (i: Intent): Pose => {
      const rect = rectOf(i);
      const along = new THREE.Vector3(...i.camera.direction).normalize();
      const distance = ((i.camera.eye ?? 1) * Math.max(rect.width, rect.height)) / (2 * TAN);
      let tan = meet(rect.width, rect.height, width / height) / (2 * distance);
      // The model's nearest and farthest parts look larger or smaller than the plane through its middle, which the margins are measured in.
      if (i.camera.fit && camera === perspective) tan = Math.max(tan, tanToShow(modelPoints(), rect.center, along, distance, width / height));
      return { direction: along, target: rect.center, distance, fov: Math.min(170, THREE.MathUtils.radToDeg(2 * Math.atan(tan))) };
    };
    /** Shows the intent as the model or the viewport now are: by moving there, or by carrying a running move there. */
    const follow = () => {
      if (!intent) return;
      const to = poseOf(intent);
      if (turn?.intent === intent) turn.to = to;
      else if (!turn) place(to);
    };

    /**
     * The margins the fit of `points` has in the view now. What is in the view is decided by the
     * meshes; the box corners a fit uses may stick out of it, e.g. of a slanted face, so margins
     * are at least zero.
     */
    const marginsNow = (points: THREE.Vector3[]): Margins | undefined => {
      const s = shot();
      const fit = fitted(points, s.direction, fitLens(camera === perspective));
      return fit && (marginsOf(fit, trimmed(fit, visibleAt(s, lens(), fit.center), s.direction), s.direction).map((m) => round(Math.max(0, m))) as Margins);
    };
    const projected = new THREE.Vector3();
    /** Whether a point is in the view, or at most `sliver` of the view's width or height out of it on a side. */
    const inView = (p: THREE.Vector3, sliver = 0) => {
      projected.copy(p).project(camera);
      const edge = 1 + 2 * sliver;
      return Math.abs(projected.x) <= edge && Math.abs(projected.y) <= edge && Math.abs(projected.z) <= 1;
    };
    /** Whether all of the model is in the view: every vertex of its meshes, and its sketches; a camera that cuts off a sliver of it was still meant to show it all. */
    const modelInView = () => {
      const v = new THREE.Vector3();
      for (const r of rendered) {
        const position = r.mesh.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) if (!inView(v.fromBufferAttribute(position, i), SLIVER)) return false;
      }
      return (props.sketches ?? []).every((s) => sketchVertices(s).every((p) => inView(v.set(...p), SLIVER)));
    };
    /** The eye's distance from `rect`, in multiples of the distance at which `rect` just fits a square 45° view (`CameraState.eye`). */
    const eyeFor = (rect: Rect) => round((camera.position.clone().sub(rect.center).dot(direction()) * 2 * TAN) / Math.max(rect.width, rect.height));
    /** The camera as it is now: its margins around the model if it shows all of it, else its rectangle (research/20). */
    const measure = (): CameraState => {
      const s = shot();
      const extent: [number, number] = [s.height * (width / height), s.height];
      const camera: CameraState = { direction: vector(s.direction), target: vector(s.target), extent: [round(extent[0]), round(extent[1])], projection: projection(), eye: eyeFor({ center: s.target, width: extent[0], height: extent[1] }) };
      const fit = modelInView() ? marginsNow(modelPoints()) : undefined;
      const fitRect = fit && fitted(modelPoints(), s.direction, fitLens(projection() === "perspective"));
      if (fit && fitRect) return { ...camera, fit, eye: eyeFor(expand(fitRect, fit, s.direction)) };
      return camera;
    };
    /** Makes the camera as it is now the user's. */
    const rebase = () => {
      intent = { camera: measure(), given: false };
    };
    /**
     * A given camera with only a region, e.g. one stored before research/20 or one that cut off a
     * sliver of the model: once the model is shown in it, it gets margins if it shows all of the model,
     * as it would if saved now.
     */
    const classify = (i: Intent) => {
      if (!i.classify || !modelPoints().length || intent !== i || turn) return;
      i.classify = false;
      const now = measure();
      if (now.fit) i.camera = { ...i.camera, fit: now.fit, eye: now.eye ?? 1 };
    };
    /** The user moved the camera: it is theirs now, and reported; a close-up finds its subject. */
    const moved = () => {
      rebase();
      report();
      if (intent && !intent.camera.fit) void findSubject(intent);
    };

    /** The faces of a shown body whose every vertex is in the view. */
    const facesInView = (r: Rendered): number[] => {
      const position = r.mesh.geometry.getAttribute("position");
      const index = r.mesh.geometry.getIndex();
      const v = new THREE.Vector3();
      const faces: number[] = [];
      r.mesh.geometry.groups.forEach((g, gi) => {
        const face = r.shape.faceIndex?.[gi] ?? -1;
        if (face < 0) return;
        for (let i = g.start; i < g.start + g.count; i++) if (!inView(v.fromBufferAttribute(position, index ? index.getX(i) : i))) return;
        faces.push(face);
      });
      return faces;
    };
    /** The face that covers most of the view, sampled on a grid, if any face is in it. */
    const faceCoveringView = (): { body: string; index: number } | undefined => {
      const counts = new Map<string, { body: string; index: number; n: number }>();
      const meshes = rendered.filter((r) => r.shape.body).map((r) => r.mesh);
      const N = 12;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          aim(new THREE.Vector2(((i + 0.5) / N) * 2 - 1, ((j + 0.5) / N) * 2 - 1));
          const hit = raycaster.intersectObjects(meshes, false)[0];
          const r = hit && rendered.find((x) => x.mesh === hit.object);
          if (!r?.shape.body || hit?.faceIndex == null) continue;
          const index = groupEntity(r.shape.faceIndex, getFaceIndex(hit.faceIndex, r.mesh.geometry));
          if (index < 0) continue;
          const key = `${r.shape.body}:${index}`;
          const c = counts.get(key) ?? { body: r.shape.body, index, n: 0 };
          c.n++;
          counts.set(key, c);
        }
      return [...counts.values()].sort((a, b) => b.n - a.n)[0];
    };
    /** Points on faces: the corners of each one's bounding box. */
    const facePoints = (located: { body: string; indices: number[] }[]): THREE.Vector3[] =>
      located.flatMap(({ body, indices }) => {
        const r = rendered.find((x) => x.shape.body === body);
        if (!r) return [];
        const wanted = new Set(indices);
        const position = r.mesh.geometry.getAttribute("position");
        const index = r.mesh.geometry.getIndex();
        return r.mesh.geometry.groups.flatMap((g, gi) => {
          if (!wanted.has(r.shape.faceIndex?.[gi] ?? -1)) return [];
          const box = new THREE.Box3();
          for (let i = g.start; i < g.start + g.count; i++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i));
          return corners(box);
        });
      });
    const sketchPoints = (names: readonly string[]) => (props.sketches ?? []).filter((s) => names.includes(s.name)).flatMap((s) => sketchVertices(s).map((p) => new THREE.Vector3(...p)));
    /**
     * Finds what a close-up shows, so that a view saved from it follows it (research/20, "Close-ups"):
     * the faces and sketches entirely in it, else the face that covers most of it, shown with the
     * default margin, else nothing of the model, and it fits the model from its direction.
     */
    const findSubject = async (i: Intent) => {
      if (!props.faceRefs) return;
      const inside = rendered.flatMap((r) => (r.shape.body ? facesInView(r).map((index) => ({ body: r.shape.body!, index })) : []));
      const insideSketches = (props.sketches ?? []).filter((s) => sketchVertices(s).every((p) => inView(new THREE.Vector3(...p)))).map((s) => s.name);
      const covering = inside.length || insideSketches.length ? undefined : faceCoveringView();
      if (!inside.length && !insideSketches.length && !covering) {
        i.camera = { ...i.camera, fit: DEFAULT_MARGINS };
        return report();
      }
      const faces = covering ? [covering] : inside;
      const sketches = covering ? [] : insideSketches;
      const fit = covering ? DEFAULT_MARGINS : marginsNow([...facePoints(faces.map((f) => ({ body: f.body, indices: [f.index] }))), ...sketchPoints(sketches)])!;
      const made = faces.length ? await props.faceRefs.refs(faces) : [];
      if (intent !== i) return;
      const found = made.flatMap((ref) => (ref ? [roundRef(ref)] : []));
      if (!found.length && !sketches.length) return;
      i.camera = { ...i.camera, subject: { faces: found, sketches, fit } };
      report();
    };
    /** Locates a close-up's subject in the shown bodies and shows it there, if the camera still shows `i`. */
    const locateSubject = async (i: Intent) => {
      const subject = i.camera.subject;
      if (!subject || !props.faceRefs) return;
      const bodies = rendered.flatMap((r) => (r.shape.body ? [r.shape.body] : []));
      const found = subject.faces.length && bodies.length ? await props.faceRefs.locate(bodies, subject.faces) : [];
      if (intent !== i) return;
      i.points = [...facePoints(found.flat()), ...sketchPoints(subject.sketches)];
      follow();
    };

    /** Shows `camera`, given from outside: animated once the view has shown a camera, at once when it opens; `onEnd` runs at the end. */
    const apply = (stored: StoredCamera, onEnd?: () => void) => {
      setTurn(undefined);
      const given = cameraOf(stored);
      if (given.projection !== projection()) toggleProjection(false);
      const next: Intent = { camera: given, given: true, classify: !given.fit && !given.subject };
      intent = next;
      if (shown)
        moveTo(poseOf(next), () => {
          classify(next);
          onEnd?.();
        }, next);
      else {
        shown = true;
        place(poseOf(next));
        classify(next);
      }
      if (given.subject) void locateSubject(next);
    };
    /** The Home view before anyone changed it: the model from the front, right and above, with the default margins. */
    const defaultHome = (): CameraState => {
      const camera: CameraState = { direction: vector(HOME_DIRECTION), target: [0, 0, 0], extent: [1, 1], projection: projection(), fit: DEFAULT_MARGINS };
      const rect = rectOf({ camera, given: true });
      return { ...camera, target: vector(rect.center), extent: [round(rect.width), round(rect.height)] };
    };
    /** The model changed: a given camera fits it again; the user's own refits only if the model left it or shrank to less than half (research/20, "When the geometry changes"). */
    const refit = () => {
      const points = modelPoints();
      if (!points.length) return;
      if (!shown || !intent) return apply(props.home ?? defaultHome());
      if (intent.given) {
        classify(intent);
        if (intent.camera.subject) void locateSubject(intent);
        else follow();
        return;
      }
      if (turn) return;
      const s = shot();
      const fit = fitted(points, s.direction, fitLens(camera === perspective))!;
      if (intent.camera.fit) {
        // Within the band, the camera stays and keeps its margins, which a later refit or resize shows again.
        const wanted = expand(fit, intent.camera.fit, s.direction);
        if (!inside(fit, visibleAt(s, lens(), fit.center), s.direction) || meet(wanted.width, wanted.height, lens().aspect) < REFIT_BELOW * visibleAt(s, lens(), wanted.center).height) follow();
      } else if (!overlaps(fit, visibleAt(s, lens(), fit.center), s.direction)) {
        intent = { camera: { ...intent.camera, fit: DEFAULT_MARGINS }, given: false };
        follow();
      }
    };

    /** The ViewCube's square in the canvas, in CSS pixels from the bottom left, as three.js's viewport wants it. */
    const cubeViewport = () => {
      const cubeRect = cubeElement.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      return { x: cubeRect.left - rect.left, y: rect.bottom - cubeRect.bottom, size: cubeRect.width };
    };
    /** Whether the user is dragging the camera, whose intent is then older than what the view shows. */
    let dragging = false;
    const resize = () => {
      if (dragging) rebase();
      width = container.clientWidth || 1;
      height = container.clientHeight || 1;
      updateProjection();
      renderer.setSize(width, height, false);
      upper?.renderer.setSize(width, height, false);
      for (const layer of cssLayers) layer.css.setSize(width, height);
      follow();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    /** Turns to look from `to`: a camera that shows the whole model fits it from there with its margins, a close-up turns around its target. */
    const turnTo = (to: THREE.Vector3) => {
      const fit = intent?.camera.fit;
      if (!fit) return moveTo({ direction: to }, moved);
      const turned: Intent = { camera: { ...intent!.camera, direction: vector(to) }, given: false };
      intent = turned;
      moveTo(poseOf(turned), moved, turned);
    };
    controls.addEventListener("start", () => {
      setTurn(undefined);
      dragging = true;
    });

    home = () => apply(props.home ?? defaultHome(), report);
    toggleProjection = (byUser = true) => {
      setTurn(undefined);
      // Both show as much from the same distance (`orthoHeight`).
      const next = camera === perspective ? orthographic : perspective;
      next.position.copy(camera.position);
      next.quaternion.copy(camera.quaternion);
      orthoHeight = heightAt(distance());
      orthographic.zoom = 1;
      camera = next;
      controls.object = camera;
      updateProjection();
      controls.update();
      clip();
      setProjection(camera === perspective ? "perspective" : "orthographic");
      if (byUser) moved();
    };

    const key = cameraKey;
    /** The camera this view last reported or applied, so that it doesn't apply its own state again. */
    let reported: string | undefined;
    const report = () => {
      if (!intent) return;
      reported = key(intent.camera);
      props.onViewChange?.(intent.camera);
    };
    controls.addEventListener("end", () => {
      dragging = false;
      moved();
    });

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
      clip();
      placeLight();
      placeMarkers();
      placeFloating();
      // With documents below, what is drawn over everything is drawn above them, and the rest twice.
      const documentsBelow = drawnCanvases.some((d) => !d.canvas.image && !d.canvas.through);
      const onTop = [highlightGroup, overlayGroup, peerGroup];
      if (documentsBelow) for (const g of onTop) g.visible = false;
      renderer.render(scene, camera);
      let top = renderer;
      if (documentsBelow) {
        for (const g of onTop) g.visible = true;
        const u = upperRenderer();
        const punches = drawnCanvases.filter((d) => !d.canvas.image && !d.canvas.through).map((d) => d.mesh);
        for (const m of punches) m.visible = true;
        const environment = scene.environment;
        scene.environment = u.environment;
        u.renderer.render(scene, camera);
        scene.environment = environment;
        for (const m of punches) m.visible = false;
        u.renderer.domElement.style.display = "block";
        top = u.renderer;
      } else if (upper) {
        // Not `hidden`, which three's inline `display: block` overrides: the canvas would keep its last frame over the view.
        upper.renderer.domElement.style.display = "none";
      }
      cullDocuments();
      for (const layer of cssLayers) if (layer.scene.children.length) layer.css.render(layer.scene, camera);
      connectDocuments();
      placeEditing();
      if (!collapsed()) renderCube(top);
      frameId = requestAnimationFrame(tick);
    };
    /** Draws the ViewCube on the topmost canvas. */
    const renderCube = (on: THREE.WebGLRenderer) => {
      cube.orient(camera);
      const { x, y, size } = cubeViewport();
      on.setScissorTest(true);
      on.setScissor(x, y, size, size);
      on.setViewport(x, y, size, size);
      on.autoClear = false;
      on.clearDepth();
      on.render(cube.scene, cube.camera);
      on.autoClear = true;
      on.setScissorTest(false);
      on.setViewport(0, 0, width, height);
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
        let wide: LineSegments2 | undefined;
        if (shape.edges) {
          const geometry = new THREE.BufferGeometry();
          syncLines(geometry, shape.edges);
          lines = new THREE.LineSegments(geometry, lineMaterial);
          group.add(lines);
          wide = wideSegments(geometry, edgeMaterial);
          group.add(wide);
        }
        return { shape, id: shape.body ?? `#${i}`, mesh, lines, wide };
      });
      container.dataset["vertices"] = String(vertices);
      // Indices may name other entities in the new shapes.
      setHovered(undefined);
      setSelected(undefined);
      for (const r of rendered) r.mesh.geometry.computeBoundingBox();
      bodyCorners = rendered.flatMap((r) => corners(r.mesh.geometry.boundingBox!));
      radius = new THREE.Box3().setFromPoints(bodyCorners).getBoundingSphere(new THREE.Sphere()).radius || 50;
      // A view that shows no camera yet opens at the model's Home (research/18, "Home").
      refit();
      setRenders((n) => n + 1);
      shapesVersion++;
    });

    /** Whether a rendered shape can be picked now. */
    const pickableShape = (r: Rendered) => !props.pick || !props.pickable || props.pickable(r.id);
    createEffect(() => {
      renders();
      for (const r of rendered) {
        const faded = !pickableShape(r);
        // Groups of stale faces take the second material (see below).
        r.mesh.material = [faded ? fadedFaceMaterial : faceMaterial, staleMaterial];
        if (r.wide) r.wide.material = faded ? fadedEdgeMaterial : edgeMaterial;
      }
      container.dataset["faded"] = rendered.filter((r) => !pickableShape(r)).map((r) => r.id).join(" ");
    });

    // A running build's stale faces (research/23, "The view"): a face is stale until every feature that created or changed it has run again.
    createEffect(() => {
      renders();
      const built = props.built;
      let stale = 0;
      for (const r of rendered) {
        const faces = new Set<number>();
        if (built) for (const [feature, shaped] of Object.entries(r.shape.shapers ?? {})) if (!built.has(feature)) for (const face of shaped) faces.add(face);
        r.mesh.geometry.groups.forEach((g, gi) => (g.materialIndex = faces.has(groupEntity(r.shape.faceIndex, gi)) ? 1 : 0));
        stale += faces.size;
      }
      container.dataset["stale"] = String(stale);
    });

    /** The highlighted entities by style, for tests. */
    let highlighted: { style: HighlightStyle; entity: Entity }[] = [];
    createEffect(() => {
      renders();
      dispose([...highlightGroup.children]);
      highlightGroup.clear();
      const own = (entity: Entity | undefined, style: HighlightStyle): Highlight[] => (entity ? [{ body: entity.body, kind: entity.kind, indices: [entity.index], style }] : []);
      const all = [...(props.highlight ?? []), ...own(selected(), "accent"), ...(props.hoverHighlight === false ? [] : own(hovered(), "hover"))];
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
          if (h.style === "hover" && !h.ghost) {
            const edges = outline(geometry);
            highlightGroup.add(...[line.halo, line.core].map((material, i) => Object.assign(wideSegments(edges, material), { renderOrder: i })));
            edges.dispose();
          }
          if (hoveredSelectedFace && ownHover) geometry.dispose();
        }
        else if (!(ringed && h.style === "hover" && same({ body: h.body, kind: h.kind, index: h.indices[0]! }, hovered()))) {
          const ring = ringed && h.style === "accent" && same({ body: h.body, kind: h.kind, index: h.indices[0]! }, selected());
          // Outermost first; a ghost's edges are a thin line alone.
          const layers = h.ghost ? [ghostLine(h)] : [...(ring ? [ringMaterials.halo, ringMaterials.line] : []), line.halo, line.core];
          highlightGroup.add(...layers.map((material, i) => Object.assign(wideSegments(geometry, material), { renderOrder: i })));
          geometry.dispose();
        } else geometry.dispose();
      }
    });

    /** A polyline as the segments of a wide line. */
    const segments = (overlay: Overlay) => {
      const { points, closed } = overlay;
      const ends = points.slice(0, closed ? undefined : -1).flatMap((p, i) => [...p, ...points[(i + 1) % points.length]!]);
      return new LineSegmentsGeometry().setPositions(ends);
    };
    createEffect(() => {
      dispose([...sketchGroup.children]);
      sketchGroup.clear();
      for (const sketch of props.sketches ?? []) for (const line of sketch.outline) sketchGroup.add(new LineSegments2(segments(line), sketchMaterial));
      container.dataset["sketches"] = (props.sketches ?? []).map((sketch) => sketch.name).join(" ");
    });
    createEffect(() => {
      dispose([...overlayGroup.children]);
      overlayGroup.clear();
      for (const overlay of props.overlays ?? []) overlayGroup.add(...overlayMaterials.map((material, i) => Object.assign(new LineSegments2(segments(overlay), material), { renderOrder: i })));
      container.dataset["overlays"] = String(props.overlays?.length ?? 0);
    });

    // ---------- regions of a sketch (research/21, "Sketch from a drawing") ----------

    // Over the model, as highlights are: a sketch on a face lies in it. As faces are (research/14): a
    // hovered region has the hover's fill and outline, a chosen one the selection's fill, and a chosen
    // one hovered both, so that every state differs. One neither shows only its sketch's thin curves,
    // and its mesh only takes the pointer.
    const regionMaterials = {
      chosen: highlightFace(accent, 0.5),
      hovered: highlightFace(hover, 0.35),
      chosenHovered: highlightFace(accent, 0.65),
      other: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    };
    const [hoveredRegion, setHoveredRegion] = createSignal<string>();
    let drawnRegions: { region: ShownRegion; mesh: THREE.Mesh; outline: () => number[] }[] = [];
    const regionMaterial = (region: ShownRegion, hovered: string | undefined) =>
      region.key === hovered ? (region.chosen ? regionMaterials.chosenHovered : regionMaterials.hovered) : region.chosen ? regionMaterials.chosen : regionMaterials.other;
    const regionOutline = new THREE.Group();
    regionOutline.renderOrder = 2;
    scene.add(regionOutline);
    /** Draws the materials and the outline of the regions for the hovered one. */
    const drawRegionStates = (hovered: string | undefined) => {
      for (const d of drawnRegions) d.mesh.material = regionMaterial(d.region, hovered);
      dispose([...regionOutline.children]);
      regionOutline.clear();
      const outline = drawnRegions.find((d) => d.region.key === hovered)?.outline();
      if (outline?.length) regionOutline.add(...overlayMaterials.map((material, i) => Object.assign(new LineSegments2(new LineSegmentsGeometry().setPositions(outline), material), { renderOrder: i })));
    };
    createEffect(() => {
      for (const d of drawnRegions) d.mesh.geometry.dispose();
      regionGroup.clear();
      drawnRegions = (props.regions ?? []).map((region) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(region.triangles, 3));
        const mesh = new THREE.Mesh(geometry, regionMaterials.other);
        regionGroup.add(mesh);
        let outline: number[] | undefined;
        return { region, mesh, outline: () => (outline ??= boundaryOf(region.triangles)) };
      });
      // Drawn as they are now, whichever of this and the effect that follows hovering runs first.
      const hovered = untrack(hoveredRegion);
      if (hovered !== undefined && !drawnRegions.some((d) => d.region.key === hovered)) setHoveredRegion(undefined);
      else drawRegionStates(hovered);
    });
    createEffect(() => {
      const hovered = hoveredRegion();
      drawRegionStates(hovered);
      container.dataset["regionHovered"] = hovered ?? "";
      props.onRegionHover?.(hovered);
    });
    /** The region under a canvas position: the nearest, as they all lie in one plane and over the model. */
    const regionAt = (clientX: number, clientY: number): string | undefined => {
      if (!drawnRegions.length) return undefined;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      aim(pointer);
      const hit = raycaster.intersectObjects(drawnRegions.map((d) => d.mesh), false)[0];
      return hit && drawnRegions.find((d) => d.mesh === hit.object)?.region.key;
    };

    // ---------- canvases (research/21, "Canvas") ----------

    /** A texture per drawn image, kept while a canvas shows it. */
    const textures = new Map<HTMLCanvasElement, THREE.CanvasTexture>();
    let drawnCanvases: { canvas: ShownCanvas; mesh: THREE.Mesh }[] = [];
    /** The documents shown, by canvas id: kept while their URL and tool stay, so that the tool isn't mounted again. */
    const documentViews = new Map<string, { key: string; object: CSS3DObject; frame: HTMLDivElement; view: HTMLElement; doc: NonNullable<ShownCanvas["document"]>; corners: THREE.Vector3[] }>();
    /**
     * Hides documents seen edge on or reaching behind the camera: their box on the screen degenerates,
     * and a tool that sizes a canvas by it, as tldraw does, makes one larger than browsers allow
     * (Firefox: "Canvas exceeds max size"). They show nothing then anyway.
     */
    const cullDocuments = () => {
      const toCamera = new THREE.Vector3();
      const inView = new THREE.Vector3();
      for (const d of documentViews.values()) {
        const [a, b, , top] = d.corners as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const normal = b.clone().sub(a).cross(top.clone().sub(a)).normalize();
        const centre = a.clone().lerp(d.corners[2]!, 0.5);
        if (camera === perspective) toCamera.copy(camera.position).sub(centre).normalize();
        else toCamera.copy(direction());
        const edgeOn = Math.abs(normal.dot(toCamera)) < 0.05;
        const behind = d.corners.some((p) => inView.copy(p).applyMatrix4(camera.matrixWorldInverse).z > -camera.near);
        d.object.visible = !edgeOn && !behind;
      }
    };
    /**
     * Puts each view into its frame once the renderer has put the frame into the page, and gives it its
     * document only then, in the same task: a `<patchwork-view>` that gets `doc-url` while it isn't
     * connected starts loading at once (its `attributeChangedCallback`), asks for the document with an
     * event no provider can hear, waits for the answer forever, and doesn't start again once connected.
     */
    const connectDocuments = () => {
      for (const d of documentViews.values()) {
        if (!d.frame.isConnected || d.view.isConnected) continue;
        d.view.setAttribute("doc-url", d.doc.url);
        if (d.doc.tool) d.view.setAttribute("tool-id", d.doc.tool);
        d.frame.append(d.view);
      }
    };
    const placeDocuments = (list: ShownCanvas[]) => {
      for (const [id, d] of documentViews) {
        if (list.some((c) => c.id === id)) continue;
        d.object.removeFromParent();
        d.frame.remove();
        documentViews.delete(id);
      }
      for (const c of list) {
        const doc = c.document!;
        // A camera the tool follows by itself changes no more than an attribute.
        const key = JSON.stringify(doc.cameraAttribute ? { ...doc, camera: undefined } : doc);
        let d = documentViews.get(c.id);
        if (d?.key !== key) {
          if (d) {
            d.object.removeFromParent();
            d.frame.remove();
          }
          const frame = document.createElement("div");
          measureFramesAsLaidOut();
          frame.className = `${DOCUMENT_FRAME}${doc.bare ? " cad-model__document-canvas--bare" : ""}`;
          const view = document.createElement("patchwork-view");
          // The part of a tldraw drawing it shows, which the tool reads as it mounts.
          if (doc.camera && !doc.cameraAttribute) presetCamera(doc.url, doc.camera);
          view.style.display = "block";
          view.style.width = "100%";
          view.style.height = "100%";
          d = { key, object: new CSS3DObject(frame), frame, view, doc, corners: [] };
          // The pointer goes to the 3D view, which orbits, picks and takes the wheel; CSS3DObject sets it to `auto`.
          frame.style.pointerEvents = "none";
          documentViews.set(c.id, d);
        }
        if (doc.cameraAttribute) {
          const camera = doc.camera ? JSON.stringify(doc.camera) : null;
          if (camera === null) d.view.removeAttribute("data-camera");
          else if (d.view.getAttribute("data-camera") !== camera) d.view.setAttribute("data-camera", camera);
        }
        d.corners = c.corners.map((p) => new THREE.Vector3(...p));
        const [a, b, , top] = d.corners as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const x = b.clone().sub(a);
        const y = top.clone().sub(a);
        const width = x.length();
        const height = y.length();
        d.frame.style.width = `${DOCUMENT_PX}px`;
        d.frame.style.height = `${Math.round((DOCUMENT_PX * height) / width)}px`;
        d.frame.style.opacity = String(c.opacity);
        const scale = width / DOCUMENT_PX;
        const basis = new THREE.Matrix4().makeBasis(x.clone().normalize(), y.clone().normalize(), x.clone().cross(y).normalize());
        d.object.matrixAutoUpdate = false;
        d.object.matrix.copy(basis).scale(new THREE.Vector3(scale, scale, scale)).setPosition(a.clone().addScaledVector(x, 0.5).addScaledVector(y, 0.5));
        d.object.matrixWorldNeedsUpdate = true;
        const layer = cssLayers[c.through ? 1 : 0]!;
        if (d.object.parent !== layer.scene) layer.scene.add(d.object);
      }
    };
    /** The document edited in place: its overlay, the URL it shows, the width it was laid out at, and the model over it, as of which shapes. */
    let edit: { id: string; url: string; overlay: HTMLDivElement; width: number; ghost: HTMLImageElement; ghostOf: number } | undefined;
    /** Counts the shapes shown, so that the model over a document edited in place is drawn again when they change. */
    let shapesVersion = 0;
    /**
     * The model as the camera sees it now, alone on a transparent background: no canvases, highlights,
     * overlays or collaborators. Read right after rendering, before the browser composes the canvas,
     * which keeps its drawing buffer until then.
     */
    const modelImage = (): string => {
      const hidden = [canvasGroup, highlightGroup, overlayGroup, peerGroup].filter((g) => g.visible);
      for (const g of hidden) g.visible = false;
      const color = renderer.getClearColor(new THREE.Color());
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(background, 0);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL("image/png");
      renderer.setClearColor(color, alpha);
      for (const g of hidden) g.visible = true;
      renderer.render(scene, camera);
      return url;
    };
    /** Where a canvas is on the screen, in the view's pixels: the box of its corners. */
    const screenBox = (corners: [number, number, number][]) => {
      const rect = canvas.getBoundingClientRect();
      const points = corners.map((p) => new THREE.Vector3(...p).project(camera)).map((v) => [((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height] as const);
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    const endEdit = () => {
      if (!edit) return;
      const left = storedCamera(edit.url);
      if (left) props.onEditCamera?.(edit.id, scaleCamera(left, edit.width, DOCUMENT_PX));
      edit.overlay.remove();
      const frame = documentViews.get(edit.id)?.frame;
      if (frame) frame.style.visibility = "";
      edit = undefined;
      delete container.dataset["editing"];
    };
    /** Starts, follows or ends editing in place, as the render loop goes: the overlay is made once the camera has stopped, at the size the canvas has then. */
    const placeEditing = () => {
      const want = props.editing;
      if (edit && (want?.id !== edit.id || want.url !== edit.url)) endEdit();
      if (!want) return;
      const drawn = drawnCanvases.find((d) => d.canvas.id === want.id);
      if (!drawn) return;
      const box = screenBox(drawn.canvas.corners);
      if (!edit) {
        if (turn || box.width < 40 || box.height < 40) return;
        const width = Math.round(box.width);
        const overlay = document.createElement("div");
        overlay.className = "cad-model__document-edit";
        overlay.style.width = `${width}px`;
        overlay.style.height = `${Math.round(box.height)}px`;
        container.append(overlay);
        // The same part of the drawing as on the canvas, at this size.
        if (want.camera) presetCamera(want.url, scaleCamera(want.camera, DOCUMENT_PX, width));
        const view = document.createElement("patchwork-view");
        view.setAttribute("doc-url", want.url);
        if (want.tool) view.setAttribute("tool-id", want.tool);
        view.style.display = "block";
        view.style.width = "100%";
        view.style.height = "100%";
        overlay.append(view);
        // The model over it, see-through and not in the way of the pointer, to draw along its edges.
        const ghost = document.createElement("img");
        ghost.className = "cad-model__document-ghost";
        ghost.alt = "";
        overlay.append(ghost);
        edit = { id: want.id, url: want.url, overlay, width, ghost, ghostOf: -1 };
        container.dataset["editing"] = want.id;
      }
      edit.overlay.style.transform = `translate(${box.x}px, ${box.y}px)`;
      if (edit.ghostOf !== shapesVersion) {
        edit.ghostOf = shapesVersion;
        edit.ghost.src = modelImage();
      }
      // The whole view's picture, with the overlay's box cut out of it.
      edit.ghost.style.width = `${canvas.clientWidth}px`;
      edit.ghost.style.height = `${canvas.clientHeight}px`;
      edit.ghost.style.transform = `translate(${-box.x}px, ${-box.y}px)`;
      const frame = documentViews.get(edit.id)?.frame;
      if (frame) frame.style.visibility = "hidden";
    };
    /** Removes the drawn canvases: their geometries and own materials; the outlines' materials are the highlights'. */
    const clearCanvases = () => {
      for (const child of canvasGroup.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
      for (const d of drawnCanvases) (d.mesh.material as THREE.Material).dispose();
      canvasGroup.clear();
      drawnCanvases = [];
    };
    createEffect(() => {
      const list = props.canvases ?? [];
      clearCanvases();
      placeDocuments(list.filter((c) => c.document));
      for (const [image, texture] of textures) {
        if (list.some((c) => c.image === image)) continue;
        texture.dispose();
        textures.delete(image);
      }
      drawnCanvases = list.map((c) => {
        if (!c.image) {
          // A document's quad only punches its hole: transparent, but in the depth buffer.
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(c.corners.flat(), 3));
          geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
          geometry.setIndex([0, 1, 2, 0, 2, 3]);
          // Only depth, and only in the pass above the documents, before anything else, so that what is behind it isn't drawn there.
          const material = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
          const mesh = Object.assign(new THREE.Mesh(geometry, material), { renderOrder: -1, visible: false });
          canvasGroup.add(mesh);
          if (c.highlight) {
            const { line } = highlightMaterials[c.highlight];
            canvasGroup.add(...[line.halo, line.core].map((m, i) => Object.assign(new LineSegments2(segments({ points: c.corners, closed: true }), m), { renderOrder: 2 + i })));
          }
          return { canvas: c, mesh };
        }
        let texture = textures.get(c.image);
        if (!texture) {
          texture = new THREE.CanvasTexture(c.image);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          textures.set(c.image, texture);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(c.corners.flat(), 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        // In front of a face it lies on, which the faces' polygon offset pushes back; through the model if it is drawn through it.
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: c.opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: !c.through, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const mesh = new THREE.Mesh(geometry, material);
        canvasGroup.add(mesh);
        if (c.highlight) {
          const { line } = highlightMaterials[c.highlight];
          canvasGroup.add(...[line.halo, line.core].map((m, i) => Object.assign(new LineSegments2(segments({ points: c.corners, closed: true }), m), { renderOrder: 2 + i })));
        }
        return { canvas: c, mesh };
      });
      container.dataset["canvases"] = String(drawnCanvases.length);
    });
    /** The point of canvas `id`'s image under a position on the screen, as fractions of it from the bottom left. */
    const canvasAt = (id: string, clientX: number, clientY: number): [number, number] | undefined => {
      const drawn = drawnCanvases.find((d) => d.canvas.id === id);
      if (!drawn) return undefined;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      aim(pointer);
      const uv = raycaster.intersectObject(drawn.mesh, false)[0]?.uv;
      return uv ? [Math.round(uv.x * 1e6) / 1e6, Math.round(uv.y * 1e6) / 1e6] : undefined;
    };

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
        const unitsPerPixel = camera === perspective ? (2 * m.point.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2))) / rect.height : orthoHeight / rect.height;
        m.dot.scale.setScalar(4 * unitsPerPixel);
      }
    };

    // ---------- pins of comments and annotations ----------

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
        el.addEventListener("pointerenter", () => props.onPinHover?.(el.dataset["key"]));
        el.addEventListener("pointerleave", () => props.onPinHover?.(undefined));
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
        // Gone under the pointer: it is hovered no more.
        if (f.el.matches(":hover")) props.onPinHover?.(undefined);
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
        const drawn = JSON.stringify([pin.icons, pin.count]);
        if (f.el.dataset["drawn"] !== drawn) {
          f.el.dataset["drawn"] = drawn;
          f.el.replaceChildren(...pin.icons.map((icon) => iconElement(icon, 12)), ...(pin.count === undefined ? [] : [String(pin.count)]));
        }
        f.el.title = pin.label;
        f.el.setAttribute("aria-label", pin.label);
        f.el.dataset["threads"] = String(pin.threads);
        f.el.dataset["annotations"] = String(pin.annotations);
        if (pin.state) f.el.dataset["state"] = pin.state;
        else delete f.el.dataset["state"];
        f.el.dataset["key"] = pin.key;
        f.el.dataset["focused"] = pin.focused ? "true" : "false";
        f.el.dataset["selected"] = pin.selected ? "true" : "false";
        if (pin.new) f.el.dataset["new"] = "true";
        else delete f.el.dataset["new"];
        f.point = anchorOf(pin.body, pin.kind, pin.indices);
      }
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
    /** Aims the raycaster through `ndc`; from the orthographic camera's near plane, which may be behind the eye, so that it hits all that is drawn. */
    const aim = (ndc: THREE.Vector2) => {
      raycaster.setFromCamera(ndc, camera);
      if (camera === orthographic && camera.near < 0) raycaster.ray.origin.addScaledVector(raycaster.ray.direction, camera.near);
    };
    const pointer = new THREE.Vector2();

    /** The entity of kind `kind` under a canvas position, unless a face hides it. */
    const entityAt = (clientX: number, clientY: number, kind: EntityKind): Entity | undefined => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      aim(pointer);
      raycaster.params.Line = { threshold: radius * 0.015 };
      // While picking, bodies that can't be picked are see-through: they neither hover nor hide others.
      const candidates = rendered.filter(pickableShape);
      const faceHit = raycaster.intersectObjects(candidates.map((r) => r.mesh), false)[0];
      if (kind === "face") {
        const r = faceHit && rendered.find((x) => x.mesh === faceHit.object);
        if (!r || faceHit?.faceIndex == null) return undefined;
        const index = groupEntity(r.shape.faceIndex, getFaceIndex(faceHit.faceIndex, r.mesh.geometry));
        return index < 0 ? undefined : { body: r.id, kind, index };
      }
      const lineHit = raycaster.intersectObjects(candidates.flatMap((r) => (r.lines ? [r.lines] : [])), false)[0];
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
      aim(pointer);
      const hit = raycaster.intersectObjects(rendered.map((r) => r.mesh), false)[0];
      return hit ? (hit.point.toArray().map((x) => Math.round(x * 1000) / 1000) as [number, number, number]) : undefined;
    };

    let down: { x: number; y: number } | undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons) return;
      if (props.regions?.length) {
        if (hovered()) setHovered(undefined);
        const key = regionAt(event.clientX, event.clientY);
        if (key !== hoveredRegion()) setHoveredRegion(key);
        if (props.onPointer) props.onPointer(pointAt(event.clientX, event.clientY));
        return;
      }
      if (props.canvasPick) {
        if (hovered()) setHovered(undefined);
        props.onCanvasHover?.(props.canvasPick, canvasAt(props.canvasPick, event.clientX, event.clientY));
        if (props.onPointer) props.onPointer(pointAt(event.clientX, event.clientY));
        return;
      }
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
      // A point of a canvas, e.g. to calibrate it, before anything else a click does.
      if (props.canvasPick && event.button === 0) {
        const uv = canvasAt(props.canvasPick, event.clientX, event.clientY);
        if (uv) props.onCanvasPick?.(props.canvasPick, uv);
        return;
      }
      // A region of a sketch, which hides the model's faces and edges while regions are picked.
      if (props.regions?.length && event.button === 0) {
        const key = regionAt(event.clientX, event.clientY);
        if (key) props.onRegionPick?.(key);
        return;
      }
      if (event.button === 2 && props.onContextMenu) {
        const entity = props.pick ? undefined : hoverAt(event.clientX, event.clientY);
        props.onContextMenu(isBody(entity) ? entity : undefined, { x: event.clientX, y: event.clientY });
      }
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
      setHoveredRegion(undefined);
      if (props.canvasPick) props.onCanvasHover?.(props.canvasPick, undefined);
      props.onPointer?.(undefined);
    };

    /** A client position in the ViewCube's normalised device coordinates. */
    const cubeNdc = (clientX: number, clientY: number) => {
      const rect = cubeElement.getBoundingClientRect();
      return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    };
    /**
     * A press on the cube: a click turns the view to the region under it, a drag orbits as a drag
     * on the canvas does (research/18-named-views.md, "In the editor").
     */
    let cubeDown: { x: number; y: number; last: { x: number; y: number }; orbiting: boolean; pointer: number } | undefined;
    const up = new THREE.Vector3(0, 0, 1);
    const toYUp = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const fromYUp = toYUp.clone().invert();
    /** Orbits by a pointer movement in CSS pixels, at OrbitControls' speed: a full turn per canvas height. */
    const orbitBy = (dx: number, dy: number) => {
      const k = (2 * Math.PI) / (canvas.clientHeight || 1);
      const offset = direction().applyQuaternion(toYUp);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * k;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * k, 1e-6, Math.PI - 1e-6);
      place({ ...pose(), direction: new THREE.Vector3().setFromSpherical(spherical).applyQuaternion(fromYUp).normalize() });
    };
    const onCubeMove = (event: PointerEvent) => {
      const down = cubeDown;
      if (!down || down.pointer !== event.pointerId) return cube.hover(cube.regionAt(cubeNdc(event.clientX, event.clientY)));
      if (!down.orbiting && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) {
        down.orbiting = true;
        setTurn(undefined);
        cube.hover(undefined);
        container.dataset["orbiting"] = "true";
      }
      if (down.orbiting) orbitBy(event.clientX - down.last.x, event.clientY - down.last.y);
      down.last = { x: event.clientX, y: event.clientY };
    };
    const onCubeDown = (event: PointerEvent) => {
      if (event.button !== 0 || cubeDown) return;
      cubeDown = { x: event.clientX, y: event.clientY, last: { x: event.clientX, y: event.clientY }, orbiting: false, pointer: event.pointerId };
      cubeElement.setPointerCapture(event.pointerId);
    };
    /** Ends a press: a click turns to its region unless `cancelled`, an orbit reports the camera. */
    const endCubePress = (event: PointerEvent, cancelled: boolean) => {
      const down = cubeDown;
      if (!down || down.pointer !== event.pointerId) return;
      cubeDown = undefined;
      if (cubeElement.hasPointerCapture(event.pointerId)) cubeElement.releasePointerCapture(event.pointerId);
      delete container.dataset["orbiting"];
      if (down.orbiting) return moved();
      const region = cancelled ? undefined : cube.regionAt(cubeNdc(event.clientX, event.clientY));
      if (region) turnTo(regionDirection(region));
    };
    const onCubeUp = (event: PointerEvent) => endCubePress(event, false);
    const onCubeCancel = (event: PointerEvent) => endCubePress(event, true);
    const onCubeLeave = () => !cubeDown && cube.hover(undefined);
    createEffect(() => {
      if (collapsed()) cube.hover(undefined);
    });
    cubeElement.addEventListener("pointermove", onCubeMove);
    cubeElement.addEventListener("pointerdown", onCubeDown);
    cubeElement.addEventListener("pointerup", onCubeUp);
    cubeElement.addEventListener("pointercancel", onCubeCancel);
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
      onScreen(points) {
        const all = points?.map((p) => new THREE.Vector3(...p)) ?? rendered.flatMap((r) => {
          const position = r.mesh.geometry.getAttribute("position");
          return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i));
        });
        const ndc = all.map((p) => p.clone().project(camera));
        const box = new THREE.Box2().setFromPoints(ndc.map((v) => new THREE.Vector2(v.x, v.y)));
        const size = box.getSize(new THREE.Vector2());
        const center = box.getCenter(new THREE.Vector2());
        return { inView: ndc.every((v) => Math.abs(v.x) <= 1 + 1e-9 && Math.abs(v.y) <= 1 + 1e-9), fill: Math.max(size.x, size.y) / 2, center: [center.x, center.y], clipped: ndc.some((v) => Math.abs(v.z) > 1) };
      },
      lens: () => ({ projection: projection(), fov: perspective.fov, zoom: orthographic.zoom, distance: distance(), near: camera.near, far: camera.far }),
      intent: () => intent?.camera,
      eye: () => camera.position.toArray() as [number, number, number],
      canvases: () =>
        drawnCanvases.map(({ canvas: c }) => ({ id: c.id, opacity: c.opacity, through: c.through, highlight: c.highlight, world: c.corners, corners: c.corners.map((p) => toScreen(new THREE.Vector3(...p))) })),
      canvasPoint(id, u, v) {
        const drawn = drawnCanvases.find((d) => d.canvas.id === id);
        if (!drawn) return undefined;
        const [a, b, , d] = drawn.canvas.corners.map((p) => new THREE.Vector3(...p)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const p = toScreen(a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(d.clone().sub(a), v));
        return { x: Math.round(p.x), y: Math.round(p.y) };
      },
      regions: () =>
        drawnRegions.map(({ region, mesh }) => {
          // The centroid of a triangle that a click there hits, as regions may be concave or have holes.
          const position = mesh.geometry.getAttribute("position");
          let point: { x: number; y: number } | undefined;
          for (let t = 0; t < position.count / 3 && !point; t++) {
            const c = new THREE.Vector3();
            for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(position, 3 * t + k));
            const p = toScreen(c.divideScalar(3));
            const at = { x: Math.round(p.x), y: Math.round(p.y) };
            if (document.elementFromPoint(at.x, at.y) === canvas && regionAt(at.x, at.y) === region.key) point = at;
          }
          // As drawn: by the material it is drawn with, and the outline that only a hovered one has.
          const drawn = mesh.material;
          const outlined = hoveredRegion() === region.key && regionOutline.children.length > 0;
          return { key: region.key, chosen: drawn === regionMaterials.chosen || drawn === regionMaterials.chosenHovered, hovered: outlined && (drawn === regionMaterials.hovered || drawn === regionMaterials.chosenHovered), point };
        }),
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
    const homeCamera = (): CameraState | undefined => (props.home ? cameraOf(props.home) : modelPoints().length ? defaultHome() : undefined);
    props.onApi?.({ camera: () => intent?.camera, home: () => home(), homeCamera, pointAt, faceAt: (x, y) => entityAt(x, y, "face") });

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
      cubeElement.removeEventListener("pointercancel", onCubeCancel);
      cubeElement.removeEventListener("pointerleave", onCubeLeave);
      cube.dispose();
      dispose([...group.children, ...sketchGroup.children, ...overlayGroup.children, ...highlightGroup.children]);
      endEdit();
      clearCanvases();
      for (const texture of textures.values()) texture.dispose();
      for (const m of markers.values()) m.label.remove();
      dotGeometry.dispose();
      pmrem.dispose();
      scene.environment?.dispose();
      for (const d of drawnRegions) d.mesh.geometry.dispose();
      dispose([...regionOutline.children]);
      for (const m of [...ghostLines.values(), ...Object.values(regionMaterials), ringMaterials.line, ringMaterials.halo, faceMaterial, edgeMaterial, lineMaterial, sketchMaterial, ...Object.values(highlightMaterials).flatMap((m) => [m.face, m.line.core, m.line.halo]), ...[...peerMaterials.values()].flatMap((m) => [m.face, m.line.core, m.line.halo, m.marker])]) m.dispose();
      renderer.dispose();
      upper?.environment.dispose();
      upper?.renderer.dispose();
    });
  });

  return (
    <div class="cad-model__viewer" ref={container} data-canvas-pick={props.canvasPick ? "true" : undefined} data-hovered={entityKey(hovered())} data-selected={entityKey(selected())} data-projection={projection()} data-sketches={(props.sketches ?? []).map((s) => s.name).join(" ")}>
      <canvas ref={canvas} />
      <div class="cad-viewcube" data-collapsed={collapsed() ? "true" : "false"}>
        <button class="cad-viewcube__button cad-viewcube__button--toggle" aria-label="ViewCube" title={collapsed() ? "Show ViewCube" : "Hide ViewCube"} aria-expanded={!collapsed()} onClick={() => setCollapsed(!collapsed())}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5 14 5V11L8 14.5 2 11V5ZM2 5 8 8.5 14 5M8 8.5V14.5" />
          </svg>
        </button>
        <button class="cad-viewcube__button cad-viewcube__button--home" aria-label="Home view" title="Home view" data-hovered={props.homeHovered ? "true" : undefined} onClick={() => home()}>
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
        <div class="cad-viewcube__cube" ref={cubeElement} />
      </div>
    </div>
  );
}
