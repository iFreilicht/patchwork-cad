import * as THREE from "three";
import { expect, test } from "vitest";
import type { MeshedShape } from "../src/kernel/protocol.ts";
import { EDGE_PX, entityIndex, pickingOf, type Hit } from "../src/scene/picking.ts";

/** A box as a build meshes it: a face group of two triangles per side, an edge group per edge. */
function box(body: string | undefined, min: [number, number, number], max: [number, number, number]): MeshedShape {
  const corner = (i: number) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const vertices = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(corner);
  const sides = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const triangles = sides.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  const faceGroups = sides.map((_, i) => ({ start: i * 6, count: 6 }));
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const lines = pairs.flatMap(([a, b]) => [...corner(a!), ...corner(b!)]);
  const edgeGroups = pairs.map((_, i) => ({ start: i * 2, count: 2 }));
  return {
    name: body ?? "",
    color: undefined,
    opacity: undefined,
    body,
    faces: { vertices, triangles, normals: [], faceGroups },
    edges: { lines, edgeGroups },
    faceIndex: sides.map((_, i) => i),
    edgeIndex: pairs.map((_, i) => i),
  } as unknown as MeshedShape;
}

/** Every triangle and segment tested, as the scene view did before it had boxes. */
function bruteFace(shapes: MeshedShape[], ray: THREE.Ray): Hit | undefined {
  const [a, b, c, at] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let best: Hit | undefined;
  for (const shape of shapes) {
    const { vertices: v, triangles: tris, faceGroups } = shape.faces;
    for (let i = 0; i + 2 < tris.length; i += 3) {
      a.fromArray(v, tris[i]! * 3);
      b.fromArray(v, tris[i + 1]! * 3);
      c.fromArray(v, tris[i + 2]! * 3);
      if (!ray.intersectTriangle(a, b, c, false, at)) continue;
      const t = at.distanceTo(ray.origin);
      if (best && t >= best.t) continue;
      const group = (faceGroups ?? []).findIndex((g) => i >= g.start && i < g.start + g.count);
      best = { entity: shape.body && group >= 0 ? { body: shape.body, kind: "face", index: entityIndex(shape.faceIndex, group) } : undefined, point: at.toArray() as [number, number, number], t };
    }
  }
  return best;
}
function bruteEdge(shapes: MeshedShape[], ray: THREE.Ray, px: (t: number) => number, front: number): Hit | undefined {
  const [a, b, onRay, onSeg] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let best: (Hit & { score: number }) | undefined;
  for (const shape of shapes) {
    if (!shape.body || !shape.edges) continue;
    const l = shape.edges.lines;
    for (let i = 0; i + 5 < l.length; i += 6) {
      a.fromArray(l, i);
      b.fromArray(l, i + 3);
      const d = Math.sqrt(ray.distanceSqToSegment(a, b, onRay, onSeg));
      const t = onRay.distanceTo(ray.origin);
      const score = d / px(t);
      if (score > EDGE_PX || t > front + EDGE_PX * px(t) || (best && score >= best.score)) continue;
      const group = (shape.edges.edgeGroups ?? []).findIndex((g) => i / 3 >= g.start && i / 3 < g.start + g.count);
      if (group < 0) continue;
      best = { entity: { body: shape.body, kind: "edge", index: entityIndex(shape.edgeIndex, group) }, point: onSeg.toArray() as [number, number, number], t, score };
    }
  }
  return best;
}

/** A seeded generator, so that a failure can be reproduced. */
function random(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("picking with boxes finds what testing every triangle and segment finds", () => {
  const shapes = [box("a", [0, 0, 0], [10, 10, 10]), box("b", [20, 0, 0], [30, 5, 40]), box(undefined, [-15, -5, 0], [-5, 5, 5]), box("c", [0, 20, 0], [40, 22, 2])];
  const picking = pickingOf(THREE, shapes);
  const next = random(7);
  // A pixel 0.2 mm across at 100 mm, as through a 45° view about 600 px high.
  const px = (t: number) => Math.max(t * 0.002, 1e-9);
  let faces = 0;
  let edges = 0;
  for (let i = 0; i < 2000; i++) {
    const origin = new THREE.Vector3(next() * 160 - 80, next() * 160 - 80, next() * 160 - 40);
    const towards = new THREE.Vector3(next() * 50 - 10, next() * 30 - 5, next() * 40);
    const ray = new THREE.Ray(origin, towards.sub(origin).normalize());
    const face = picking.faceHit(ray);
    const expected = bruteFace(shapes, ray);
    expect(face?.entity).toEqual(expected?.entity);
    expect(face?.t ?? -1).toBeCloseTo(expected?.t ?? -1, 9);
    const front = face?.t ?? Infinity;
    const edge = picking.edgeHit(ray, px, front, () => true);
    expect(edge?.entity).toEqual(bruteEdge(shapes, ray, px, front)?.entity);
    if (face?.entity) faces++;
    if (edge) edges++;
  }
  // The rays hit enough of both for the comparison to mean something.
  expect(faces).toBeGreaterThan(200);
  expect(edges).toBeGreaterThan(20);
});

test("a shape that isn't pickable is left out, and triangles in no group hide what is behind them", () => {
  const front = box("front", [0, 0, 10], [10, 10, 12]);
  const ungrouped = { ...box("ghost", [0, 0, 20], [10, 10, 22]), faces: { ...box(undefined, [0, 0, 20], [10, 10, 22]).faces, faceGroups: [] } } as MeshedShape;
  const picking = pickingOf(THREE, [front, ungrouped]);
  const down = new THREE.Ray(new THREE.Vector3(5, 5, 50), new THREE.Vector3(0, 0, -1));
  // The ungrouped box is nearer: it hides the front box's top, and names no face.
  expect(picking.faceHit(down)).toMatchObject({ entity: undefined, t: 28 });
  expect(picking.faceHit(down, (s) => s.body === "ghost")).toMatchObject({ entity: { body: "front", kind: "face" }, t: 38 });
});
