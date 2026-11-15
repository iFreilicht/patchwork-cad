// Canvases in the model document (research/21-embedding.md, "Canvas"): adding, changing and
// removing them, origin planes and their labels, the frame of a planar face as a sketch on it has it,
// where an image's points are as it changes, anchors, Calibrate, canvases stored with a centre and
// width, the role a drop offers, and concurrent edits.
import { save } from "@automerge/automerge";
import { initSubduction, Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { addCanvas, anchorElement, calibratedScale, canvasCorners, canvases, centredAt, defaultWidth, elementAt, faceFrame, imageDistance, imagePoint, newCanvas, originPlane, originPlaneOf, placementOf, planeCoordinates, planeLabel, removeCanvas, repinned, toPlane, updateCanvas, type ImageBox, type ImageElement } from "../src/model/canvases.ts";
import { preselects, ROLES } from "../src/components/editor/inserts.ts";
import { placeNewCanvas, sizedSvg } from "../src/components/canvases.ts";
import type { MeshedShape } from "../src/kernel/protocol.ts";
import { MODEL_MIME_TYPE } from "../src/datatype.ts";
import type { CadAnchor, CadModelDoc, LegacyCanvas } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (): DocHandle<CadModelDoc> => new Repo().create<CadModelDoc>({ title: "m", content: "", mimeType: MODEL_MIME_TYPE });
const IMAGE = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" as AutomergeUrl;
const OTHER = "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa" as AutomergeUrl;
const face: CadAnchor = { feature: "extrude1", entity: { kind: "face", names: [] }, entityName: "extrude1.end" };
const png = { "@patchwork": { type: "file" }, name: "logo", extension: "png", mimeType: "image/png", content: new Uint8Array([137, 80]) };
const svg = { "@patchwork": { type: "file" }, name: "logo", extension: "svg", mimeType: "image/svg+xml", content: "<svg/>" };
const text = { "@patchwork": { type: "file" }, name: "notes", extension: "txt", mimeType: "text/plain", content: "hi" };

const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
/** An image 200 × 100 in its own units, from the origin. */
const BOX: ImageBox = { x: 0, y: 0, width: 200, height: 100 };

test("canvases are added, changed and removed by id; a change to the same value makes no change", () => {
  const handle = model();
  handle.change((d) => addCanvas(d, newCanvas("a", IMAGE, "logo", originPlane("XY"), [1, 2], 40, BOX)));
  handle.change((d) => addCanvas(d, newCanvas("b", IMAGE, "front", face, [0, 0], 10, BOX)));
  expect(canvases(handle.doc()).map((c) => c.id)).toEqual(["a", "b"]);
  // Pinned by the image's centre, a fifth of a model unit per unit of the image.
  expect(canvases(handle.doc())[0]).toEqual({ id: "a", name: "logo", image: IMAGE, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, at: [100, 50], position: [1, 2], scale: 0.2, angle: 0, opacity: 0.5, through: false });
  handle.change((d) => updateCanvas(d, "a", { image: OTHER, name: "traced", position: [3, 4], angle: 15, scale: 0.4, opacity: 0.25, through: true, plane: face, anchor: { attribute: "id", value: "frame" } }));
  expect(canvases(handle.doc())[0]).toEqual({ id: "a", name: "traced", image: OTHER, plane: face, at: [100, 50], position: [3, 4], angle: 15, scale: 0.4, opacity: 0.25, through: true, anchor: { attribute: "id", value: "frame" } });
  const heads = handle.heads();
  handle.change((d) => updateCanvas(d, "a", { scale: 0.4, plane: face }));
  expect(handle.heads()).toEqual(heads);
  // An anchor of null is removed.
  handle.change((d) => updateCanvas(d, "a", { anchor: null }));
  expect("anchor" in canvases(handle.doc())[0]!).toBe(false);
  handle.change((d) => removeCanvas(d, "a"));
  handle.change((d) => removeCanvas(d, "missing"));
  expect(canvases(handle.doc()).map((c) => c.id)).toEqual(["b"]);
});

test("numbers in lists are rounded, so that Automerge keeps them", () => {
  const handle = model();
  handle.change((d) => addCanvas(d, newCanvas("a", IMAGE, "logo", { origin: [0, 0, 0], normal: [0.9999999999999999, 0, 0], xDir: [0, 1, 0] }, [0.1 + 0.2, 0], 10, BOX)));
  const c = canvases(handle.doc())[0]!;
  expect("position" in c && c.position).toEqual([0.3, 0]);
  expect("normal" in c.plane && c.plane.normal).toEqual([1, 0, 0]);
});

test("concurrent edits of two fields of one canvas both stay; a removal wins over a concurrent change", () => {
  const a = model();
  a.change((d) => addCanvas(d, newCanvas("c", IMAGE, "logo", originPlane("XY"), [0, 0], 10, BOX)));
  a.change((d) => addCanvas(d, newCanvas("r", IMAGE, "other", originPlane("XY"), [0, 0], 10, BOX)));
  const b = new Repo().import<CadModelDoc>(save(a.doc()));
  a.change((d) => updateCanvas(d, "c", { scale: 0.3 }));
  b.change((d) => updateCanvas(d, "c", { opacity: 0.8 }));
  a.change((d) => removeCanvas(d, "r"));
  b.change((d) => updateCanvas(d, "r", { name: "renamed" }));
  a.merge(b);
  expect(canvases(a.doc()).map((c) => ["scale" in c && c.scale, c.opacity])).toEqual([[0.3, 0.8]]);
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

test("an image's points are placed by its pinned point, its scale and its angle", () => {
  const p = { at: [100, 50] as [number, number], position: [10, 5] as [number, number], scale: 0.2, angle: 0 };
  expect(imagePoint(p, BOX, [0.5, 0.5])).toEqual([10, 5]);
  expect(imagePoint(p, BOX, [0, 0])).toEqual([-10, -5]);
  expect(imagePoint(p, BOX, [1, 1])).toEqual([30, 15]);
  // The image's y is down, the plane's up.
  expect(toPlane(p, [100, 0])).toEqual([10, 15]);
  near(toPlane({ ...p, angle: 90 }, [200, 50]), [10, 25]);
  const corners = canvasCorners(p, originPlane("XZ", 2), BOX);
  // XZ's y axis is +Z, and it lies at y = -2.
  expect(corners.map((c) => c.map((x) => Math.round(x * 1e9) / 1e9 + 0))).toEqual([
    [-10, -2, -5],
    [30, -2, -5],
    [30, -2, 15],
    [-10, -2, 15],
  ]);
});

test("an image that grows keeps its scale, and what was drawn stays where it was", () => {
  const handle = model();
  handle.change((d) => addCanvas(d, newCanvas("a", IMAGE, "sketch", originPlane("XY"), [0, 0], 40, BOX)));
  const canvas = canvases(handle.doc())[0]!;
  const before = placementOf(canvas, BOX).placement;
  // Twice as wide, to the right, as an editor that keeps its coordinates exports it.
  const wider = placementOf(canvas, { x: 0, y: 0, width: 400, height: 100 }).placement;
  expect(toPlane(wider, [150, 20])).toEqual(toPlane(before, [150, 20]));
  expect(canvasCorners(wider, originPlane("XY"), { x: 0, y: 0, width: 400, height: 100 })[1]![0]).toBe(60);
});

test("an anchor pins the image by its element's centre, however the image changes; without it, by where it was picked", () => {
  const frame: ImageElement = { attribute: "data-cell-id", value: "frame", box: { x: 20, y: 10, width: 40, height: 20 } };
  const canvas = { id: "a", name: "s", image: IMAGE, plane: originPlane("XY"), at: [40, 20] as [number, number], position: [5, 5] as [number, number], scale: 0.5, angle: 0, opacity: 1, through: false, anchor: { attribute: "data-cell-id", value: "frame" } };
  expect(placementOf(canvas, BOX, [frame])).toEqual({ placement: { at: [40, 20], position: [5, 5], scale: 0.5, angle: 0 }, anchorLost: false });
  // Cropped anew after the drawing grew 30 units to the left: the frame is further right in the image, and stays put.
  const moved = { ...frame, box: { ...frame.box, x: 50 } };
  const { placement } = placementOf(canvas, { ...BOX, width: 230 }, [moved]);
  expect(placement.at).toEqual([70, 20]);
  expect(toPlane(placement, [70, 20])).toEqual([5, 5]);
  // Gone: by `at`, and marked; not yet measured: by `at`, unmarked.
  expect(placementOf(canvas, BOX, [])).toEqual({ placement: { at: [40, 20], position: [5, 5], scale: 0.5, angle: 0 }, anchorLost: true });
  expect(placementOf(canvas, BOX, undefined).anchorLost).toBe(false);
});

test("an anchor whose id an editor renumbered is found by its name, if one element alone has it", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  const anchor = { attribute: "id", value: "eye1", name: "eye" };
  // Affinity numbers duplicate layer names, Figma suffixes them: another "eye" before it, and it is eye2.
  expect(anchorElement(anchor, [{ attribute: "id", value: "eye2", name: "eye", box }])?.value).toBe("eye2");
  expect(anchorElement(anchor, [{ attribute: "id", value: "eye2", name: "eye", box }, { attribute: "id", value: "eye3", name: "eye", box }])).toBeUndefined();
  // Its id, where it has it, comes first.
  expect(anchorElement(anchor, [{ attribute: "id", value: "eye1", name: "nose", box }, { attribute: "id", value: "eye2", name: "eye", box }])?.value).toBe("eye1");
  expect(anchorElement({ attribute: "id", value: "eye1" }, [{ attribute: "id", value: "eye2", name: "eye", box }])).toBeUndefined();
});

test("picking an anchor takes the smallest named element there, and leaves the image where it is", () => {
  const elements: ImageElement[] = [
    { attribute: "data-cell-id", value: "1", box: { x: 0, y: 0, width: 200, height: 100 } },
    { attribute: "id", value: "frame", box: { x: 20, y: 10, width: 40, height: 20 } },
  ];
  expect(elementAt(elements, [30, 15])?.value).toBe("frame");
  expect(elementAt(elements, [150, 80])?.value).toBe("1");
  expect(elementAt(elements, [250, 80])).toBeUndefined();
  const p = { at: [100, 50] as [number, number], position: [0, 0] as [number, number], scale: 0.2, angle: 30 };
  const pinned = repinned(p, [40, 20]);
  expect(pinned.at).toEqual([40, 20]);
  for (const point of [[0, 0], [40, 20], [200, 100]] as const) near(toPlane(pinned, point), toPlane(p, point));
  // Centred on a face: the image's centre goes there, whatever it is pinned by.
  near(toPlane(centredAt(pinned, BOX, [7, 3]), [100, 50]), [7, 3]);
});

test("a canvas stored with a centre and width is pinned by its image's centre, and stored with a scale on its first edit", () => {
  const legacy: LegacyCanvas = { id: "old", name: "old", image: IMAGE, plane: originPlane("XY"), center: [1, 2], angle: 0, width: 40, opacity: 0.5, through: false };
  expect(placementOf(legacy, BOX)).toEqual({ placement: { at: [100, 50], position: [1, 2], scale: 0.2, angle: 0 }, anchorLost: false });
  const handle = model();
  handle.change((d) => {
    d.cad = { canvases: [legacy] };
  });
  handle.change((d) => updateCanvas(d, "old", { ...placementOf(legacy, BOX).placement, opacity: 0.7 }));
  expect(canvases(handle.doc())[0]).toEqual({ id: "old", name: "old", image: IMAGE, plane: originPlane("XY"), at: [100, 50], position: [1, 2], scale: 0.2, angle: 0, opacity: 0.7, through: false });
});

test("Calibrate sets the scale that makes two points of the image the typed distance apart", () => {
  // Half the image's width apart: 100 units.
  const points = [[0.25, 0.25], [0.75, 0.25]] as const;
  expect(calibratedScale(BOX, points, 30)).toBe(0.3);
  expect(imageDistance({ scale: 0.3 }, BOX, points)).toBeCloseTo(30, 9);
  // Vertically, the image's height counts.
  expect(calibratedScale(BOX, [[0.5, 0], [0.5, 0.5]], 10)).toBe(0.2);
  expect(calibratedScale(BOX, [[0.5, 0.5], [0.5, 0.5]], 10)).toBeUndefined();
  expect(calibratedScale(BOX, points, 0)).toBeUndefined();
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
