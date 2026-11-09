/**
 * Parameters (research/17-parameters.md): the parameters entry edits defaultParams, main's pattern
 * and the derived constants as code; a user tries values only for themselves, applies them, keeps
 * them as a configuration of the model, or links one to another document's number; a feature's
 * number becomes a parameter; and an embed shows the model with a configuration.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, docUrl, editorView, modelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const params = (page: Page) => page.locator('section[aria-label="Parameters"]');
const row = (page: Page, key: string) => params(page).locator(`tr[data-param="${key}"]`);
const configurationRow = (page: Page, name: string) => page.locator(".cad-editor__browser").getByRole("list", { name: "Configurations" }).locator(`.cad-editor__named-row[data-name="${name}"]`);
const status = (page: Page) => page.locator(".cad-model__status").first();

/** The largest x of the shown faces' centroids: how wide the plate is built. */
async function extentX(page: Page): Promise<number> {
  return page
    .locator(".cad-model__viewer")
    .first()
    .evaluate((el) => {
      const hook = (el as unknown as { cadViewer: { entities(k: "face"): unknown[]; centroid(e: unknown): number[] | undefined } }).cadViewer;
      return Math.max(...hook.entities("face").map((e) => hook.centroid(e)?.[0] ?? -Infinity));
    });
}

async function openParams(page: Page): Promise<void> {
  await page.locator(".cad-editor__params-entry").click();
  await expect(params(page)).toBeVisible();
}

/** Renames what the focused name field is for. */
async function rename(page: Page, to: string): Promise<void> {
  const field = page.locator(".cad-editor__rename");
  await expect(field).toBeFocused();
  await field.fill(to);
  await field.press("Enter");
  await expect(field).toHaveCount(0);
}

test("the parameters entry edits parameters and derived ones in the code", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await openParams(page);
  await expect(params(page).locator("tr[data-param]")).toHaveCount(4);
  // Units follow from where a parameter goes: all of these are lengths.
  for (const key of ["width", "depth", "height", "hole"]) await expect(row(page, key).locator("td").nth(3)).toHaveText("mm");

  // Typed key by key, the field keeps the focus while each key rewrites the code.
  const height = params(page).getByRole("textbox", { name: "Default of height" });
  await height.fill("");
  await height.pressSequentially("205");
  await expect(height).toBeFocused();
  await expect.poll(() => modelSource(page)).toContain("height: 205");
  await height.fill("20");
  await expect.poll(() => modelSource(page)).toContain("height: 20,");

  await row(page, "width").locator(".cad-editor__param-name").dblclick();
  await rename(page, "w");
  const renamed = await modelSource(page);
  expect(renamed).toContain("export const defaultParams = { w: 60,");
  expect(renamed).toContain("main({ w, depth, height, hole })");
  expect(renamed).toContain("to: [w, depth]");
  await expect(row(page, "w").getByRole("button", { name: "Remove w" })).toBeDisabled();

  await params(page).getByRole("button", { name: "Add parameter" }).click();
  await rename(page, "gap");
  await expect.poll(() => modelSource(page)).toContain("hole: 8, gap: 10 }");
  expect(await modelSource(page)).toContain("main({ w, depth, height, hole, gap })");
  await row(page, "gap").getByRole("button", { name: "Remove gap" }).click();
  await expect.poll(() => modelSource(page)).not.toContain("gap");

  // A derived parameter is a const at the start of main, and no timeline entry.
  await params(page).getByRole("button", { name: "Add derived" }).click();
  await rename(page, "half");
  await params(page).getByRole("textbox", { name: "Expression of half" }).fill("w / 2");
  await expect.poll(() => modelSource(page)).toContain("main({ w, depth, height, hole }) {\n  const half = w / 2;\n  const sketch1");
  await expect(page.locator(".cad-editor__entry").first()).toHaveAttribute("data-name", "sketch1");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
});

