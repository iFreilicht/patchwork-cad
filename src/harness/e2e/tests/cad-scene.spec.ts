/**
 * A CAD model in a scene (research/23-scene-editing.md): dropped into a scene from the sidebar, it is
 * built there, and its Open lays the editor over the scene, which draws the live build and hovers it
 * through the scene's input; Escape leaves. The editor's views move the scene's camera and are made from it.
 */
import type { Page } from "@playwright/test";
import { cameraDirection, clickHome, clickViewCube, entities, exampleSource, timelineEntry, toolbarButton, type Entity, type EntityKind, type Region } from "../cad.ts";
import { sidebarDocuments } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { entityKey, highlightedInScene, hostView, hoverInScene, modelInScene, openSelected, SCENE_MODULES, sceneEditor, sourceOf } from "../scene.ts";
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

  // Close to a face: the model is cut off, and the faces in the view are its subject.
  const face = (await entities(page, "face"))[0]!;
  const at = await hostView(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: unknown): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
  await page.mouse.move(at!.x, at!.y);
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
