/**
 * A CAD model in a scene (research/23-scene-editing.md): dropped into a scene from the sidebar, it is
 * built there, and its Open lays the editor over the scene, which draws the live build and hovers it
 * through the scene's input; Escape leaves. The editor's views move the scene's camera and are made from it.
 */
import type { Page } from "@playwright/test";
import { cameraDirection, clickHome, clickViewCube, docPathWith, entities, exampleSource, hideSidebars, timelineEntry, toolbarButton, type Entity, type EntityKind, type Region } from "../cad.ts";
import { drag, pngBytes, sidebarDocuments } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { annotationsOf, built, builtBounds, builtGlb, entityKey, highlightedInScene, hostView, hoverInScene, modelInScene, openSelected, SCENE_MODULES, sceneEditor, sceneObjects, selectInScene, sourceOf } from "../scene.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: SCENE_MODULES });

const shots = process.env["CAD_SHOTS"];

/** The first visible entity of `kind` that the pointer hovers as itself, hovered. */
async function hoverFirst(page: Page, kind: EntityKind): Promise<Entity> {
  for (const e of await entities(page, kind)) if (await hoverInScene(page, e)) return e;
  throw new Error(`no ${kind} can be hovered`);
}

/** Opens M1's editor in a scene. */
async function openM1InScene(page: Page): Promise<void> {
  await modelInScene(page, exampleSource("m1"), "Bracket");
  await openSelected(page);
  await expect.poll(async () => Number(await hostView(page).getAttribute("data-vertices"))).toBeGreaterThan(0);
}

test("a model dropped into a scene is built there, and its Open edits it in place", async ({ page }) => {
  await bootToFrame(page);
  await modelInScene(page, exampleSource("m1"), "Bracket");
  await openSelected(page);
  // The live build, drawn by the scene.
  await expect.poll(async () => Number(await hostView(page).getAttribute("data-vertices"))).toBeGreaterThan(0);
  const faces = await entities(page, "face");
  expect(faces.length).toBeGreaterThan(0);

  // The pointer hovers a face through the scene's hand.
  const face = faces[0]!;
  const point = await hostView(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: unknown): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
  expect(point).toBeDefined();
  await page.mouse.move(point!.x, point!.y);
  await expect(hostView(page)).toHaveAttribute("data-hovered", `${face.body}:face:${face.index}`);

  // Escape: nothing is selected or picked, so it leaves.
  await page.mouse.move(1, 1);
  await page.keyboard.press("Escape");
  await expect(sceneEditor(page)).toHaveCount(0);
});

test("a click selects a face or an edge, drawn as the editor's own view draws it; a click off the model clears it", async ({ page }) => {
  await bootToFrame(page);
  await openM1InScene(page);

  const face = await hoverFirst(page, "face");
  expect(await highlightedInScene(page, "hover")).toEqual([face]);
  if (shots) await page.screenshot({ path: `${shots}/scene-1-hover-face.png` });
  await page.mouse.down();
  await page.mouse.up();
  await expect(hostView(page)).toHaveAttribute("data-selected", entityKey(face));
  // Hovered and selected: the selection's fill stays, under the hover's outline.
  expect(await highlightedInScene(page, "accent")).toEqual([face]);
  if (shots) await page.screenshot({ path: `${shots}/scene-2-selected-face.png` });

  const edge = await hoverFirst(page, "edge");
  await page.mouse.down();
  await page.mouse.up();
  await expect(hostView(page)).toHaveAttribute("data-selected", entityKey(edge));
  expect(await highlightedInScene(page, "accent")).toEqual([edge]);
  if (shots) await page.screenshot({ path: `${shots}/scene-3-selected-edge.png` });

  // Off the model, in the part of the scene's view that the editor's panels leave free.
  const free = (await hostView(page).boundingBox())!;
  await page.mouse.click(free.x + free.width - 30, free.y + free.height - 30);
  await expect(hostView(page)).toHaveAttribute("data-selected", "");
  expect(await highlightedInScene(page, "accent")).toEqual([]);
  await expect(sceneEditor(page)).toBeVisible();
});

