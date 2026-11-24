// The editor's camera in a scene (research/23-scene-editing.md, A1–A4): the scene's own camera, which
// the editor moves to a view, Home or a ViewCube region, and reads back to make or mark a view. It
// follows Viewer.tsx's camera (research/20-view-framing.md) in the model's frame (Z up, millimetres),
// with one difference: the scene keeps its lens, so a view is fitted by the camera's distance, not
// by the field of view, and a view's `eye` isn't kept. Its orthographic camera shows at the target what
// the perspective one shows from the same eye, so both fit by that distance. And the view is the part of the scene's port that the editor's panels leave free, as Viewer.tsx's canvas
// is: the camera fits and measures there, shifted sideways to centre it.
//
// Only arithmetic is done with this package's three.js; the scene's camera is read and set as numbers.

import * as THREE from "three";
import { cameraOf, DEFAULT_MARGINS, expand, fitLens, fitted, marginsOf, meet, TAN, tanToShow, trimmed, visibleAt, type Lens, type Rect, type Shot } from "../components/framing.ts";
import type { FaceRefs } from "../components/Viewer.tsx";
import type { RefData } from "../kernel/protocol.ts";
import type { CameraState, Margins, StoredCamera } from "../types.ts";

type Projection = CameraState["projection"];

/** The scene's camera, in the stage's frame (scene STAGE.md, `api.camera`). */
export interface HostCamera {
  get(): { position: number[]; target: number[]; fov: number; up: number[]; projection?: Projection } | null;
  set(camera: { position?: number[]; target?: number[]; projection?: Projection }): void;
  /** Calls `fn` when someone has moved the camera: an orbit, a zoom, a Frame or a switch of projection; → off. */
  onEnd(fn: () => void): () => void;
}

/** What the camera needs of the view. */
export interface CameraModel {
  camera: HostCamera;
  /** The port's size in pixels, or null while it has none. */
  size(): { width: number; height: number } | null;
  /** The part of the port that the editor's panels leave free, in its pixels: the view, as Viewer.tsx's canvas is. */
  free(): { x: number; y: number; width: number; height: number } | null;
  /** Model → stage, or null while the object isn't drawn. */
  toStage(): THREE.Matrix4 | null;
  nextFrame(fn: () => void): void;
  /** The corners of the shown bodies' boxes and the sketches' points, which a fit of the whole model uses (research/20, "Fitting"). */
  modelPoints(): THREE.Vector3[];
  /** Every vertex of the shown meshes and sketches: what the camera shows all of the model with. */
  vertices(): THREE.Vector3[];
  /** Close-ups (research/20, "Close-ups"): the faces and sketches of which `inView` holds for every point. */
  facesInView(inView: (p: THREE.Vector3) => boolean): { body: string; index: number }[];
  sketchesInView(inView: (p: THREE.Vector3) => boolean): string[];
  /** The face that covers most of the view, if any face is in it. */
  faceCoveringView(): { body: string; index: number } | undefined;
  /** Points on faces: the corners of each one's box. */
  facePoints(located: { body: string; indices: number[] }[]): THREE.Vector3[];
  sketchPoints(names: readonly string[]): THREE.Vector3[];
  /** The shown bodies' names. */
  bodies(): string[];
  faceRefs(): FaceRefs | undefined;
  /** The model's Home view, if it was changed. */
  home(): StoredCamera | undefined;
  /** The camera now shows what this says, after someone moved it. */
  onReport(camera: CameraState): void;
  /** Whether a move of the camera is running. */
  onTurning(turning: boolean): void;
}

/** The direction the camera looks from at Home: front, right and above, as Viewer.tsx's. */
const HOME_DIRECTION = new THREE.Vector3(0.55, -0.85, 0.65).normalize();
/** How long the camera turns to a view, as Viewer.tsx's. */
const TURN_MS = 300;
/** A camera that cuts off at most this part of the view's width or height of the model, on a side, was meant to show all of it. */
const SLIVER = 0.02;

// Rounded: Automerge 3.4.1 stores 0.9999999999999999 in a list as 0 (research/10-view-state.md).
const round = (x: number) => Math.round(x * 1e9) / 1e9;
const vector = (v: THREE.Vector3) => v.toArray().map(round) as [number, number, number];
const roundRef = (ref: RefData): RefData => (ref.near ? { ...ref, near: ref.near.map(round) as [number, number, number] } : ref);

