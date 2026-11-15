/**
 * Canvases (research/21-embedding.md, "Canvas"): an image dragged from Patchwork's sidebar into the
 * view, which becomes a canvas on XY when Canvas is chosen; its dialog placing it on another origin
 * plane, turning, scaling and fading it and drawing it through the model; Calibrate; the eye in the
 * browser's Canvases; Remove and undo. And an image dropped on a face, which lies on that face,
 * centred where it was dropped, follows it as the model changes, and is marked once the face is gone.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, clickEntity, createModel, dialog, docUrl, editorView, entities, setModelSource, timelineEntry, type Entity } from "../cad.ts";
import { drag, pngBytes, sidebarDocuments, type Repo } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const PLATE = (distance: number, name = "extrude1") => `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const ${name} = extrude({ sketch: sketch1, distance: ${distance} });
  return { plate: ${name} };
}
`;

/** An SVG 200 × 100 by its viewBox alone, which Firefox draws at no size: a frame, a grid line every 20 units, and a mark at (40, 50). */
const GRID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="1" y="1" width="198" height="98" fill="#eef6ff" stroke="#204080" stroke-width="2"/>
  <path d="M20 0V100M40 0V100M60 0V100M80 0V100M100 0V100M120 0V100M140 0V100M160 0V100M180 0V100M0 20H200M0 40H200M0 60H200M0 80H200" stroke="#80a0d0" stroke-width="0.5"/>
  <circle cx="40" cy="50" r="6" fill="#d04020"/>
