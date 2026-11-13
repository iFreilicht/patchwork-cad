// Canvases in the model document (research/21-embedding.md, "Canvas"): adding, changing and
// removing them, origin planes and their labels, the frame of a planar face as a sketch on it has it,
// where an image's points are, Calibrate, the role a drop offers, and concurrent edits.
import { save } from "@automerge/automerge";
import { initSubduction, Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { addCanvas, calibratedWidth, planeCoordinates, canvasCorners, canvases, defaultWidth, faceFrame, imageDistance, imagePoint, newCanvas, originPlane, originPlaneOf, planeLabel, removeCanvas, updateCanvas } from "../src/model/canvases.ts";
import { preselects, ROLES } from "../src/components/editor/inserts.ts";
import { placeNewCanvas, sizedSvg } from "../src/components/canvases.ts";
import type { MeshedShape } from "../src/kernel/protocol.ts";
import { MODEL_MIME_TYPE } from "../src/datatype.ts";
import type { CadAnchor, CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (): DocHandle<CadModelDoc> => new Repo().create<CadModelDoc>({ title: "m", content: "", mimeType: MODEL_MIME_TYPE });
const IMAGE = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" as AutomergeUrl;
const OTHER = "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa" as AutomergeUrl;
const face: CadAnchor = { feature: "extrude1", entity: { kind: "face", names: [] }, entityName: "extrude1.end" };
const png = { "@patchwork": { type: "file" }, name: "logo", extension: "png", mimeType: "image/png", content: new Uint8Array([137, 80]) };
const svg = { "@patchwork": { type: "file" }, name: "logo", extension: "svg", mimeType: "image/svg+xml", content: "<svg/>" };
const text = { "@patchwork": { type: "file" }, name: "notes", extension: "txt", mimeType: "text/plain", content: "hi" };

const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));

test("canvases are added, changed and removed by id; a change to the same value makes no change", () => {
  const handle = model();
  handle.change((d) => addCanvas(d, newCanvas("a", IMAGE, "logo", originPlane("XY"), [1, 2], 40)));
  handle.change((d) => addCanvas(d, newCanvas("b", IMAGE, "front", face, [0, 0], 10)));
  expect(canvases(handle.doc()).map((c) => c.id)).toEqual(["a", "b"]);
  expect(canvases(handle.doc())[0]).toEqual({ id: "a", name: "logo", image: IMAGE, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, center: [1, 2], angle: 0, width: 40, opacity: 0.5, through: false });
  handle.change((d) => updateCanvas(d, "a", { image: OTHER, name: "traced", center: [3, 4], angle: 15, width: 80, opacity: 0.25, through: true, plane: face }));
  expect(canvases(handle.doc())[0]).toEqual({ id: "a", name: "traced", image: OTHER, plane: face, center: [3, 4], angle: 15, width: 80, opacity: 0.25, through: true });
  const heads = handle.heads();
  handle.change((d) => updateCanvas(d, "a", { width: 80, plane: face }));
  expect(handle.heads()).toEqual(heads);
  handle.change((d) => removeCanvas(d, "a"));
  handle.change((d) => removeCanvas(d, "missing"));
  expect(canvases(handle.doc()).map((c) => c.id)).toEqual(["b"]);
});

test("numbers in lists are rounded, so that Automerge keeps them", () => {
  const handle = model();
  handle.change((d) => addCanvas(d, newCanvas("a", IMAGE, "logo", { origin: [0, 0, 0], normal: [0.9999999999999999, 0, 0], xDir: [0, 1, 0] }, [0.1 + 0.2, 0], 10)));
  const c = canvases(handle.doc())[0]!;
  expect(c.center).toEqual([0.3, 0]);
  expect("normal" in c.plane && c.plane.normal).toEqual([1, 0, 0]);
});

