/** A CAD model in pvh's scene tool (research/23-scene-editing.md). */
import { expect, type Page } from "@playwright/test";
import { CAD_MODULES, createModel, docUrl, hideSidebars, setModelSource } from "./cad.ts";
import { drag } from "./documents.ts";
import { SCENE_DIR } from "./scene-dir.ts";
import { createViaMenu } from "./ui.ts";

export { SCENE_DIR };
export const SCENE_MODULES = { ...CAD_MODULES, scene: SCENE_DIR };

export const scenePort = (page: Page) => page.locator(".scene-tool canvas").first();

type SceneObject = { name?: string; sourceUrl?: string; providerId?: string; renderUrl?: string };

/** The scene's objects, read from the tab's repo. */
export async function sceneObjects(page: Page, scene: string): Promise<SceneObject[]> {
  return page.evaluate(async (url) => {
    const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): { objects?: Record<string, SceneObject> } }> } }).repo;
    return Object.values((await repo.find(url)).doc().objects ?? {});
  }, scene);
}

/** Creates a model of `source` titled `title`, then a scene, and drops the model into the scene from the sidebar; returns both URLs. */
export async function modelInScene(page: Page, source: string, title: string): Promise<{ model: string; scene: string }> {
  await createModel(page);
  await setModelSource(page, source);
  const model = docUrl(page);
  await page.evaluate(
    async ([url, t]) => {
      const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(fn: (d: { title: string }) => void): void }> } }).repo;
      (await repo.find(url!)).change((d) => (d.title = t!));
    },
    [model, title],
  );
  await createViaMenu(page, "Scene");
  const scene = docUrl(page);
  await scenePort(page).waitFor({ timeout: 60_000 });
  await drag(page, title, scenePort(page));
  await expect.poll(() => sceneObjects(page, scene), { timeout: 30_000 }).toEqual([expect.objectContaining({ sourceUrl: model, providerId: "cad-model-scene" })]);
  await hideSidebars(page);
  // Built: the object's render doc has a GLB.
  await expect.poll(() => built(page, scene), { timeout: 60_000 }).toBe(true);
  return { model, scene };
}

/** Whether every object of the scene has a built GLB. */
async function built(page: Page, scene: string): Promise<boolean> {
  return page.evaluate(async (url) => {
    const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): Record<string, unknown> }> } }).repo;
    const objects = Object.values(((await repo.find(url)).doc()["objects"] ?? {}) as Record<string, SceneObject>);
    const renders = await Promise.all(objects.map(async (o) => (o.renderUrl ? (await repo.find(o.renderUrl)).doc()["glbUrl"] : undefined)));
    return renders.length > 0 && renders.every(Boolean);
  }, scene);
}

/** The editor laid over the scene by a model's Open. */
export const sceneEditor = (page: Page) => page.locator(".cad-scene-editor .cad-model--editor");

/** Opens the selected object with the inspector's Open. */
export async function openSelected(page: Page): Promise<void> {
  await page.locator('.scene-tool button[data-command="cad-edit"]').click();
  await expect(sceneEditor(page)).toBeVisible({ timeout: 30_000 });
}