async function expectDirection(page: Page, region: Region | [number, number, number]): Promise<void> {
  const length = Math.hypot(...region);
  await expect.poll(() => cameraDirection(page)).toEqual(region.map((c) => expect.closeTo(c / length, 2)));
}

/** Orbits the scene's camera by a left drag over an empty part of the view, `dx` pixels across. */
async function orbit(page: Page, dx: number): Promise<void> {
  const free = (await hostView(page).boundingBox())!;
  const from = { x: free.x + free.width - 60, y: free.y + free.height - 60 };
  const before = await cameraDirection(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - dx, from.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => cameraDirection(page)).not.toEqual(before);
}

/** Whether the ViewCube was last drawn for the camera as it is now. */
async function cubeFollows(page: Page): Promise<boolean> {
  const drawnFor = (await hostView(page).locator(".cad-viewcube").getAttribute("data-direction"))?.split(",").map(Number) ?? [];
  const now = await cameraDirection(page);
  return drawnFor.length === 3 && drawnFor.every((c, i) => Math.abs(c - now[i]!) < 0.01);
}

type Intent = { fit?: number[]; subject?: { faces: unknown[] } } | undefined;
const intent = (page: Page) => hostView(page).evaluate((el) => (el as unknown as { cadViewer: { intent(): Intent } }).cadViewer.intent());

test("views move the scene's camera: the ViewCube, Home, a named view made from the camera, a close-up's subject", async ({ page }) => {
  await bootToFrame(page);
  await openM1InScene(page);
  const views = page.locator(".cad-editor__browser").getByRole("list", { name: "Views" });
  const row = (name: string) => views.locator(`.cad-editor__named-row[data-name="${name}"]`);

  await clickViewCube(page, [0, -1, 0]);
  await expectDirection(page, [0, -1, 0]);
  // Turned from a camera that showed all of the model: it still does, with its margins.
  expect((await intent(page))?.fit).toBeDefined();
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  await views.locator(".cad-editor__rename").fill("Front");
  await views.locator(".cad-editor__rename").press("Enter");
  await expect(row("Front")).toHaveAttribute("data-current", "true");
  if (shots) await page.screenshot({ path: `${shots}/scene-4-front.png` });

  // The edge between front and top: the top is edge-on from the front.
  await clickViewCube(page, [0, -1, 1]);
  await expectDirection(page, [0, -1, 1]);
  await expect(row("Front")).not.toHaveAttribute("data-current", "true");
  await row("Front").click();
  await expect(hostView(page)).toHaveAttribute("data-turning", "false");
  await expectDirection(page, [0, -1, 0]);
  await expect(row("Front")).toHaveAttribute("data-current", "true");

  await clickHome(page);
  await expectDirection(page, [0.55, -0.85, 0.65]);
  await expect(row("Home")).toHaveAttribute("data-current", "true");

  // Orbited with the scene's own controls: the ViewCube follows, though nothing the scene tells its plugins' update() changed.
  await orbit(page, 120);
  await expect.poll(() => cubeFollows(page)).toBe(true);

  // Close to a face: the model is cut off, and the faces in the view are its subject.
  const at = await visiblePoint(page, "face");
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => {
    await page.mouse.wheel(0, -400);
    return (await intent(page))?.subject?.faces.length ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
  expect((await intent(page))?.fit).toBeUndefined();
  if (shots) await page.screenshot({ path: `${shots}/scene-5-close-up.png` });
});

/** Two squares side by side: two profiles. */
const SQUARES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 20"><rect id="a" x="0" y="0" width="20" height="20"/><rect id="b" x="40" y="0" width="20" height="20"/></svg>`;
const plateWith = (drawing: string) => `import { sketch, plane, rect, extrude, svg } from "@patchwork-cad/features";
import squares from "${drawing}" with { type: "text" };
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [-60, -40], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance: 8 });
  const sketch2 = sketch({ plane: plate.end, body: plate, profile: svg(squares, { width: 60, center: [0, 0] }) });
  return { plate };
}
`;
type ShownRegion = { key: string; chosen: boolean; hovered: boolean; point: { x: number; y: number } | undefined };
const regions = (page: Page) => hostView(page).evaluate((el) => (el as unknown as { cadViewer: { regions(): ShownRegion[] } }).cadViewer.regions());

test("an extrusion picks a sketch's profiles in the scene: hovered and chosen as in the editor's own view", async ({ page }) => {
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, { "squares.svg": { file: "squares.svg", mimeType: "image/svg+xml", text: SQUARES } });
  const { model } = await modelInScene(page, plateWith(docs["squares.svg"]!), "Plate");
  await openSelected(page);
  // Built, and used by nothing yet.
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "unused", { timeout: 60_000 });
  await clickHome(page);

  await timelineEntry(page, "sketch2").click();
  await toolbarButton(page, "Extrude").click();
  await expect.poll(() => regions(page).then((r) => r.length), { timeout: 60_000 }).toBe(2);
  const region = (await regions(page)).find((r) => r.point && !r.chosen)!;
  await page.mouse.move(region.point!.x, region.point!.y);
  await expect.poll(() => regions(page).then((all) => all.find((r) => r.key === region.key)?.hovered)).toBe(true);
  // Nothing of the model is hovered meanwhile.
  await expect(hostView(page)).toHaveAttribute("data-hovered", "");
  if (shots) await page.screenshot({ path: `${shots}/scene-6-region-hovered.png` });
  await page.mouse.click(region.point!.x, region.point!.y);
  await expect.poll(() => regions(page).then((r) => r.filter((x) => x.chosen).map((x) => x.key))).toEqual([region.key]);
  expect(await sourceOf(page, model)).toMatch(/const extrude1 = extrude\(\{[^\n]*regions: \[sketch2\.region\([^)]*\)\]/);
  if (shots) await page.screenshot({ path: `${shots}/scene-7-region-chosen.png` });
});