test("concurrent edits of two fields of one canvas both stay; a removal wins over a concurrent change", () => {
  const a = model();
  a.change((d) => addCanvas(d, newCanvas("c", IMAGE, "logo", originPlane("XY"), [0, 0], 10)));
  a.change((d) => addCanvas(d, newCanvas("r", IMAGE, "other", originPlane("XY"), [0, 0], 10)));
  const b = new Repo().import<CadModelDoc>(save(a.doc()));
  a.change((d) => updateCanvas(d, "c", { width: 30 }));
  b.change((d) => updateCanvas(d, "c", { opacity: 0.8 }));
  a.change((d) => removeCanvas(d, "r"));
  b.change((d) => updateCanvas(d, "r", { name: "renamed" }));
  a.merge(b);
  expect(canvases(a.doc()).map((c) => [c.id, c.width, c.opacity])).toEqual([["c", 30, 0.8]]);
});

test("origin planes are the feature library's, moved along their normals; labels name them", () => {
  expect(originPlane("XZ", 5)).toEqual({ origin: [0, -5, 0], normal: [0, -1, 0], xDir: [1, 0, 0] });
  expect(originPlaneOf(originPlane("XZ", 5))).toEqual({ name: "XZ", offset: 5 });
  expect(originPlaneOf(originPlane("YZ"))).toEqual({ name: "YZ", offset: 0 });
  expect(originPlaneOf({ origin: [1, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] })).toBeUndefined();
  expect(originPlaneOf({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [0, 1, 0] })).toBeUndefined();
  expect(planeLabel(originPlane("XY"))).toBe("XY");
  expect(planeLabel(originPlane("XY", -2.5))).toBe("XY at -2.5");
  expect(planeLabel(face)).toBe("extrude1.end");
  expect(planeLabel({ origin: [1, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] })).toBe("a plane");
});