/** The scene's camera as it is now, in the model's frame. */
interface Now {
  position: THREE.Vector3;
  target: THREE.Vector3;
  projection: Projection;
  /** For projecting points of the model, as the scene's camera does. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** The port's size, and the free part of it. */
  port: { width: number; height: number };
  free: { x: number; y: number; width: number; height: number };
  /** tan of half the vertical field of view of the whole port. */
  tan: number;
  to: THREE.Matrix4;
}

/** What the camera is meant to show, as Viewer.tsx's: a view given to it, or the user's own camera. */
interface Intent {
  camera: CameraState;
  given: boolean;
  /** A close-up's subject, located in the shown bodies. */
  points?: THREE.Vector3[];
  /** It has only a region, e.g. it was stored before research/20, and is classified once the model shows. */
  classify?: boolean;
}

/** Where the camera is: in the model's frame. */
interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export interface SceneCamera {
  /** Shows a camera given to the view, e.g. a named view: the camera moves there. */
  apply(stored: StoredCamera): void;
  home(): void;
  homeCamera(): CameraState | undefined;
  /** What the camera shows now, as a view would store it. */
  camera(): CameraState | undefined;
  /** The geometry changed: a view given to the camera fits it again; the user's own camera stays. */
  refit(): void;
  /** Turns to look from `direction`, as a ViewCube region does. */
  turnTo(direction: THREE.Vector3): void;
  /** Orbits by a pointer movement in pixels, as a drag on the ViewCube does; `end` once it stops. */
  orbitBy(dx: number, dy: number): void;
  orbitEnd(): void;
  /** The direction from the target to the camera, in the model's frame. */
  direction(): [number, number, number] | undefined;
  /** For the ViewCube: the scene's camera in the model's frame. */
  now(): THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined;
  /** The size of a pixel at `p`, in the model's frame. */
  pixelAt(p: THREE.Vector3): number | undefined;
  projection(): Projection;
  /** Switches between perspective and orthographic, keeping the picture at the target. */
  toggleProjection(): void;
  intent(): CameraState | undefined;
  dispose(): void;
}

