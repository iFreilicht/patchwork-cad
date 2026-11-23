/**
 * A CAD model in a scene (research/23-scene-editing.md): dropped into a scene from the sidebar, it is
 * built there, and its Open lays the editor over the scene, which draws the live build and hovers it
 * through the scene's input; Escape leaves.
 */
import type { Page } from "@playwright/test";
import { entities, exampleSource, type Entity, type EntityKind } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { entityKey, highlightedInScene, hostView, hoverInScene, modelInScene, openSelected, SCENE_MODULES, sceneEditor } from "../scene.ts";
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
