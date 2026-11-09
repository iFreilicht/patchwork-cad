/**
 * Named views (research/18-named-views.md): the browser's Views section adds a view from the
 * current camera, goes to one with a click, renames, updates and deletes it from its context menu,
 * and every collaborator sees them. Dragging a view out embeds the model seen from it: the viewer
 * shows the embed from the view, orbiting is local until "Reset", a picker switches the view, and
 * the embed follows the view as it is updated or deleted in the model.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, cameraDirection, clickViewCube, createModel, docPathWith, docUrl, editorView, reloadStored, type Region } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

async function expectDirection(page: Page, region: Region | [number, number, number]): Promise<void> {
  const length = Math.hypot(...region);
  await expect.poll(() => cameraDirection(page)).toEqual(region.map((c) => expect.closeTo(c / length, 2)));
}

const views = (page: Page) => page.locator(".cad-editor__browser").getByRole("list", { name: "Views" });
const viewRow = (page: Page, name: string) => views(page).locator(`.cad-editor__named-row[data-name="${name}"]`);
const viewNames = (page: Page) => views(page).locator(".cad-editor__named-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name")));

/** Adds a view from the current camera and names it `name`. */
async function addView(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  const field = views(page).locator(".cad-editor__rename");
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press("Enter");
  await expect(viewRow(page, name)).toHaveCount(1);
}

async function viewMenu(page: Page, name: string, item: string): Promise<void> {
  await viewRow(page, name).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

/** Drags a view's grip with the mouse onto `target`. */
async function dragView(page: Page, name: string, target: { x: number; y: number }): Promise<void> {
  const grip = await viewRow(page, name).locator(".cad-editor__grip").boundingBox();
  if (!grip) throw new Error(`no grip on view ${name}`);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 30, grip.y + 10, { steps: 5 });
  await page.mouse.move(target.x, target.y, { steps: 10 });
  // WebKit drops only where a dragover accepted the drag, which a move ending on a new element hasn't yet sent.
  await page.mouse.move(target.x + 1, target.y, { steps: 2 });
  await page.mouse.move(target.x, target.y, { steps: 2 });
  await page.mouse.up();
}

/** Where the sidebar's document list takes a drop: at its bottom, below its last entry. */
async function documentListDrop(page: Page): Promise<{ sidebar: Locator; at: { x: number; y: number } }> {
  const sidebar = page.locator(".threepane-sidebar").first();
  const box = await sidebar.locator(".document-list__doclist").boundingBox();
  if (!box) throw new Error("no document list in the sidebar");
  return { sidebar, at: { x: box.x + box.width / 2, y: box.y + box.height - 4 } };
}

test("named views are added, gone to, renamed, updated and deleted, for everyone", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const home = await cameraDirection(page);
  await expect(views(page).getByText("none")).toHaveCount(1);

  // A new view is named after the ViewCube region it looks from, and is where the camera is.
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  await expect(views(page).getByRole("textbox", { name: "New name for Front Right Top" })).toBeFocused();
  await views(page).locator(".cad-editor__rename").fill("Hero");
  await views(page).locator(".cad-editor__rename").press("Enter");
  await expect(viewRow(page, "Hero")).toHaveAttribute("data-current", "true");

  // Another one, keeping its name; names are unique.
  await clickViewCube(page, [0, -1, 0]);
  await expect(viewRow(page, "Hero")).not.toHaveAttribute("data-current", "true");
  await addView(page, "Front");
  await viewRow(page, "Front").locator(".cad-editor__browser-name").press("F2");
  await views(page).locator(".cad-editor__rename").fill("Hero");
  await views(page).locator(".cad-editor__rename").press("Enter");
  await expect(page.locator(".cad-model__status")).toContainText("There already is a view called Hero");
  await views(page).locator(".cad-editor__rename").press("Escape");
  expect(await viewNames(page)).toEqual(["Hero", "Front"]);

  // A click goes to a view.
  await viewRow(page, "Hero").getByRole("button", { name: "Hero" }).click();
  await expectDirection(page, home);
  await expect(viewRow(page, "Hero")).toHaveAttribute("data-current", "true");
  await expect(viewRow(page, "Front")).not.toHaveAttribute("data-current", "true");

  // The context menu updates a view to the current camera, renames and deletes it.
  await clickViewCube(page, [1, 0, 0]);
  await viewRow(page, "Hero").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Rename", "Update to current view", "Delete"]);
  await page.getByRole("menu").getByRole("menuitem", { name: "Update to current view" }).click();
  await expect(viewRow(page, "Hero")).toHaveAttribute("data-current", "true");
  await clickViewCube(page, [1, -1, 1]);
  await viewRow(page, "Hero").getByRole("button", { name: "Hero" }).click();
  await expectDirection(page, [1, 0, 0]);
  await viewMenu(page, "Hero", "Rename");
  await views(page).locator(".cad-editor__rename").fill("Right");
  await views(page).locator(".cad-editor__rename").press("Enter");
  await viewMenu(page, "Front", "Delete");
  await expect.poll(() => viewNames(page)).toEqual(["Right"]);

  // Undo brings the deleted view back.
  await viewRow(page, "Right").getByRole("button", { name: "Right" }).focus();
  await pressMod(page, "z");
  await expect.poll(() => viewNames(page)).toEqual(["Right", "Front"]);

  // They are the model's: they stay, and a collaborator sees them and goes to them.
  await reloadStored(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => viewNames(page)).toEqual(["Right", "Front"]);
  await bootToFrame(b.page, docPathWith(page));
  await expect(editorView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => viewNames(b.page)).toEqual(["Right", "Front"]);
  await viewRow(b.page, "Front").getByRole("button", { name: "Front" }).click();
  await expectDirection(b.page, [0, -1, 0]);
});