const status = (page: Page) => page.locator(".cad-model__status").first();

/** Where a click reaches the first visible entity of `kind`. */
async function visiblePoint(page: Page, kind: EntityKind): Promise<{ x: number; y: number }> {
  for (const e of await entities(page, kind)) {
    const at = await hostView(page).evaluate((el, x) => (el as unknown as { cadViewer: { screenPoint(e: unknown): { x: number; y: number } | undefined } }).cadViewer.screenPoint(x), e);
    if (at) return at;
  }
  throw new Error(`no ${kind} is visible`);
}

test("documents dropped in the scene's view are the editor's: on a face pinned there, elsewhere waiting for their role", async ({ page }) => {
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, {
    "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" },
    "squares.svg": { file: "squares.svg", mimeType: "image/svg+xml", text: SQUARES },
  });
  const { model, scene } = await modelInScene(page, plateWith(docs["squares.svg"]!), "Plate", { sidebar: true });
  await openSelected(page);
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "unused", { timeout: 60_000 });
  await clickHome(page);

  // From Patchwork's sidebar onto a face: pinned there, and the scene places nothing.
  const at = await visiblePoint(page, "face");
  await drag(page, "notes.txt", at, false);
  await expect(status(page)).toContainText("Pin notes.txt to the face");
  await page.mouse.up();
  await expect.poll(() => annotationsOf(page, model).then((l) => l.map((a) => a.doc))).toEqual([docs["notes.txt"]]);
  expect(await sceneObjects(page, scene)).toHaveLength(1);

  // A document row of the editor's browser into the view, off the model: it waits for its role.
  const free = (await hostView(page).boundingBox())!;
  const grip = page.locator('.cad-editor__document-row[data-name="squares"] .cad-editor__grip');
  await drag(page, grip, { x: free.x + free.width - 40, y: free.y + free.height - 40 }, false);
  await expect(status(page)).toContainText("Insert squares");
  await page.mouse.up();
  await expect(page.locator('.cad-editor__dialog[data-feature="insert"]')).toBeVisible();
  expect(await sceneObjects(page, scene)).toHaveLength(1);
});

