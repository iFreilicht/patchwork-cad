// Picking the faces and edges of a build along a ray, in the model's frame (research/23-scene-editing.md,
// C4): the scene view raycasts its meshes itself, as the scene's hits don't say which face. Every face
// and edge group has a box, and only the groups whose box the ray passes, for an edge widened by how
// near the pointer has to be, have their triangles or segments tested.

import type * as Three from "three";
import type { Entity } from "../components/Viewer.tsx";
import type { MeshedShape } from "../kernel/protocol.ts";

/** How near (px) the pointer must be to an edge to hover it, as Viewer.tsx's. */
export const EDGE_PX = 6;

export type Hit = { entity: Entity | undefined; point: [number, number, number]; t: number };

/** A face or edge group: its triangles' indices (`start`, `count` in `faces.triangles`) or its segments' points (in `edges.lines`, by point), and its box. */
interface Group {
  box: Three.Box3;
  start: number;
  count: number;
  /** Its index among the shape's groups; -1 for triangles in none. */
  group: number;
}

interface Indexed {
  shape: MeshedShape;
  box: Three.Box3;
  faces: Group[];
  edges: Group[];
}

export interface Picking {
  /** The nearest face along `ray`, of the shapes `skip` doesn't leave out; its entity is undefined on a shape that isn't a body. */
  faceHit(ray: Three.Ray, skip?: (shape: MeshedShape) => boolean): Hit | undefined;
  /**
   * The nearest edge within EDGE_PX of `ray` and not behind `front` (by more than that slack), of
   * bodies `pickable` names; `px(t)` is a pixel's size at distance `t`.
   */
  edgeHit(ray: Three.Ray, px: (t: number) => number, front: number, pickable: (body: string) => boolean): Hit | undefined;
}

/** An entity's index in its body from its group's, as Viewer.tsx's `groupEntity`. */
export const entityIndex = (indexOf: number[] | undefined, group: number) => (indexOf ? (indexOf[group] ?? -1) : group);

/** The picking of `shapes`, with `THREE` for its arithmetic. */
export function pickingOf(THREE: typeof Three, shapes: readonly MeshedShape[]): Picking {
  const indexed: Indexed[] = shapes.map((shape) => {
    const { vertices, triangles, faceGroups } = shape.faces;
    const p = new THREE.Vector3();
    const faceBox = (start: number, count: number) => {
      const box = new THREE.Box3();
      for (let i = start; i < start + count; i++) box.expandByPoint(p.fromArray(vertices, triangles[i]! * 3));
      return box;
    };
    const grouped = (faceGroups ?? []).map((g, group) => ({ box: faceBox(g.start, g.count), start: g.start, count: g.count, group }));
    // Triangles in no group still hide what is behind them: all of them, after the groups, whose
    // triangles are then hit first at the same distance and keep their face.
    const covered = grouped.reduce((n, g) => n + g.count, 0);
    const faces = covered >= triangles.length ? grouped : [...grouped, { box: faceBox(0, triangles.length), start: 0, count: triangles.length, group: -1 }];
    const lines = shape.edges?.lines;
    const edges = (shape.edges?.edgeGroups ?? []).map((g, group) => {
      const box = new THREE.Box3();
      for (let v = g.start; v < g.start + g.count; v++) box.expandByPoint(p.fromArray(lines!, v * 3));
      return { box, start: g.start, count: g.count, group };
    });
    const box = new THREE.Box3();
    for (const g of [...faces, ...edges]) box.union(g.box);
    return { shape, box, faces, edges };
  });

  return {
    faceHit(ray, skip) {
      const [a, b, c, at] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      let best: Hit | undefined;
      for (const { shape, box, faces } of indexed) {
        if (skip?.(shape) || !ray.intersectsBox(box)) continue;
        const { vertices: v, triangles: tris } = shape.faces;
        for (const f of faces) {
          if (!ray.intersectsBox(f.box)) continue;
          for (let i = f.start; i + 2 < f.start + f.count; i += 3) {
            a.fromArray(v, tris[i]! * 3);
            b.fromArray(v, tris[i + 1]! * 3);
            c.fromArray(v, tris[i + 2]! * 3);
            if (!ray.intersectTriangle(a, b, c, false, at)) continue;
            const t = at.distanceTo(ray.origin);
            if (best && t >= best.t) continue;
            const entity = shape.body && f.group >= 0 ? { body: shape.body, kind: "face" as const, index: entityIndex(shape.faceIndex, f.group) } : undefined;
            best = { entity, point: at.toArray() as [number, number, number], t };
          }
        }
      }
      return best;
    },
    edgeHit(ray, px, front, pickable) {
      const [a, b, onRay, onSeg, center, size] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const grown = new THREE.Box3();
      let best: (Hit & { score: number }) | undefined;
      for (const { shape, edges } of indexed) {
        if (!shape.body || !shape.edges || !pickable(shape.body)) continue;
        const l = shape.edges.lines;
        for (const e of edges) {
          // Widened by the most a pixel can be across the box: at its far side.
          const far = e.box.getCenter(center).distanceTo(ray.origin) + e.box.getSize(size).length() / 2;
          if (!ray.intersectsBox(grown.copy(e.box).expandByScalar(EDGE_PX * px(far)))) continue;
          for (let v = e.start; v + 1 < e.start + e.count; v += 2) {
            a.fromArray(l, v * 3);
            b.fromArray(l, v * 3 + 3);
            const d = Math.sqrt(ray.distanceSqToSegment(a, b, onRay, onSeg));
            const t = onRay.distanceTo(ray.origin);
            const pixel = px(t);
            const score = d / pixel;
            if (score > EDGE_PX || t > front + EDGE_PX * pixel || (best && score >= best.score)) continue;
            best = { entity: { body: shape.body, kind: "edge", index: entityIndex(shape.edgeIndex, e.group) }, point: onSeg.toArray() as [number, number, number], t, score };
          }
        }
      }
      return best;
    },
  };
}
