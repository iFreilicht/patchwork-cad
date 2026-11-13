// Experiment (research/21, "Canvas"): a tldraw drawing's bounds, the camera that fits them into a
// canvas, the same part of the drawing at another width, and which documents are tldraw drawings.
import { expect, test } from "vitest";
import { fitCamera, isTldraw, scaleCamera, tldrawBounds } from "../src/components/documentCanvases.ts";

const shape = (id: string, x: number, y: number, props: Record<string, unknown>, parentId = "page:page") => ({ [`shape:${id}`]: { typeName: "shape", id: `shape:${id}`, parentId, x, y, props } });

test("a drawing's bounds cover its shapes on the page: boxes, arrows, lines and strokes; nested shapes and other records don't count", () => {
  const store = {
    "page:page": { typeName: "page" },
    ...shape("box", 10, 20, { w: 100, h: 50 }),
    ...shape("note", 300, 0, { scale: 1 }),
    ...shape("arrow", 0, 200, { start: { x: -40, y: 0 }, end: { x: 60, y: 30 } }),
    ...shape("line", 100, 100, { points: { a: { id: "a", x: 0, y: 0 }, b: { id: "b", x: 20, y: 150 } } }),
    ...shape("draw", 50, 50, { segments: [{ type: "free", points: [{ x: 0, y: 0, z: 0.5 }, { x: 10, y: -80, z: 0.5 }] }] }),
    ...shape("inside", 5000, 5000, { w: 10, h: 10 }, "shape:frame"),
  };
  expect(tldrawBounds({ store })).toEqual({ minX: -40, minY: -30, maxX: 500, maxY: 250 });
  expect(tldrawBounds({ store: { "page:page": { typeName: "page" } } })).toBeUndefined();
  expect(tldrawBounds({})).toBeUndefined();
});

test("a fitted camera puts the drawing in the middle of the view with a margin; scaled, the same part shows", () => {
  const camera = fitCamera({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, 900, 900, 0.05);
  // Limited by the width: 900 * 0.9 / 200.
  expect(camera.z).toBeCloseTo(4.05, 6);
  const screen = (x: number, y: number) => [(x + camera.x) * camera.z, (y + camera.y) * camera.z];
  expect(screen(100, 50)[0]).toBeCloseTo(450, 4);
  expect(screen(100, 50)[1]).toBeCloseTo(450, 4);
  expect(screen(0, 0)[0]).toBeCloseTo(45, 4);
  const half = scaleCamera(camera, 900, 450);
  expect((100 + half.x) * half.z).toBeCloseTo(225, 4);
});

test("tldraw drawings are told apart by their datatype", () => {
  expect(isTldraw({ "@patchwork": { type: "tldraw5" } })).toBe(true);
  expect(isTldraw({ "@patchwork": { type: "tldraw4" } })).toBe(true);
  expect(isTldraw({ "@patchwork": { type: "markdown" } })).toBe(false);
  expect(isTldraw(undefined)).toBe(false);
});