</svg>`;

async function open(page: Page) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // The document sidebar stays, where documents are dragged from.
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, PLATE(5), "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => entities(page, "face").then((f) => f.length), { timeout: 60_000 }).toBeGreaterThan(0);
  // Changes within 500 ms of each other are one undo step (research/16).
  await page.waitForTimeout(600);
}

type StoredCanvas = { id: string; name: string; image: string; plane: { origin?: number[]; normal?: number[]; xDir?: number[]; entityName?: string; feature?: string }; at: [number, number]; position: [number, number]; angle: number; scale: number; anchor?: { attribute: string; value: string }; opacity: number; through: boolean };
const canvasesOf = (page: Page) =>
  page.evaluate(async (url) => {
    const doc = (await (window as unknown as { repo: Repo }).repo.find(url)).doc() as { cad?: { canvases?: StoredCanvas[] } };
    return JSON.parse(JSON.stringify(doc.cad?.canvases ?? [])) as StoredCanvas[];
  }, docUrl(page));

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
type Drawn = { id: string; opacity: number; through: boolean; highlight: string | undefined; world: [number, number, number][]; corners: { x: number; y: number }[] };
const drawn = (page: Page) => viewer(page).evaluate((el) => (el as unknown as { cadViewer: { canvases(): Drawn[] } }).cadViewer.canvases());
const canvasPoint = (page: Page, id: string, u: number, v: number) =>
  viewer(page).evaluate((el, [id, u, v]) => (el as unknown as { cadViewer: { canvasPoint(id: string, u: number, v: number): { x: number; y: number } | undefined } }).cadViewer.canvasPoint(id as string, u as number, v as number), [id, u, v] as const);
const screenPoint = (page: Page, face: Entity) => viewer(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
const status = (page: Page) => page.locator(".cad-model__status").first();
const canvasRows = (page: Page) => page.getByRole("list", { name: "Canvases", exact: true }).locator(".cad-editor__browser-row");

/** A face whose reference starts with `name`, that a click reaches, and where it is on the screen; clicking it leaves it selected. */
async function faceNamed(page: Page, name: string): Promise<{ face: Entity; at: { x: number; y: number } }> {
  for (const face of await entities(page, "face")) {
    const at = await screenPoint(page, face);
    if (!at) continue;
    // Selected, so that the name read is this face's: WebKit drops the first click after a drag and drop.
    await expect(async () => {
      await clickEntity(page, face);
      await expect(viewer(page)).toHaveAttribute("data-selected", `${face.body}:face:${face.index}`, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    const reference = page.locator(".cad-model__reference code");
    await expect(reference).toHaveCount(1);
    if (((await reference.textContent()) ?? "").startsWith(name)) return { face, at };
  }
  throw new Error(`no visible face named ${name}…`);
}

/** A point of the view off the model and off the ViewCube: its top left. */
async function emptyView(page: Page) {
  const box = (await page.locator(".cad-editor__stage").boundingBox())!;
  return { x: box.x + 40, y: box.y + 40 };
}

const close = (a: readonly number[], b: readonly number[], digits = 3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, digits));

test("an image inserted as a canvas lies on XY; its dialog places, turns, scales and fades it; Calibrate scales it by two points; the eye hides it", async ({ users }, info) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, { "grid.svg": { file: "grid.svg", mimeType: "image/svg+xml", text: GRID_SVG } });

  // Dropped in the view, it waits; Canvas is offered first, and puts it on XY under the model's centre, about as wide as the model.
  await drag(page, "grid.svg", await emptyView(page), false);
  await expect(status(page)).toContainText("Insert grid.svg");
  await page.mouse.up();
  const roles = dialog(page).getByRole("radiogroup", { name: "Use as" }).getByRole("radio");
  await expect(roles).toHaveText(["Canvas", "Import", "Annotation"]);
  await roles.getByText("Canvas", { exact: true }).click();
  await expect.poll(() => canvasesOf(page).then((l) => l.length)).toBe(1);
  const [stored] = await canvasesOf(page);
  expect(stored).toMatchObject({ name: "grid", image: docs["grid.svg"], plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, at: [100, 50], position: [10, 5], angle: 0, scale: 0.1, opacity: 0.5, through: false });
  const id = stored!.id;
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:canvas:${id}`);
  await expect(dialog(page)).toHaveAttribute("data-role", "canvas");
  await expect(dialog(page).locator(".cad-editor__dialog-header")).toContainText("Canvas grid");
  await expect(dialog(page).getByLabel("Plane", { exact: true })).toHaveValue("XY");

  // Drawn with the image's aspect, 2:1 by its viewBox, outlined while selected; listed under Canvases, not Documents.
  await expect.poll(() => drawn(page).then((d) => d.length), { timeout: 30_000 }).toBe(1);
  const [first] = await drawn(page);
  expect(first!.highlight).toBe("accent");
  expect(first!.world).toEqual([
    [0, 0, 0],
    [20, 0, 0],
    [20, 10, 0],
    [0, 10, 0],
  ]);
  await expect(canvasRows(page)).toHaveCount(1);
  await expect(canvasRows(page)).toContainText("grid");
  await expect(canvasRows(page)).toContainText("on XY");
  await expect(page.getByRole("list", { name: "Documents", exact: true })).toHaveCount(0);
  await expect(dialog(page).getByLabel("Width", { exact: true })).toHaveValue("20");
  await expect(dialog(page).locator('[data-param="width"]')).toContainText("× 10");
  if (shots) await page.screenshot({ path: `${shots}/canvas-xy-${info.project.name}.png` });

  // Each field applies as it is typed: the position of its pinned point, the image's centre; the angle; the width, as a scale; the opacity; through the model.
  const field = (label: string) => dialog(page).getByLabel(label, { exact: true });
  await field("Position x").fill("0");
  await field("Position y").fill("0");
  await field("Angle").fill("90");
  await field("Width").fill("40");
  await expect.poll(() => canvasesOf(page).then((l) => l[0] && [l[0].position, l[0].angle, l[0].scale])).toEqual([[0, 0], 90, 0.2]);
  close((await drawn(page))[0]!.world[0]!, [10, -20, 0]);
  await field("Opacity").fill("80");
  await field("through the model").check();
  await expect.poll(() => canvasesOf(page).then((l) => l[0] && [l[0].opacity, l[0].through])).toEqual([0.8, true]);
  await expect.poll(() => drawn(page).then((d) => d[0] && [d[0].opacity, d[0].through])).toEqual([0.8, true]);
  // A width that isn't positive isn't taken.
  await field("Width").fill("-3");
  await field("Width").press("Enter");
  await expect(field("Width")).toHaveAttribute("class", /--invalid/);
  await field("Width").press("Tab");
  await expect(field("Width")).toHaveValue("40");

  // Another origin plane, moved along its normal.
  await field("Plane").selectOption("XZ");
  await field("Offset").fill("3");
  await expect.poll(() => canvasesOf(page).then((l) => l[0]?.plane)).toEqual({ origin: [0, -3, 0], normal: [0, -1, 0], xDir: [1, 0, 0] });
  await expect(canvasRows(page)).toContainText("on XZ at 3");
  if (shots) await page.screenshot({ path: `${shots}/canvas-xz-${info.project.name}.png` });
  await field("Plane").selectOption("XY");
  await field("Offset").fill("0");
  await field("Angle").fill("0");
  await field("through the model").uncheck();
  await expect.poll(() => canvasesOf(page).then((l) => l[0] && [l[0].plane.origin, l[0].plane.normal, l[0].angle, l[0].through])).toEqual([[0, 0, 0], [0, 0, 1], 0, false]);

  // Calibrate: two points of the image, picked in the view, and their distance set the scale; the pinned point stays.
  const calibrate = dialog(page).getByRole("button", { name: "Calibrate", exact: true });
  await calibrate.click();
  await expect(status(page)).toContainText("click the first of two points");
  // Two points of the image the view shows, beside the dialog, as far apart as it shows them.
  const reachable: number[] = [];
  for (let i = 0; i <= 20; i++) {
    const p = await canvasPoint(page, id, i / 20, 0.25);
    if (p && (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches(".cad-model__viewer > canvas") ?? false, p))) reachable.push(i / 20);
  }
  const [u0, u1] = [reachable[0]!, reachable.at(-1)!];
  expect(u1 - u0).toBeGreaterThanOrEqual(0.15);
  for (const u of [u0, u1]) {
    const p = (await canvasPoint(page, id, u, 0.25))!;
    await page.mouse.click(p.x, p.y);
  }
  await expect(status(page)).toContainText("type the distance");
  // As far apart as they are on the canvas, 40 wide.
  const distance = field("Distance");
  await expect.poll(async () => Number(await distance.inputValue()) / ((u1 - u0) * 40)).toBeCloseTo(1, 2);
  if (shots) await page.screenshot({ path: `${shots}/canvas-calibrate-${info.project.name}.png` });
  await distance.fill("50");
  await distance.press("Enter");
  // Clicked pixels are the picked points, as near as a pixel is.
  await expect.poll(() => canvasesOf(page).then((l) => (l[0]!.scale * 200) / (50 / (u1 - u0)))).toBeCloseTo(1, 2);
  await expect(distance).toHaveCount(0);
  expect((await canvasesOf(page))[0]!.position).toEqual([0, 0]);

  // The eye hides it for this user only, and shows it again.
  const eye = canvasRows(page).getByRole("button", { name: "Hide grid" });
  await eye.click();
  await expect.poll(() => drawn(page).then((d) => d.length)).toBe(0);
  await expect(canvasRows(page)).toHaveAttribute("data-visible", "false");
  expect(await canvasesOf(page)).toHaveLength(1);
  await canvasRows(page).getByRole("button", { name: "Show grid" }).click();
  await expect.poll(() => drawn(page).then((d) => d.length)).toBe(1);

  // Remove deletes it; undo brings it back. Apart from the last edit, or undo takes back both (research/16).
  await page.waitForTimeout(600);
  const before = await canvasesOf(page);
  await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => canvasesOf(page).then((l) => l.length)).toBe(0);
  await expect(canvasRows(page)).toHaveCount(0);
  await page.locator(".cad-editor__stage").focus();
  await pressMod(page, "z");
  await expect.poll(() => canvasesOf(page)).toEqual(before);
  await expect.poll(() => drawn(page).then((d) => d.length)).toBe(1);
});

