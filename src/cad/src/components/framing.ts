import * as THREE from "three";
import type { CameraState, Margins, StoredCamera } from "../types.ts";

/**
 * Framing (research/20-view-framing.md): fitting the model, or a close-up's subject, into a
 * viewport, and the margins a camera keeps around it. Rectangles face the camera and lie in a plane
 * across its view; the viewport shows a rectangle by `meet`.
 */

/** The perspective camera's vertical field of view, in degrees. */
export const FOV = 45;
/** The tangent of half of it. */
export const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
/** The margin of a fit that has none of its own, e.g. the default Home. */
export const MARGIN = 0.1;
export const DEFAULT_MARGINS: Margins = [MARGIN, MARGIN, MARGIN, MARGIN];

/** How a viewport shows: perspective or orthographic, at its width / height, and the tangent of half its vertical field of view, `TAN` if not given. */
export interface Lens {
  perspective: boolean;
  aspect: number;
  tan?: number;
}

/** The lens a fit is measured with, whatever the viewport: square, at the default field of view, so that what a camera stores doesn't depend on the viewport's shape. */
export const fitLens = (perspective: boolean): Lens => ({ perspective, aspect: 1 });

/** A camera's axes when it looks from `direction`: right, up and back (towards the eye), as three.js's `lookAt` makes them with Z up. */
export interface Axes {
  right: THREE.Vector3;
  up: THREE.Vector3;
  back: THREE.Vector3;
}

const Z_UP = new THREE.Vector3(0, 0, 1);

export function axesOf(direction: THREE.Vector3): Axes {
  const m = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), Z_UP);
  const axes = { right: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3() };
  m.extractBasis(axes.right, axes.up, axes.back);
  return axes;
}

/** A rectangle facing the camera: its centre, which also gives the plane it lies in, and its size. */
export interface Rect {
  center: THREE.Vector3;
  width: number;
  height: number;
}

/** The smallest size of a fitted rectangle, so that a point or a flat face seen edge-on still frames. */
const MIN_SIZE = 1e-6;

/**
 * The tightest rectangle around `points` seen from `direction`, in the plane through their middle
 * depth: per axis, the narrowest frustum side that contains them all, cut at that plane. A viewport
 * that shows it contains every point, and one touches its edge. Undefined without points.
 */
export function fitted(points: readonly THREE.Vector3[], direction: THREE.Vector3, lens: Lens): Rect | undefined {
  if (!points.length) return undefined;
  const { right, up, back } = axesOf(direction);
  const xs = points.map((p) => p.dot(right));
  const ys = points.map((p) => p.dot(up));
  const zs = points.map((p) => p.dot(back));
  const depth = (Math.min(...zs) + Math.max(...zs)) / 2;
  /** One axis: the centre and half size of the narrowest frustum side at `depth`, for a frustum of half-angle tangent `t`. */
  const axis = (cs: number[], t: number) => {
    if (!lens.perspective) {
      const [lo, hi] = [Math.min(...cs), Math.max(...cs)];
      return { center: (lo + hi) / 2, half: (hi - lo) / 2 };
    }
    // The eye must be at least at depth (a + b) / 2t, centred at (a - b) / 2 (research/20, "Fitting").
    const a = Math.max(...cs.map((c, i) => c + t * zs[i]!));
    const b = Math.max(...cs.map((c, i) => -c + t * zs[i]!));
    return { center: (a - b) / 2, half: t * ((a + b) / (2 * t) - depth) };
  };
  const tan = lens.tan ?? TAN;
  const x = axis(xs, tan * lens.aspect);
  const y = axis(ys, tan);
  return {
    center: right.clone().multiplyScalar(x.center).addScaledVector(up, y.center).addScaledVector(back, depth),
    width: Math.max(2 * x.half, MIN_SIZE),
    height: Math.max(2 * y.half, MIN_SIZE),
  };
}

/** `rect` grown by `margins`, fractions of its size. */
export function expand(rect: Rect, [top, right, bottom, left]: Margins, direction: THREE.Vector3): Rect {
  const axes = axesOf(direction);
  return {
    center: rect.center
      .clone()
      .addScaledVector(axes.right, (rect.width * (right - left)) / 2)
      .addScaledVector(axes.up, (rect.height * (top - bottom)) / 2),
    width: rect.width * (1 + left + right),
    height: rect.height * (1 + top + bottom),
  };
}