test("values are tried, applied, kept as configurations and embedded", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const model = docUrl(page);
  const narrow = await extentX(page);
  expect(narrow).toBeLessThanOrEqual(60);
  await openParams(page);

  // A value tried is only shown, only for this user.
  const width = params(page).getByRole("textbox", { name: "Value of width" });
  await width.fill("100");
  await width.press("Enter");
  await expect.poll(() => extentX(page)).toBeGreaterThan(90);
  await expect(status(page)).toContainText("Shown with 1 value you try");
  expect(await modelSource(page)).toContain("width: 60");
  await bootToFrame(b.page, `/#doc=${encodeURIComponent(model)}`);
  await expect(editorView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  expect(await extentX(b.page)).toBeLessThanOrEqual(60);

  // Kept as a configuration of the model, which the other user can show, too.
  await params(page).getByRole("button", { name: "Save as configuration" }).click();
  await expect(configurationRow(page, "Configuration")).toHaveAttribute("data-current", "true");
  await expect(status(page)).toContainText("Shown with Configuration");
  await configurationRow(page, "Configuration").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Rename" }).click();
  await rename(page, "Wide");
  // Enter, which renames, doesn't also click the name that gets the focus back.
  await expect(configurationRow(page, "Wide")).toHaveAttribute("data-current", "true");
  await configurationRow(b.page, "Wide").getByRole("button", { name: "Wide" }).click();
  await expect.poll(() => extentX(b.page)).toBeGreaterThan(90);
  await configurationRow(page, "Wide").getByRole("button", { name: "Wide" }).click();
  await expect(configurationRow(page, "Wide")).not.toHaveAttribute("data-current", "true");
  await expect.poll(() => extentX(page)).toBeLessThanOrEqual(60);

  // Tried values are applied to the code's defaults.
  const height = params(page).getByRole("textbox", { name: "Value of height" });
  await height.fill("5");
  await height.press("Enter");
  await params(page).getByRole("button", { name: "Apply to defaults" }).click();
  await expect.poll(() => modelSource(page)).toContain("height: 5");
  await expect(status(page)).not.toContainText("Shown with");

  // A feature's number becomes a parameter.
  await params(page).getByRole("button", { name: "close" }).click();
  await timelineEntry(page, "fillet1").click();
  await dialog(page).locator('[data-param="radius"]').getByRole("button", { name: "Make a parameter of this value" }).click();
  await expect.poll(() => modelSource(page)).toContain("hole: 8, radius: 1.5 }");
  expect(await modelSource(page)).toContain("radius: radius });");

  // Dragged out, the configuration is an embed that shows the model with it.
  const sidebar = page.locator(".threepane-sidebar").first();
  const list = await sidebar.locator(".document-list__doclist").boundingBox();
  const grip = await configurationRow(page, "Wide").locator(".cad-editor__grip").boundingBox();
  if (!list || !grip) throw new Error("no document list or grip");
  const target = { x: list.x + list.width / 2, y: list.y + list.height - 4 };
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 30, grip.y + 10, { steps: 5 });
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.move(target.x + 1, target.y, { steps: 2 });
  await page.mouse.move(target.x, target.y, { steps: 2 });
  await page.mouse.up();
  await sidebar.getByText("CAD Model – Wide", { exact: true }).click();
  const embed = page.locator(".cad-model--embed");
  await expect(embed).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(embed).toHaveAttribute("data-configuration", "Wide");
  await expect.poll(() => extentX(page)).toBeGreaterThan(90);
  await embed.getByRole("combobox", { name: "Configuration" }).selectOption({ label: "Defaults" });
  await expect.poll(() => extentX(page)).toBeLessThanOrEqual(60);
});

test("a value linked to another document's number follows it", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const sheet = await page.evaluate(() => {
    const repo = (window as unknown as { repo: { create(doc: unknown): { url: string } } }).repo;
    return repo.create({ rows: [{ width: 90 }] }).url;
  });
  const setWidth = (value: number | undefined) =>
    page.evaluate(
      async ([url, v]) => {
        const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(f: (d: { rows: { width?: number }[] }) => void): void }> } }).repo;
        (await repo.find(url as string)).change((d) => {
          if (v === null) delete d.rows[0]!.width;
          else d.rows[0]!.width = v as number;
        });
      },
      [sheet, value ?? null] as const,
    );
  await openParams(page);
  const width = params(page).getByRole("textbox", { name: "Value of width" });
  await width.fill(`${sheet}/rows/@0/width`);
  await width.press("Enter");
  await expect.poll(() => extentX(page)).toBeGreaterThan(80);
  await setWidth(130);
  await expect.poll(() => extentX(page)).toBeGreaterThan(120);
  // Kept in a configuration, the link stays a link.
  await params(page).getByRole("button", { name: "Save as configuration" }).click();
  await expect(configurationRow(page, "Configuration")).toHaveAttribute("data-current", "true");
  await setWidth(undefined);
  await expect(status(page)).toContainText("width: its linked value isn't there any more");
  await expect(width).toHaveAttribute("aria-invalid", "true");
});
