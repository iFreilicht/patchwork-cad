/**
 * Per-user UI state in the account's tool storage (research/10-view-state.md): the editor reopens
 * the code pane of a model it was open for, and each tool shows a model with the camera it last
 * had, after a tool switch and after a reload.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cameraDirection, clickViewCube, createModel, docUrl, editorView, openCode, openWithTool, type Region, reloadStored } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

test("the editor remembers per model whether the code pane was open", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const code = page.locator(".cad-model__code");
  await expect(code).toHaveCount(0);
  await openCode(page);
  const first = page.url();

  await openWithTool(page, "cad-model-viewer");
  await expect(page.locator(".cad-model--viewer")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await openWithTool(page, "cad-model");
  await expect(code).toHaveCount(1);

  await reloadStored(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(1);

  // Another model starts closed, and closing it there leaves the first one open.
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(0);
  await page.goto(first);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(1);
});

async function expectDirection(page: Page, region: Region): Promise<void> {
  const length = Math.hypot(...region);
  await expect.poll(() => cameraDirection(page)).toEqual(region.map((c) => expect.closeTo(c / length, 2)));
}

test("each tool remembers its camera per model", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  const editor = editorView(page);
  const viewer = page.locator(".cad-model--viewer");
  await expect(editor).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await clickViewCube(page, [1, -1, 1]);
  await page.locator(".cad-model__viewer").getByRole("button", { name: "Orthographic" }).click();

  await openWithTool(page, "cad-model-viewer");
  await expect(viewer).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(viewer.locator(".cad-model__viewer")).toHaveAttribute("data-projection", "perspective");
  await clickViewCube(page, [0, -1, 0]);

  await openWithTool(page, "cad-model");
  await expect(editor).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expectDirection(page, [1, -1, 1]);
  await expect(editor.locator(".cad-model__viewer")).toHaveAttribute("data-projection", "orthographic");

  await reloadStored(page);
  await expect(editor).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(page, [1, -1, 1]);
  await expect(editor.locator(".cad-model__viewer")).toHaveAttribute("data-projection", "orthographic");

  await openWithTool(page, "cad-model-viewer");
  await expect(viewer).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expectDirection(page, [0, -1, 0]);
});

test("two viewers of one model don't move each other", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page, "cad-model-viewer");
  await expect(page.locator(".cad-model--viewer")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const first = page.locator(".cad-model__viewer").first();
  const home = await cameraDirection(page);

  await page.evaluate((url) => {
    const view = document.createElement("patchwork-view");
    view.setAttribute("doc-url", url);
    view.setAttribute("tool-id", "cad-model-viewer");
    view.id = "second";
    view.style.cssText = "position: absolute; left: 0; bottom: 0; width: 400px; height: 300px; z-index: 10; display: block";
    // Inside the tool, where Patchwork's providers answer.
    document.querySelector(".cad-model--viewer")!.append(view);
  }, docUrl(page));
  const second = page.locator("#second .cad-model__viewer");
  await expect(page.locator("#second .cad-model--viewer")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  // A turn in the second viewer is stored, but the first keeps its camera.
  const point = await second.evaluate((el) => (el as unknown as { cadViewer: { viewCubePoint(r: Region): { x: number; y: number } } }).cadViewer.viewCubePoint([0, -1, 0]));
  await page.mouse.click(point.x, point.y);
  await expect(second).toHaveAttribute("data-turning", "false");
  await page.waitForTimeout(500);
  expect(await first.evaluate((el) => (el as unknown as { cadViewer: { cameraDirection(): number[] } }).cadViewer.cameraDirection())).toEqual(home.map((c) => expect.closeTo(c, 6)));

  // The next mount shows the camera that moved last.
  await reloadStored(page);
  await expect(page.locator(".cad-model--viewer").first()).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(page, [0, -1, 0]);
});