const pins = (page: Page) => hostView(page).locator(".cad-model__pin:not([data-new])");

test("pins and collaborators' pointers show in the scene: B sees A's annotation pinned to a face, and A's pointer on the model", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  const docs = await sidebarDocuments(a.page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" } });
  const { model, scene } = await modelInScene(a.page, exampleSource("m1"), "Bracket", { sidebar: true });
  await openSelected(a.page);
  await expect.poll(async () => Number(await hostView(a.page).getAttribute("data-vertices"))).toBeGreaterThan(0);
  await drag(a.page, "notes.txt", await visiblePoint(a.page, "face"));
  await expect.poll(() => annotationsOf(a.page, model).then((l) => l.map((x) => x.doc))).toEqual([docs["notes.txt"]]);
  await expect(pins(a.page)).toHaveCount(1);
  await expect(pins(a.page)).toBeVisible();
  await expect(pins(a.page)).toHaveAttribute("aria-label", "notes");
  // The pin stays on its face as the scene's camera orbits.
  await hideSidebars(a.page);
  const before = await pins(a.page).boundingBox();
  await orbit(a.page, 80);
  await expect.poll(() => pins(a.page).boundingBox()).not.toEqual(before);

  // B opens the same scene, and the model's editor in it.
  await bootToFrame(b.page, docPathWith(a.page));
  await hideSidebars(b.page);
  // Selected by its row in B's Inspector, once the scene has built it.
  await expect.poll(() => built(b.page, scene), { timeout: 60_000 }).toBe(true);
  await selectInScene(b.page, "Bracket");
  await openSelected(b.page);
  await expect(pins(b.page)).toHaveCount(1, { timeout: 30_000 });
  await expect(pins(b.page)).toBeVisible();
  // A pin opens what is pinned there.
  await pins(b.page).click();
  await expect(b.page.locator(".cad-editor__pin-dialog, .cad-model__comments-popover").first()).toBeVisible();
  await b.page.keyboard.press("Escape");

  // A's pointer on the model: a marker in B's view.
  await a.page.mouse.move(...Object.values(await visiblePoint(a.page, "face")) as [number, number]);
  await expect(hostView(b.page)).toHaveAttribute("data-peer-markers", "1", { timeout: 15_000 });
  if (shots) await b.page.screenshot({ path: `${shots}/scene-8-peer.png` });
  // Off the model: gone.
  await a.page.mouse.move(0, 0);
  await expect(hostView(b.page)).toHaveAttribute("data-peer-markers", "0");
});

const GRID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="1" y="1" width="198" height="98" fill="#eef6ff" stroke="#204080" stroke-width="2"/>
  <path d="M20 0V100M40 0V100M60 0V100M80 0V100M100 0V100M120 0V100M140 0V100M160 0V100M180 0V100M0 20H200M0 40H200M0 60H200M0 80H200" stroke="#80a0d0" stroke-width="0.5"/>
  <circle cx="40" cy="50" r="6" fill="#d04020"/>