export function sceneCamera(m: CameraModel): SceneCamera {
  let intent: Intent | undefined;
  /** The scene's camera as this last placed it, or as someone left it: while it is there, it shows `intent`. */
  let placed: string | undefined;
  /** The running move's number; a new move or a user's ends it. */
  let turning = 0;

  const now = (): Now | undefined => {
    const c = m.camera.get();
    const to = m.toStage();
    const size = m.size();
    const free = m.free() ?? (size && { x: 0, y: 0, ...size });
    if (!c || !to || !size?.width || !size.height || !free?.width || !free.height) return undefined;
    const from = to.clone().invert();
    const position = new THREE.Vector3().fromArray(c.position).applyMatrix4(from);
    const target = new THREE.Vector3().fromArray(c.target).applyMatrix4(from);
    const up = new THREE.Vector3().fromArray(c.position).add(new THREE.Vector3().fromArray(c.up)).applyMatrix4(from).sub(position).normalize();
    const distance = Math.max(position.distanceTo(target), 1e-9);
    const tan = Math.tan(THREE.MathUtils.degToRad(c.fov / 2));
    const projection = c.projection ?? "perspective";
    // Orthographic: what the perspective camera shows at the target; it shows everything before and behind it.
    const [h, w] = [distance * tan, distance * tan * (size.width / size.height)];
    const camera = projection === "orthographic" ? new THREE.OrthographicCamera(-w, w, h, -h, -distance * 1e3, distance * 1e3) : new THREE.PerspectiveCamera(c.fov, size.width / size.height, distance / 300, distance * 33);
    camera.position.copy(position);
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return { position, target, projection, camera, port: size, free, tan, to };
  };
  const keyOf = () => {
    const c = m.camera.get();
    return c ? JSON.stringify([...c.position, ...c.target].map((x) => Math.round(x * 1e6))) : undefined;
  };
  /** The free part's lens: its aspect, and tan of half its vertical field of view. */
  const lens = (v: Now): Lens & { tan: number } => ({ perspective: v.projection === "perspective", aspect: v.free.width / v.free.height, tan: (v.tan * v.free.height) / v.port.height });
  const directionOf = (v: Now) => v.position.clone().sub(v.target).normalize();
  /** How far the free part's centre is from the port's, in pixels, x right and y down. */
  const offset = (v: Pick<Now, "port" | "free">) => ({ x: v.free.x + v.free.width / 2 - v.port.width / 2, y: v.free.y + v.free.height / 2 - v.port.height / 2 });
  /** What the free part shows: its centre on the plane through the orbit target, and its height there. */
  const shot = (v: Now): Shot => {
    const perPixel = (2 * v.position.distanceTo(v.target) * v.tan) / v.port.height;
    const o = offset(v);
    const right = new THREE.Vector3().setFromMatrixColumn(v.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(v.camera.matrixWorld, 1);
    const target = v.target.clone().addScaledVector(right, o.x * perPixel).addScaledVector(up, -o.y * perPixel);
    return { direction: directionOf(v), target, height: v.free.height * perPixel };
  };
  /** Whether a point is in the free part, or at most `sliver` of its width or height out of it on a side. */
  const inView = (v: Now, p: THREE.Vector3, sliver = 0) => {
    const q = p.clone().project(v.camera);
    const [x, y] = [((q.x + 1) / 2) * v.port.width, ((1 - q.y) / 2) * v.port.height];
    const [dx, dy] = [sliver * v.free.width, sliver * v.free.height];
    return x >= v.free.x - dx && x <= v.free.x + v.free.width + dx && y >= v.free.y - dy && y <= v.free.y + v.free.height + dy && Math.abs(q.z) <= 1;
  };

  /** The rectangle `i` shows: its margins around the model or its subject's points, else its extent around its target. */
  const rectOf = (i: Intent): Rect => {
    const c = i.camera;
    const along = new THREE.Vector3(...c.direction).normalize();
    const around = (points: THREE.Vector3[], margins: Margins) => {
      const fit = fitted(points, along, fitLens(c.projection === "perspective"));
      return fit && expand(fit, margins, along);
    };
    const rect = c.fit ? around(m.modelPoints(), c.fit) : c.subject && i.points?.length ? around(i.points, c.subject.fit) : undefined;
    return rect ?? { center: new THREE.Vector3(...c.target), width: c.extent[0], height: c.extent[1] };
  };
  /**
   * Where `i` puts the camera with the scene's lens: as far as shows its rectangle in the free part,
   * and in perspective all of the model's depth for a fit, and shifted sideways so that the free part's centre shows
   * the rectangle's.
   */
  const poseOf = (i: Intent, v: Now): Pose => {
    const rect = rectOf(i);
    const along = new THREE.Vector3(...i.camera.direction).normalize();
    const l = lens(v);
    let distance = meet(rect.width, rect.height, l.aspect) / (2 * l.tan);
    // The model's nearest parts look larger than the plane through its middle, which the margins are measured in.
    if (i.camera.fit && i.camera.projection === "perspective")
      for (let k = 0; k < 8; k++) {
        const needed = tanToShow(m.modelPoints(), rect.center, along, distance, l.aspect);
        if (needed <= l.tan * (1 + 1e-6)) break;
        distance *= needed / l.tan;
      }
    // The camera's axes as the scene's orbit sets them: its up is the scene's, the model's Z.
    const right = new THREE.Vector3(0, 0, 1).cross(along);
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    right.normalize();
    const up = along.clone().cross(right).normalize();
    const perPixel = (2 * distance * v.tan) / v.port.height;
    const o = offset(v);
    const target = rect.center.clone().addScaledVector(right, -o.x * perPixel).addScaledVector(up, o.y * perPixel);
    return { target, position: target.clone().addScaledVector(along, distance) };
  };
  /** The camera's projection now. */
  const projectionNow = (): Projection => m.camera.get()?.projection ?? "perspective";
  /** Switches the scene's camera to `projection`, which keeps the picture at the target; the scene says it moved (onEnd). */
  const project = (projection: Projection) => {
    if (projection !== projectionNow()) m.camera.set({ projection });
  };
  const place = (pose: Pose, v: Now) => {
    m.camera.set({ position: pose.position.clone().applyMatrix4(v.to).toArray(), target: pose.target.clone().applyMatrix4(v.to).toArray() });
    placed = keyOf();
  };
  /** Moves the camera to `to`, animated unless the user prefers reduced motion, and calls `onEnd` there. */
  const moveTo = (to: Pose, v: Now, onEnd?: () => void) => {
    const id = ++turning;
    m.onTurning(true);
    const from = { direction: directionOf(v), target: v.target.clone(), distance: v.position.distanceTo(v.target) };
    const end = { direction: to.position.clone().sub(to.target).normalize(), target: to.target, distance: to.position.distanceTo(to.target) };
    const rotation = new THREE.Quaternion().setFromUnitVectors(from.direction, end.direction);
    const start = performance.now() - (matchMedia("(prefers-reduced-motion: reduce)").matches ? TURN_MS : 0);
    const step = () => {
      if (id !== turning) return;
      const current = now();
      if (!current) return;
      const t = Math.min(1, (performance.now() - start) / TURN_MS);
      const eased = t * t * (3 - 2 * t);
      const direction = from.direction.clone().applyQuaternion(new THREE.Quaternion().slerp(rotation, eased));
      const target = from.target.clone().lerp(end.target, eased);
      place({ target, position: target.clone().addScaledVector(direction, THREE.MathUtils.lerp(from.distance, end.distance, eased)) }, current);
      if (t < 1) return m.nextFrame(step);
      turning = 0;
      m.onTurning(false);
      onEnd?.();
    };
    step();
  };
  const stop = () => {
    if (!turning) return;
    turning = 0;
    m.onTurning(false);
  };

  /** The margins the fit of `points` has in the view now; at least zero. */
  const marginsNow = (v: Now, points: THREE.Vector3[]): Margins | undefined => {
    const s = shot(v);
    const fit = fitted(points, s.direction, fitLens(v.projection === "perspective"));
    return fit && (marginsOf(fit, trimmed(fit, visibleAt(s, lens(v), fit.center), s.direction), s.direction).map((x) => round(Math.max(0, x))) as Margins);
  };
  /** The eye's distance from `rect`, in multiples of the distance at which `rect` just fits a square 45° view (`CameraState.eye`). */
  const eyeFor = (v: Now, rect: Rect) => round((v.position.clone().sub(rect.center).dot(directionOf(v)) * 2 * TAN) / Math.max(rect.width, rect.height));
  /** The camera as it is now: its margins around the model if it shows all of it, else its rectangle (research/20). */
  const measure = (v: Now): CameraState => {
    const s = shot(v);
    const extent: [number, number] = [s.height * lens(v).aspect, s.height];
    const camera: CameraState = { direction: vector(s.direction), target: vector(s.target), extent: [round(extent[0]), round(extent[1])], projection: v.projection, eye: eyeFor(v, { center: s.target, width: extent[0], height: extent[1] }) };
    const all = m.vertices();
    const fit = all.length && all.every((p) => inView(v, p, SLIVER)) ? marginsNow(v, m.modelPoints()) : undefined;
    const fitRect = fit && fitted(m.modelPoints(), s.direction, fitLens(v.projection === "perspective"));
    return fit && fitRect ? { ...camera, fit, eye: eyeFor(v, expand(fitRect, fit, s.direction)) } : camera;
  };
  /** A given camera with only a region: once shown, it gets margins if it shows all of the model, as it would if saved now. */
  const classify = (i: Intent) => {
    const v = now();
    if (!i.classify || !v || !m.modelPoints().length || intent !== i || turning) return;
    i.classify = false;
    const measured = measure(v);
    if (measured.fit) i.camera = { ...i.camera, fit: measured.fit, eye: measured.eye ?? 1 };
  };
  const report = () => intent && m.onReport(intent.camera);

  /**
   * Finds what a close-up shows, so that a view saved from it follows it (research/20, "Close-ups"):
   * the faces and sketches entirely in it, else the face that covers most of it, else nothing of the
   * model, and it fits the model from its direction.
   */
  const findSubject = async (i: Intent) => {
    const refs = m.faceRefs();
    const v = now();
    if (!refs || !v) return;
    const seen = (p: THREE.Vector3) => inView(v, p);
    const inside = m.facesInView(seen);
    const insideSketches = m.sketchesInView(seen);
    const covering = inside.length || insideSketches.length ? undefined : m.faceCoveringView();
    if (!inside.length && !insideSketches.length && !covering) {
      i.camera = { ...i.camera, fit: DEFAULT_MARGINS };
      return report();
    }
    const faces = covering ? [covering] : inside;
    const sketches = covering ? [] : insideSketches;
    const fit = covering ? DEFAULT_MARGINS : marginsNow(v, [...m.facePoints(faces.map((f) => ({ body: f.body, indices: [f.index] }))), ...m.sketchPoints(sketches)])!;
    const made = faces.length ? await refs.refs(faces) : [];
    if (intent !== i) return;
    const found = made.flatMap((ref) => (ref ? [roundRef(ref)] : []));
    if (!found.length && !sketches.length) return;
    i.camera = { ...i.camera, subject: { faces: found, sketches, fit } };
    report();
  };
  /** Locates a close-up's subject in the shown bodies and shows it there, if the camera still shows `i`. */
  const locateSubject = async (i: Intent) => {
    const subject = i.camera.subject;
    const refs = m.faceRefs();
    if (!subject || !refs) return;
    const bodies = m.bodies();
    const found = subject.faces.length && bodies.length ? await refs.locate(bodies, subject.faces) : [];
    if (intent !== i) return;
    i.points = [...m.facePoints(found.flat()), ...m.sketchPoints(subject.sketches)];
    const v = now();
    if (v && !turning) place(poseOf(i, v), v);
  };

  /** The user moved the camera: it is theirs now, and reported; a close-up finds its subject. */
  const moved = () => {
    const v = now();
    if (!v) return;
    intent = { camera: measure(v), given: false };
    placed = keyOf();
    report();
    if (!intent.camera.fit) void findSubject(intent);
  };
  const off = m.camera.onEnd(() => {
    stop();
    moved();
  });

  const apply = (stored: StoredCamera, onEnd?: () => void) => {
    const given = cameraOf(stored);
    project(given.projection);
    const next: Intent = { camera: given, given: true, classify: !given.fit && !given.subject };
    intent = next;
    const v = now();
    // A fit of a model not built yet: placed once it is (refit).
    if (!v || (given.fit && !m.modelPoints().length)) return;
    moveTo(poseOf(next, v), v, () => {
      classify(next);
      onEnd?.();
    });
    if (given.subject) void locateSubject(next);
  };
  /** The Home view before anyone changed it: the model from the front, right and above, with the default margins. */
  const defaultHome = (): CameraState => {
    const camera: CameraState = { direction: vector(HOME_DIRECTION), target: [0, 0, 0], extent: [1, 1], projection: projectionNow(), fit: DEFAULT_MARGINS };
    const rect = rectOf({ camera, given: true });
    return { ...camera, target: vector(rect.center), extent: [round(rect.width), round(rect.height)] };
  };

  /** Orbiting by pointer movements works in a Y-up frame, as OrbitControls does. */
  const toYUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  const fromYUp = toYUp.clone().invert();

  return {
    apply: (stored) => apply(stored),
    home: () => apply(m.home() ?? defaultHome(), report),
    homeCamera: () => (m.home() ? cameraOf(m.home()!) : m.modelPoints().length ? defaultHome() : undefined),
    camera() {
      const v = now();
      if (!v) return intent?.camera;
      // Moved since by something that didn't say, e.g. a ride: measured as it is.
      return intent && keyOf() === placed ? intent.camera : measure(v);
    },
    refit() {
      const i = intent;
      const v = now();
      if (!i?.given || !v || !m.modelPoints().length) return;
      classify(i);
      if (i.camera.subject) void locateSubject(i);
      else if (!turning) place(poseOf(i, v), v);
    },
    turnTo(direction) {
      const v = now();
      if (!v) return;
      const current = intent && keyOf() === placed ? intent : { camera: measure(v), given: false };
      // A camera that shows the whole model fits it from there with its margins; a close-up turns around its target.
      if (current.camera.fit) {
        const turned: Intent = { camera: { ...current.camera, direction: vector(direction) }, given: false };
        intent = turned;
        moveTo(poseOf(turned, v), v, moved);
      } else moveTo({ target: v.target.clone(), position: v.target.clone().addScaledVector(direction.clone().normalize(), v.position.distanceTo(v.target)) }, v, moved);
    },
    orbitBy(dx, dy) {
      const v = now();
      const size = m.size();
      if (!v || !size) return;
      stop();
      // A full turn per view height, as OrbitControls' speed.
      const k = (2 * Math.PI) / (size.height || 1);
      const spherical = new THREE.Spherical().setFromVector3(directionOf(v).applyQuaternion(toYUp));
      spherical.theta -= dx * k;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * k, 1e-6, Math.PI - 1e-6);
      const direction = new THREE.Vector3().setFromSpherical(spherical).applyQuaternion(fromYUp).normalize();
      place({ target: v.target.clone(), position: v.target.clone().addScaledVector(direction, v.position.distanceTo(v.target)) }, v);
    },
    orbitEnd: moved,
    direction() {
      const v = now();
      return v && (directionOf(v).toArray() as [number, number, number]);
    },
    now: () => now()?.camera,
    pixelAt(p) {
      const v = now();
      if (!v) return undefined;
      const at = v.projection === "orthographic" ? v.position.distanceTo(v.target) : v.position.distanceTo(p);
      return (2 * at * v.tan) / v.port.height;
    },
    projection: projectionNow,
    toggleProjection() {
      stop();
      project(projectionNow() === "perspective" ? "orthographic" : "perspective");
    },
    intent: () => intent?.camera,
    dispose() {
      turning = 0;
      off();
    },
  };
}
