/**
 * View documents (research/10-view-state.md): dragging a ViewCube region into another document
 * creates a `cad-model-view` of the model; the viewer shows it with its camera, orbiting is local
 * until "Save view", and a saved view reaches other users.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cameraDirection, clickViewCube, createModel, docPathWith, docUrl, editorView, type Region, reloadStored } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

async function expectDirection(page: Page, region: Region): Promise<void> {
  const length = Math.hypot(...region);
  await expect.poll(() => cameraDirection(page)).toEqual(region.map((c) => expect.closeTo(c / length, 2)));
}

/** Drags a ViewCube region with the mouse onto `target`. */
async function dragViewCube(page: Page, region: Region, target: { x: number; y: number }): Promise<void> {
  const point = await page.locator(".cad-model__viewer").first().evaluate((el, r) => (el as unknown as { cadViewer: { viewCubePoint(r: Region): { x: number; y: number } | undefined } }).cadViewer.viewCubePoint(r), region);
  if (!point) throw new Error(`ViewCube region ${region.join(",")} isn't visible`);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 20, point.y + 20, { steps: 5 });
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
}

test("a ViewCube region dragged into the sidebar is a view of the model", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const model = docUrl(page);

  // Into the sidebar's document list, below its last entry.
  const sidebar = page.locator(".threepane-sidebar").first();
  const box = await sidebar.locator(".document-list__doclist").boundingBox();
  if (!box) throw new Error("no document list in the sidebar");
  await dragViewCube(page, [0, -1, 0], { x: box.x + box.width / 2, y: box.y + box.height - 4 });
  const entry = sidebar.getByText("CAD Model – Front", { exact: true });
  await expect(entry).toHaveCount(1);

  // It opens in the viewer, looking from the front.
  await entry.click();
  const view = page.locator(".cad-model--view-doc");
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(docUrl(page)).not.toBe(model);
  await expectDirection(page, [0, -1, 0]);
  const save = view.getByRole("button", { name: "Save view" });
  await expect(save).toHaveCount(0);

  // Orbiting is local: a reload snaps back.
  await clickViewCube(page, [1, -1, 1]);
  await expect(save).toHaveCount(1);
  await reloadStored(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(page, [0, -1, 0]);

  // A saved view stays, for everyone.
  await clickViewCube(page, [1, -1, 1]);
  await save.click();
  await expect(save).toHaveCount(0);
  await reloadStored(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(page, [1, -1, 1]);
  await bootToFrame(b.page, docPathWith(page));
  await expect(b.page.locator(".cad-model--view-doc")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(b.page, [1, -1, 1]);

  // "Open model" opens the model it shows.
  await view.getByRole("button", { name: "Open model" }).click();
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(docUrl(page)).toBe(model);
});
