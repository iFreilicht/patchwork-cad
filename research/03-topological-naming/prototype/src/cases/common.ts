import type { Feature, Frame, Profile } from "../model.ts";

export const XY = (z = 0, flip = false): Frame => ({ origin: [0, 0, z], normal: [0, 0, flip ? -1 : 1], xDir: [1, 0, 0] });

/**
 * Axis-aligned rectangle in the XY plane with named segments front (y = y0), right, back, left.
 * With `flip`, the sketch plane normal is -Z; y is mirrored so the rectangle stays in place.
 */
export function rect(x0: number, y0: number, w: number, d: number, flip = false, cornerCut = 0): Profile {
  const s = flip ? -1 : 1;
  const pts: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d]];
  const segments = ["front", "right", "back"];
  if (cornerCut > 0) {
    pts.push([x0 + cornerCut, y0 + d], [x0, y0 + d - cornerCut]);
    segments.push("corner", "left");
  } else {
    pts.push([x0, y0 + d]);
    segments.push("left");
  }
  return { kind: "polygon", points: pts.map(([x, y]) => [x, s * y]), segments };
}

export const circle = (cx: number, cy: number, radius: number, flip = false): Profile => ({ kind: "circle", center: [cx, flip ? -cy : cy], radius, segment: "c" });

/** For optional features in a feature list: `...when(cond, feature)`. */
export const when = (cond: boolean, f: Feature): Feature[] => (cond ? [f] : []);

/** The same polygon drawn in the opposite direction; every segment keeps its name. */
export function reversed(p: Profile): Profile {
  if (p.kind !== "polygon") return p;
  const n = p.points.length;
  return { ...p, points: [...p.points].reverse(), segments: p.points.map((_, i) => p.segments[(2 * n - 2 - i) % n]!) };
}

/** Edit helper: redraw the sketch of feature `id` in the opposite direction. */
export const reverseSketchOf =
  (id: string) =>
  (features: Feature[]): Feature[] =>
    features.map((f) => (f.id === id && (f.type === "extrude" || f.type === "revolve") ? { ...f, profile: reversed(f.profile) } : f));
