/**
 * A CAD model in a scene (research/23-scene-editing.md): dropped into a scene from the sidebar, it is
 * built there, and its Open lays the editor over the scene, which draws the live build and hovers it
 * through the scene's input; Escape leaves.
 */
import { entities, exampleSource } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { modelInScene, openSelected, SCENE_MODULES, sceneEditor } from "../scene.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: SCENE_MODULES });

const hostView = (page: import("@playwright/test").Page) => page.locator(".cad-model__viewer--host");

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