/**
 * A plan cropped to what is drawn, as most editors export SVGs: a reference frame, `id="frame"` or
 * another, named "Frame" as Illustrator keeps a layer's name, at (60, 10) to (80, 20), labelled as
 * draw.io labels its shapes, in HTML in a `foreignObject` as large as the SVG with a `text` to fall
 * back on, and, `left` units further left, a wall, which the crop starts at; 100 + `left` × 50 by its
 * size, with a viewBox from 0.
 */
const PLAN_SVG = (left: number, frame: string | false = "frame") => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${100 + left}" height="50" viewBox="0 0 ${100 + left} 50">
  <g id="layer1" inkscape:groupmode="layer" inkscape:label="Layer 1">
    <rect x="0" y="0" width="${100 + left}" height="50" fill="#f4f8ff"/>
    <rect id="wall" x="0" y="30" width="${10 + left}" height="10" fill="#204080"/>
    ${frame ? `<g id="${frame}" data-name="Frame"><rect x="${60 + left}" y="10" width="20" height="10" fill="none" stroke="#d04020" stroke-width="2"/><switch><foreignObject width="100%" height="100%" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility"><div xmlns="http://www.w3.org/1999/xhtml" style="margin-left: ${62 + left}px; padding-top: 12px; font-size: 5px">Frame</div></foreignObject><text x="${70 + left}" y="17" font-size="5" text-anchor="middle">Frame</text></switch></g>` : ""}
  </g>