</svg>`;
type DrawnCanvas = { id: string; highlight: string | undefined };
const drawnCanvases = (page: Page) => hostView(page).evaluate((el) => (el as unknown as { cadViewer: { canvases(): DrawnCanvas[] } }).cadViewer.canvases());
const canvasPoint = (page: Page, id: string, u: number, v: number) =>
  hostView(page).evaluate((el, [id, u, v]) => (el as unknown as { cadViewer: { canvasPoint(id: string, u: number, v: number): { x: number; y: number } | undefined } }).cadViewer.canvasPoint(id as string, u as number, v as number), [id, u, v] as const);

test("an image inserted as a canvas is drawn in the scene, and Calibrate picks its points there", async ({ page }) => {
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, {
    "grid.svg": { file: "grid.svg", mimeType: "image/svg+xml", text: GRID_SVG },
    "squares.svg": { file: "squares.svg", mimeType: "image/svg+xml", text: SQUARES },
  });
  const { model } = await modelInScene(page, plateWith(docs["squares.svg"]!), "Plate", { sidebar: true });
  await openSelected(page);
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "unused", { timeout: 60_000 });
  await clickHome(page);

  // Dropped off the model, it waits; Canvas puts it on XY.
  const free = (await hostView(page).boundingBox())!;
  await drag(page, "grid.svg", { x: free.x + free.width - 40, y: free.y + 40 }, false);
  await expect(status(page)).toContainText("Insert grid.svg");
  await page.mouse.up();
  await page.locator(".cad-editor__dialog").getByRole("radiogroup", { name: "Use as" }).getByRole("radio").getByText("Canvas", { exact: true }).click();
  const stored = () =>
    page.evaluate(async (url) => {
      const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): { cad?: { canvases?: { id: string }[] } } }> } }).repo;
      return JSON.parse(JSON.stringify((await repo.find(url)).doc().cad?.canvases ?? [])) as { id: string }[];
    }, model);
  await expect.poll(() => stored().then((l) => l.length)).toBe(1);
  const id = (await stored())[0]!.id;
  // Drawn, outlined while selected.
  await expect.poll(() => drawnCanvases(page), { timeout: 30_000 }).toEqual([expect.objectContaining({ id, highlight: "accent" })]);
  if (shots) await page.screenshot({ path: `${shots}/scene-9-canvas.png` });

  // Calibrate: two points of the image, picked in the scene's view, beside the dialog.
  await hideSidebars(page);
  await clickHome(page);
  await page.locator(".cad-editor__dialog").getByRole("button", { name: "Calibrate", exact: true }).click();
  await expect(status(page)).toContainText("click the first of two points");
  await expect(hostView(page)).toHaveAttribute("data-canvas-pick", "true");
  const reachable: { x: number; y: number }[] = [];
  // Inside the image: a point on its edge may round to a pixel just outside it.
  for (let i = 1; i < 20; i++) {
    const p = await canvasPoint(page, id, i / 20, 0.25);
    if (p && (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) instanceof HTMLCanvasElement, p))) reachable.push(p);
  }
  expect(reachable.length).toBeGreaterThanOrEqual(2);
  for (const p of [reachable[0]!, reachable.at(-1)!]) await page.mouse.click(p.x, p.y);
  await expect(status(page)).toContainText("type the distance");
});

const TALL = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export const defaultParams = { h: 8 };
export default function main({ h }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [40, 20] }) });
  return { block: extrude({ sketch: sketch1, distance: h }) };
}
`;

test("a placed model is built with a configuration chosen in the scene's inspector", async ({ page }) => {
  await bootToFrame(page);
  const { model, scene } = await modelInScene(page, TALL, "Block");
  // The model's height, in metres up the scene: 8 mm by default.
  await expect.poll(async () => (await builtBounds(page, scene))?.max[1], { timeout: 30_000 }).toBeCloseTo(0.008, 5);

  // A configuration of the model's own: 30 mm.
  await page.evaluate(async (url) => {
    const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(fn: (d: { cad?: { configurations?: unknown[] } }) => void): void }> } }).repo;
    (await repo.find(url)).change((d) => {
      d.cad ??= {};
      d.cad.configurations = [{ id: "tall", name: "Tall", params: { h: 30 } }];
    });
  }, model);
  // The inspector's Settings; a select's accessible name has its option's text, so it is found by its key.
  const choice = page.locator('.scene-tool .build-params label[data-key="configuration"] select');
  await expect(choice.locator("option")).toHaveText(["Defaults", "Tall"]);
  await choice.selectOption({ label: "Tall" });
  await expect.poll(async () => (await builtBounds(page, scene))?.max[1], { timeout: 30_000 }).toBeCloseTo(0.03, 5);
  // The model's document is as it was: the choice is the placed model's.
  expect(await sourceOf(page, model)).toBe(TALL);
});