test("a view dragged into the sidebar embeds the model seen from it, and follows the view", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const model = docUrl(page);
  await clickViewCube(page, [0, -1, 0]);
  await addView(page, "Hero");
  await clickViewCube(page, [1, -1, 1]);
  await addView(page, "Corner");

  const { sidebar, at } = await documentListDrop(page);
  await dragView(page, "Hero", at);
  const entry = sidebar.getByText("CAD Model – Hero", { exact: true });
  await expect(entry).toHaveCount(1);

  // It opens in the viewer, looking from the view.
  await entry.click();
  const embed = page.locator(".cad-model--embed");
  await expect(embed).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(docUrl(page)).not.toBe(model);
  await expect(embed).toHaveAttribute("data-view", "Hero");
  await expectDirection(page, [0, -1, 0]);
  const reset = embed.getByRole("button", { name: "Reset" });
  await expect(reset).toHaveCount(0);

  // Orbiting is local: a reload, or Reset, returns to the view.
  await clickViewCube(page, [1, -1, 1]);
  await expect(reset).toHaveCount(1);
  await reloadStored(page);
  await expect(embed).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expectDirection(page, [0, -1, 0]);
  await clickViewCube(page, [1, -1, 1]);
  await reset.click();
  await expectDirection(page, [0, -1, 0]);
  await expect(reset).toHaveCount(0);

  // The picker switches the embed's view, for good.
  const picker = embed.getByRole("combobox", { name: "View" });
  await picker.selectOption({ label: "Corner" });
  await expect(embed).toHaveAttribute("data-view", "Corner");
  await expectDirection(page, [1, -1, 1]);
  await reloadStored(page);
  await expect(embed).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(embed).toHaveAttribute("data-view", "Corner");

  // A collaborator updates the view in the model: the embed follows.
  await bootToFrame(b.page, `/#doc=${encodeURIComponent(model)}`);
  await expect(editorView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await clickViewCube(b.page, [-1, -1, 1]);
  await viewMenu(b.page, "Corner", "Update to current view");
  await expectDirection(page, [-1, -1, 1]);

  // They delete it: the embed says so, and offers the model's other views.
  await viewMenu(b.page, "Corner", "Delete");
  await expect(embed).toHaveAttribute("data-deleted", "true");
  await expect(picker.locator("option")).toHaveText(["Deleted view", "Hero"]);
  await picker.selectOption({ label: "Hero" });
  await expect(embed).toHaveAttribute("data-deleted", "false");
  await expectDirection(page, [0, -1, 0]);

  // "Open model" opens the model it shows.
  await embed.getByRole("button", { name: "Open model" }).click();
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(docUrl(page)).toBe(model);
});