</svg>`;

test("an SVG pinned by an element of it, picked in the view, stays put as the drawing grows to the left, at its scale; an anchor that is gone marks it", async ({ users }, info) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, { "plan.svg": { file: "plan.svg", mimeType: "image/svg+xml", text: PLAN_SVG(0) } });
  await drag(page, "plan.svg", await emptyView(page), false);
  await page.mouse.up();
  await dialog(page).getByRole("radiogroup", { name: "Use as" }).getByText("Canvas", { exact: true }).click();
  await expect.poll(() => canvasesOf(page).then((l) => l.length)).toBe(1);
  const id = (await canvasesOf(page))[0]!.id;
  await expect.poll(() => drawn(page).then((d) => d.length), { timeout: 30_000 }).toBe(1);
  const before = (await drawn(page))[0]!.world;
  const anchorField = dialog(page).locator('[data-param="canvas-anchor"]');
  await expect(anchorField).toContainText("None");

  // Pick anchor: the model isn't hovered meanwhile, under the plate; the element under the pointer is outlined, and the layer around everything isn't one.
  // A point of the image off the wall and the frame, image y 25, under the plate, that the view gets, not the dialog.
  let underPlate: { x: number; y: number } | undefined;
  for (let i = 20; i >= 0 && !underPlate; i--) {
    const p = await canvasPoint(page, id, i / 20, 0.5);
    if (p && (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches(".cad-model__viewer > canvas") ?? false, p))) underPlate = p;
  }
  if (!underPlate) throw new Error("no point of the canvas in the view");
  await page.mouse.move(underPlate.x, underPlate.y);
  await expect(viewer(page)).toHaveAttribute("data-hovered", /.+/);
  await anchorField.getByRole("button", { name: "Pick anchor" }).click();
  await expect(status(page)).toContainText("Pick anchor");
  const overlays = () => viewer(page).getAttribute("data-overlays");
  await page.mouse.move(underPlate.x + 1, underPlate.y);
  await expect(viewer(page)).not.toHaveAttribute("data-hovered", /.+/);
  await expect.poll(overlays).toBe("0");
  const onFrame = (await canvasPoint(page, id, 0.7, 0.7))!;
  await page.mouse.move(onFrame.x, onFrame.y);
  await expect.poll(overlays).toBe("1");
  if (shots) await page.screenshot({ path: `${shots}/canvas-anchor-hover-${info.project.name}.png` });
  // A click off any element but the layer picks nothing.
  await page.mouse.click(underPlate.x, underPlate.y);
  await expect(page.locator(".cad-model__status").first()).toContainText("No element with an id there");
  expect((await canvasesOf(page))[0]!.anchor).toBeUndefined();
  // A click on the frame, the smallest named element there: the image stays where it is, pinned by the frame's centre.
  await page.mouse.click(onFrame.x, onFrame.y);
  await expect.poll(() => canvasesOf(page).then((l) => l[0] && [l[0].anchor, l[0].at])).toEqual([{ attribute: "id", value: "frame", name: "Frame" }, [70, 15]]);
  await expect(anchorField).toContainText("Frame");
  close((await drawn(page))[0]!.world.flat(), before.flat());
  if (shots) await page.screenshot({ path: `${shots}/canvas-anchor-${info.project.name}.png` });

  // The wall grows 50 units to the left, and the crop with it: the frame is 50 units further right in the image, and stays where it was.
  const setPlan = (svg: string) => page.evaluate(async ([u, text]) => (await (window as unknown as { repo: Repo }).repo.find(u!)).change((d) => (d["content"] = text)), [docs["plan.svg"], svg] as const);
  const scale = (await canvasesOf(page))[0]!.scale;
  await setPlan(PLAN_SVG(50));
  // Its left edge 50 units further left, its right edge where it was: the image is larger, at its scale.
  await expect.poll(() => drawn(page).then((d) => d[0]!.world[0]![0]), { timeout: 30_000 }).toBeCloseTo(before[0]![0] - 50 * scale, 6);
  close((await drawn(page))[0]!.world[1]!, before[1]!);
  // Its id renumbered, as an editor does to keep ids unique, as the wall grows further: found by its name, it stays.
  await setPlan(PLAN_SVG(80, "frame_2"));
  await expect.poll(() => drawn(page).then((d) => d[0]!.world[0]![0]), { timeout: 30_000 }).toBeCloseTo(before[0]![0] - 80 * scale, 6);
  close((await drawn(page))[0]!.world[1]!, before[1]!);
  await expect(canvasRows(page).locator('[data-placement="problem"]')).toHaveCount(0);

  // The frame deleted: the canvas is marked, and the image lies by where the frame was in the image when it was picked, (70, 15), its left edge back where it was.
  await setPlan(PLAN_SVG(50, false));
  await expect(canvasRows(page).locator('[data-placement="problem"]')).toHaveAttribute("title", "Its anchor isn't in the image", { timeout: 30_000 });
  await expect(anchorField.getByRole("img")).toHaveAttribute("title", "The image has no such element");
  close((await drawn(page))[0]!.world.flat(), before.map((p, i) => (i === 1 || i === 2 ? [p[0]! + 50 * scale, p[1]!, p[2]!] : p)).flat());
  // Removing it pins the image by where it lies.
  await anchorField.getByRole("button", { name: "Remove anchor" }).click();
  await expect.poll(() => canvasesOf(page).then((l) => l[0] && "anchor" in l[0])).toBe(false);
  await expect(canvasRows(page).locator('[data-placement="problem"]')).toHaveCount(0);
});

test("an image dropped on a face lies on it, centred where it was dropped, and follows it; a face that is gone marks it", async ({ users }, info) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "photo.png": { file: "photo.png", mimeType: "image/png", bytes: await pngBytes(page, 160, 120) } });
  const { at } = await faceNamed(page, "extrude1.end");

  // On a face, an image waits for its role, which keeps the face.
  await drag(page, "photo.png", at, false);
  await expect(status(page)).toContainText("Insert photo.png to the face");
  await page.mouse.up();
  await expect(dialog(page).locator('[data-param="anchor"]')).toContainText("extrude1.end");
  await dialog(page).getByRole("radiogroup", { name: "Use as" }).getByText("Canvas", { exact: true }).click();
  await expect.poll(() => canvasesOf(page).then((l) => l.length)).toBe(1);
  const [stored] = await canvasesOf(page);
  expect(stored!.plane.entityName).toMatch(/^extrude1\.end/);
  expect(stored!.plane.feature).toBe("extrude1");
  // Centred where it was dropped, which is on the top face, inside it.
  expect(stored!.position[0]).toBeGreaterThan(0);
  expect(stored!.position[0]).toBeLessThan(20);
  expect(stored!.position[1]).toBeGreaterThan(0);
  expect(stored!.position[1]).toBeLessThan(10);
  await expect(canvasRows(page)).toContainText(/on extrude1\.end/);
  await expect.poll(() => drawn(page).then((d) => d[0]?.world.map((p) => p[2])), { timeout: 30_000 }).toEqual([5, 5, 5, 5]);
  // The PNG's aspect, 120 / 160.
  const world = (await drawn(page))[0]!.world;
  expect((world[3]![1] - world[0]![1]) / (world[1]![0] - world[0]![0])).toBeCloseTo(0.75, 6);
  if (shots) await page.screenshot({ path: `${shots}/canvas-face-${info.project.name}.png` });

  // It follows the face when the model changes.
  await setModelSource(page, PLATE(8), "replace");
  await expect.poll(() => drawn(page).then((d) => d[0]?.world.map((p) => p[2])), { timeout: 60_000 }).toEqual([8, 8, 8, 8]);

  // A face picked in the dialog moves it there, centred on that face. Found first: a click in the view closes the dialog.
  const { face: side } = await faceNamed(page, "extrude1.side");
  await canvasRows(page).locator(".cad-editor__browser-name").click();
  await expect(dialog(page)).toHaveAttribute("data-role", "canvas");
  await dialog(page).getByRole("button", { name: "Select face", exact: true }).click();
  await clickEntity(page, side);
  await expect.poll(() => canvasesOf(page).then((l) => l[0]?.plane.entityName)).toMatch(/^extrude1\.side/);
  await expect.poll(() => drawn(page).then((d) => (d[0] ? new Set(d[0].world.map((p) => p[2])).size : 0))).toBeGreaterThan(1);
  if (shots) await page.screenshot({ path: `${shots}/canvas-side-${info.project.name}.png` });

  // Renamed, the feature's faces are gone: the canvas isn't drawn, and its row is marked.
  await setModelSource(page, PLATE(8, "plate1"), "replace");
  await expect(timelineEntry(page, "plate1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => drawn(page).then((d) => d.length)).toBe(0);
  await expect(canvasRows(page).locator('[data-placement="problem"]')).toHaveAttribute("title", "Its face isn't in the model");
});