test("a placed model's image canvases are pictures in the scene's GLB: on XY and on a face, each on a layer of its own", async ({ page }) => {
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, {
    "grid.svg": { file: "grid.svg", mimeType: "image/svg+xml", text: GRID_SVG },
    "photo.png": { file: "photo.png", mimeType: "image/png", bytes: await pngBytes(page, 160, 120) },
  });
  const { model, scene } = await modelInScene(page, TALL, "Block", { sidebar: true });
  // The drawing on XY, as the editor stores one.
  await page.evaluate(
    async ([url, image]) => {
      const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(fn: (d: { cad?: { canvases?: unknown[] } }) => void): void }> } }).repo;
      (await repo.find(url!)).change((d) => {
        d.cad ??= {};
        d.cad.canvases = [{ id: "grid", name: "grid", image, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, at: [100, 50], position: [20, 10], scale: 0.2, angle: 0, opacity: 0.5, through: false }];
      });
    },
    [model, docs["grid.svg"]!],
  );

  // The photo dropped on the block's top face in the scene's editor, as a canvas.
  await openSelected(page);
  await expect.poll(async () => Number(await hostView(page).getAttribute("data-vertices"))).toBeGreaterThan(0);
  await clickHome(page);
  let top: { x: number; y: number } | undefined;
  for (const face of await entities(page, "face")) {
    const c = await hostView(page).evaluate((el, e) => (el as unknown as { cadViewer: { centroid(e: unknown): number[] | undefined } }).cadViewer.centroid(e), face);
    if (c && Math.abs(c[2]! - 8) < 1e-6) top = await hostView(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: unknown): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
  }
  await drag(page, "photo.png", top!, false);
  await expect(status(page)).toContainText("Insert photo.png to the face");
  await page.mouse.up();
  await page.locator(".cad-editor__dialog").getByRole("radiogroup", { name: "Use as" }).getByText("Canvas", { exact: true }).click();
  await expect.poll(() => sourceOf(page, model).then(() => page.evaluate(async (url) => ((await (window as unknown as { repo: { find(u: string): Promise<{ doc(): { cad?: { canvases?: unknown[] } } }> } }).repo.find(url)).doc().cad?.canvases ?? []).length, model))).toBe(2);
  // Closed with the inspector's Close: the scene shows its build again.
  await page.locator('.scene-tool button[data-command="cad-edit"]').click();
  await expect(sceneEditor(page)).toHaveCount(0);

  // Built again: a picture per canvas, on its own layer, the drawing marked as one.
  await expect.poll(async () => (await builtGlb(page, scene))?.images.length ?? 0, { timeout: 60_000 }).toBe(2);
  const glb = (await builtGlb(page, scene))!;
  expect(glb.layers.map((l) => l.name)).toEqual(["block", "grid", "photo"]);
  expect(glb.images.map((i) => i.mimeType)).toEqual(["image/png", "image/png"]);
  const picture = (name: string) => glb.meshes.find((m) => m.name === name)!.primitives[0]!;
  expect(glb.materials[picture("grid").material]!.extras).toEqual({ colorScheme: "light" });
  expect(glb.materials[picture("photo").material]!.extras).toBeUndefined();
  // On the top face, 8 mm up and 0.01 mm above it (modelGlb's CANVAS_LIFT): in metres, Y up.
  const y = glb.accessors[picture("photo").attributes.POSITION]!;
  expect(y.min![1]).toBeCloseTo(0.00801, 7);
  expect(y.max![1]).toBeCloseTo(0.00801, 7);
  if (shots) await page.screenshot({ path: `${shots}/scene-10-canvases-built.png` });
});