test("a planar face's frame is the one a sketch on it has: the world origin and X projected onto it", () => {
  // The top of a box at z = 5: the outward normal is +Z, the origin is (0, 0, 5), x is world X.
  const top = faceFrame([0, 0, 5, 20, 0, 5, 20, 10, 5], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  expect(top).toEqual({ origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] });
  // A side facing +X at x = 20: world X is its normal, so x is world Y.
  const side = faceFrame([20, 0, 0, 20, 10, 0, 20, 10, 5], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  expect(side).toEqual({ origin: [20, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] });
  // A slanted face: x is world X projected onto it.
  const s = Math.SQRT1_2;
  const slanted = faceFrame([0, 0, 0, 1, 0, 1, 0, 1, 0], [-s, 0, s, -s, 0, s, -s, 0, s])!;
  near(slanted.normal, [-s, 0, s]);
  near(slanted.xDir, [s, 0, s]);
  near(slanted.origin, [0, 0, 0]);
});

test("a face that isn't planar, or has no mesh, has no frame", () => {
  expect(faceFrame([], [])).toBeUndefined();
  // A cylinder's normals turn.
  expect(faceFrame([1, 0, 0, 0, 1, 0, -1, 0, 0], [1, 0, 0, 0, 1, 0, -1, 0, 0])).toBeUndefined();
  // Equal normals, but a step between two levels.
  expect(faceFrame([0, 0, 0, 10, 0, 0, 0, 10, 2], [0, 0, 1, 0, 0, 1, 0, 0, 1])).toBeUndefined();
});

test("an image's points are placed by the canvas's centre, angle and width, and its aspect", () => {
  const canvas = { center: [10, 5] as [number, number], angle: 0, width: 40 };
  expect(imagePoint(canvas, 0.5, [0.5, 0.5])).toEqual([10, 5]);
  expect(imagePoint(canvas, 0.5, [0, 0])).toEqual([-10, -5]);
  expect(imagePoint(canvas, 0.5, [1, 1])).toEqual([30, 15]);
  const turned = imagePoint({ ...canvas, angle: 90 }, 0.5, [1, 0.5]);
  near(turned, [10, 25]);
  const corners = canvasCorners(canvas, originPlane("XZ", 2), 0.5);
  // XZ's y axis is +Z, and it lies at y = -2.
  expect(corners.map((p) => p.map((x) => Math.round(x * 1e9) / 1e9 + 0))).toEqual([
    [-10, -2, -5],
    [30, -2, -5],
    [30, -2, 15],
    [-10, -2, 15],
  ]);
});

test("Calibrate sets the width that makes two points of the image the typed distance apart", () => {
  // A square image's diagonal corner points, 0.5 of its width across.
  const points = [[0.25, 0.25], [0.75, 0.25]] as const;
  expect(calibratedWidth(1, points, 30)).toBe(60);
  expect(imageDistance({ width: 60 }, 1, points)).toBe(30);
  // Vertically, the image's aspect counts.
  expect(calibratedWidth(2, [[0.5, 0], [0.5, 0.5]], 10)).toBe(10);
  expect(calibratedWidth(1, [[0.5, 0.5], [0.5, 0.5]], 10)).toBeUndefined();
  expect(calibratedWidth(1, points, 0)).toBeUndefined();
});

test("a new canvas is about as wide as the model, in round numbers", () => {
  expect(defaultWidth(undefined)).toBe(100);
  expect(defaultWidth(0)).toBe(100);
  expect(defaultWidth(23)).toBe(20);
  expect(defaultWidth(170)).toBe(200);
  expect(defaultWidth(0.7)).toBe(0.7);
});

test("Canvas is offered for images and SVGs only, and no drop preselects it", () => {
  const canvas = ROLES.find((r) => r.id === "canvas")!;
  expect(canvas.allows(png, false)).toBe(true);
  expect(canvas.allows(svg, false)).toBe(true);
  expect(canvas.allows(text, false)).toBe(false);
  expect(canvas.allows({ title: "data" }, false)).toBe(false);
  expect(canvas.allows(png, true)).toBe(false);
  expect(preselects({ kind: "face" }, png)).toBeUndefined();
  expect(preselects({ kind: "insert" }, png)).toBeUndefined();
});

test("an SVG's root gets a width and height from its viewBox where it has none in pixels, for Firefox", () => {
  expect(sizedSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect stroke-width="2"/></svg>`)).toBe(`<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect stroke-width="2"/></svg>`);
  expect(sizedSvg(`<?xml version="1.0"?>\n<svg width="100%" height='100%' viewBox="0,0,30,10"/>`)).toBe(`<?xml version="1.0"?>\n<svg width="30" height="10" viewBox="0,0,30,10"/>`);
  const sized = `<svg width="40" height="20px" viewBox="0 0 200 100"/>`;
  expect(sizedSvg(sized)).toBe(sized);
  expect(sizedSvg("<svg/>")).toBe("<svg/>");
});

/** A box 20 × 10 × 5 with only its top and bottom faces meshed, as faces 1 and 0 of body `plate`. */
const plate = {
  name: "plate",
  body: "plate",
  color: undefined,
  opacity: undefined,
  edges: undefined,
  features: undefined,
  faces: {
    vertices: [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0, 0, 0, 5, 20, 0, 5, 20, 10, 5, 0, 10, 5],
    normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    triangles: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7],
    faceGroups: [
      { start: 0, count: 6, faceId: 0 },
      { start: 6, count: 6, faceId: 1 },
    ],
  },
  faceIndex: [0, 1],
  edgeIndex: undefined,
} satisfies MeshedShape;

test("a point's coordinates in a plane are along its x and y axes from its origin", () => {
  expect(planeCoordinates(originPlane("XZ", 2), [3, -2, 4])).toEqual([3, 4]);
  expect(planeCoordinates({ origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] }, [7, 3, 5])).toEqual([7, 3]);
});

test("a new canvas lies on the planar face it was dropped on, where it was dropped, else on XY under the model's centre", () => {
  expect(placeNewCanvas([plate], { body: "plate", kind: "face", index: 1 }, face, [4, 6, 5])).toEqual({ plane: face, center: [4, 6], width: 20 });
  // Without the point, centred on the face.
  expect(placeNewCanvas([plate], { body: "plate", kind: "face", index: 1 }, face, undefined)).toEqual({ plane: face, center: [10, 5], width: 20 });
  expect(placeNewCanvas([plate], undefined, undefined, undefined)).toEqual({ plane: originPlane("XY"), center: [10, 5], width: 20, notice: undefined });
  expect(placeNewCanvas([], undefined, undefined, undefined)).toEqual({ plane: originPlane("XY"), center: [0, 0], width: 100, notice: undefined });
});