/** The margins by which `visible` exceeds `fit`, both in one plane; negative where `fit` sticks out. */
export function marginsOf(fit: Rect, visible: Rect, direction: THREE.Vector3): Margins {
  const axes = axesOf(direction);
  const offset = visible.center.clone().sub(fit.center);
  const dx = offset.dot(axes.right);
  const dy = offset.dot(axes.up);
  return [
    (dy + visible.height / 2 - fit.height / 2) / fit.height,
    (dx + visible.width / 2 - fit.width / 2) / fit.width,
    (-dy + visible.height / 2 - fit.height / 2) / fit.height,
    (-dx + visible.width / 2 - fit.width / 2) / fit.width,
  ];
}

/**
 * What `visible` means to show of `fit`, both in one plane: the viewport's shape adds room on one
 * axis, which isn't the camera's, so that axis gets the other's scale, with `fit` kept where it is
 * in the view as far as it can. Margins measured against it hold in a viewport of any shape.
 */
export function trimmed(fit: Rect, visible: Rect, direction: THREE.Vector3): Rect {
  const axes = axesOf(direction);
  const scale = Math.min(visible.width / fit.width, visible.height / fit.height);
  const [width, height] = [fit.width * scale, fit.height * scale];
  const offset = visible.center.clone().sub(fit.center);
  // Keep the view's centre, unless that would cut `fit` off; it can't if all of `fit` is visible (scale ≥ 1).
  const slide = (d: number, size: number, room: number) => THREE.MathUtils.clamp(d, -Math.max(0, (room - size) / 2), Math.max(0, (room - size) / 2));
  const dx = slide(offset.dot(axes.right), fit.width, width);
  const dy = slide(offset.dot(axes.up), fit.height, height);
  return { center: fit.center.clone().addScaledVector(axes.right, dx).addScaledVector(axes.up, dy), width, height };
}

/** The visible height when a viewport of `aspect` shows `width` × `height`: all of it, as large as possible (`meet`). */
export const meet = (width: number, height: number, aspect: number) => Math.max(height, width / aspect);

/** What a camera shows: from `direction`, `height` high in the plane through `target`, as wide as the viewport. */
export interface Shot {
  direction: THREE.Vector3;
  target: THREE.Vector3;
  height: number;
}

/** The eye's distance from the target, for a perspective camera that shows `height` there. */
export const distanceFor = (height: number, tan = TAN) => height / (2 * tan);

/** What `shot` shows in the plane through `point` across its view. */
export function visibleAt(shot: Shot, lens: Lens, point: THREE.Vector3): Rect {
  const { back } = axesOf(shot.direction);
  const onPlane = (p: THREE.Vector3) => p.clone().addScaledVector(back, point.clone().sub(p).dot(back));
  if (!lens.perspective) return { center: onPlane(shot.target), width: shot.height * lens.aspect, height: shot.height };
  const tan = lens.tan ?? TAN;
  const eye = shot.target.clone().addScaledVector(back, distanceFor(shot.height, tan));
  const height = 2 * tan * eye.clone().sub(point).dot(back);
  return { center: onPlane(eye), width: height * lens.aspect, height };
}

/** Whether `inner` lies in `outer`, both in one plane, up to a relative `tolerance`. */
export function inside(inner: Rect, outer: Rect, direction: THREE.Vector3, tolerance = 1e-6): boolean {
  return marginsOf(inner, outer, direction).every((m) => m >= -tolerance);
}

/** A camera in the current form; one stored before research/20 shows its old height at the target, at least as wide. */
export function cameraOf(stored: StoredCamera): CameraState {
  if ("extent" in stored) return stored;
  const height = (2 * stored.distance * TAN) / (stored.zoom || 1);
  return { direction: [...stored.direction], target: [...stored.target], extent: [height, height], projection: stored.projection };
}

/** The axis-aligned box's corners, the points a fit uses for a body (research/20, "Fitting"). */
export function corners(box: THREE.Box3): THREE.Vector3[] {
  if (box.isEmpty()) return [];
  const { min, max } = box;
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
}

/**
 * The tangent of half the vertical field of view an eye at `distance` from `center`, looking from
 * `direction`, needs to show every point in a viewport of `aspect`.
 */
export function tanToShow(points: readonly THREE.Vector3[], center: THREE.Vector3, direction: THREE.Vector3, distance: number, aspect: number): number {
  const { right, up, back } = axesOf(direction);
  const eye = center.clone().addScaledVector(back, distance);
  let tan = 0;
  for (const p of points) {
    const q = p.clone().sub(eye);
    const depth = -q.dot(back);
    if (depth <= 0) return Infinity;
    tan = Math.max(tan, Math.abs(q.dot(up)) / depth, Math.abs(q.dot(right)) / depth / aspect);
  }
  return tan;
}

/** Whether `a` and `b`, both in one plane, overlap. */
export function overlaps(a: Rect, b: Rect, direction: THREE.Vector3): boolean {
  return marginsOf(a, b, direction).every((m) => m > -1);
}
