// Framing (research/20-view-framing.md): the exact fit, margins, meet, and cameras stored before it.
import * as THREE from "three";
import { expect, test } from "vitest";
import { cameraOf, distanceFor, expand, FOV, fitted, inside, marginsOf, meet, trimmed, visibleAt, type Lens, type Rect } from "../src/components/framing.ts";

/** A seeded random number in [0, 1), so that failures repeat. */
const random = (() => {
  let seed = 7;
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
})();
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const cloud = () => Array.from({ length: 20 }, () => new THREE.Vector3(between(-50, 80), between(-10, 30), between(-20, 20)));
const directionAt = () => new THREE.Vector3(between(-1, 1), between(-1, 1), between(-1, 1)).normalize();

/** A three.js camera that shows `rect` by meet, as the viewer places it. */
function cameraFor(rect: Rect, direction: THREE.Vector3, lens: Lens): THREE.Camera {
  const height = meet(rect.width, rect.height, lens.aspect);
  const camera = lens.perspective ? new THREE.PerspectiveCamera(FOV, lens.aspect, 0.01, 1e5) : new THREE.OrthographicCamera((-height / 2) * lens.aspect, (height / 2) * lens.aspect, height / 2, -height / 2, -1e5, 1e5);
  camera.up.set(0, 0, 1);
  camera.position.copy(rect.center).addScaledVector(direction, distanceFor(height));
  camera.lookAt(rect.center);
  camera.updateMatrixWorld();
  return camera;
}
/** The points' furthest normalised device coordinate from the centre, on either axis. */
const reach = (points: THREE.Vector3[], camera: THREE.Camera) => Math.max(...points.map((p) => p.clone().project(camera)).flatMap((v) => [Math.abs(v.x), Math.abs(v.y)]));

for (const perspective of [true, false])
  test(`a ${perspective ? "perspective" : "orthographic"} fit contains every point, and one touches an edge`, () => {
    for (let i = 0; i < 200; i++) {
      const points = cloud();
      const direction = directionAt();
      const lens = { perspective, aspect: between(0.3, 3) };
      const rect = fitted(points, direction, lens)!;
      expect(reach(points, cameraFor(rect, direction, lens))).toBeCloseTo(1, 6);
    }
  });

test("margins measured against the visible rectangle restore it", () => {
  for (let i = 0; i < 100; i++) {
    const points = cloud();
    const direction = directionAt();
    const lens = { perspective: random() < 0.5, aspect: between(0.3, 3) };
    const fit = fitted(points, direction, lens)!;
    const margins: [number, number, number, number] = [between(-0.5, 1), between(-0.5, 1), between(-0.5, 1), between(-0.5, 1)];
    const grown = expand(fit, margins, direction);
    marginsOf(fit, grown, direction).forEach((m, k) => expect(m).toBeCloseTo(margins[k]!, 9));
    expect(inside(fit, grown, direction)).toBe(margins.every((m) => m >= 0));
  }
});

test("a camera that keeps margins of at least zero shows the whole model in any viewport", () => {
  for (let i = 0; i < 100; i++) {
    const points = cloud();
    const direction = directionAt();
    const margins: [number, number, number, number] = [between(0, 0.5), between(0, 0.5), between(0, 0.5), between(0, 0.5)];
    const lens = { perspective: random() < 0.5, aspect: between(0.3, 3) };
    const rect = expand(fitted(points, direction, lens)!, margins, direction);
    expect(reach(points, cameraFor(rect, direction, lens))).toBeLessThanOrEqual(1 + 1e-9);
  }
});

test("margins leave out the room a viewport's shape adds", () => {
  const direction = new THREE.Vector3(0, -1, 0);
  const fit = { center: new THREE.Vector3(0, 0, 0), width: 100, height: 20 };
  // A tall view of a wide bar, zoomed out to 1.5 its width and moved up a little: the room above and below is the viewport's.
  const visible = { center: new THREE.Vector3(10, 0, 30), width: 150, height: 300 };
  const margins = marginsOf(fit, trimmed(fit, visible, direction), direction);
  // Its scale is the width's, 1.5; the bar slides up only as far as that leaves it in the view.
  margins.forEach((m, i) => expect(m).toBeCloseTo([0.5, 0.35, 0, 0.15][i]!, 9));
  // A centred fit with equal margins keeps them.
  const home = expand(fit, [0.1, 0.1, 0.1, 0.1], direction);
  const wide = { ...home, width: home.height * 10 };
  marginsOf(fit, trimmed(fit, wide, direction), direction).forEach((m) => expect(m).toBeCloseTo(0.1, 9));
});

test("the visible rectangle in another plane is the frustum's cut there", () => {
  const direction = new THREE.Vector3(0, -1, 0);
  const lens = { perspective: true, aspect: 2 };
  const shot = { direction, target: new THREE.Vector3(0, 0, 0), height: 10 };
  // A plane half way to the eye shows half as much.
  const near = visibleAt(shot, lens, new THREE.Vector3(3, -distanceFor(10) / 2, 4));
  expect(near.height).toBeCloseTo(5);
  expect(near.width).toBeCloseTo(10);
  expect(near.center.toArray()).toEqual([0, -distanceFor(10) / 2, 0].map((x) => expect.closeTo(x, 9)));
  const ortho = visibleAt(shot, { perspective: false, aspect: 2 }, new THREE.Vector3(0, 5, 0));
  expect([ortho.width, ortho.height]).toEqual([20, 10]);
});

test("meet shows all of the extent, as large as possible", () => {
  expect(meet(10, 10, 2)).toBe(10);
  expect(meet(10, 10, 0.5)).toBe(20);
  expect(meet(40, 10, 2)).toBe(20);
});

test("a camera stored before research/20 shows its old height", () => {
  const legacy = { direction: [0, -1, 0] as [number, number, number], target: [1, 2, 3] as [number, number, number], distance: 100, projection: "orthographic" as const, zoom: 2 };
  const camera = cameraOf(legacy);
  const height = (2 * 100 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / 2;
  expect(camera).toEqual({ direction: [0, -1, 0], target: [1, 2, 3], extent: [height, height], projection: "orthographic" });
  expect(cameraOf(camera)).toBe(camera);
});
