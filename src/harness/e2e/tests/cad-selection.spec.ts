/**
 * One selection for the browser, the timeline, the code pane and the dialogs (research/19-selection.md):
 * a click on an item selects it and opens its dialog, every other pane scrolls to what stands for it,
 * the selection follows the code pane's cursor, and the dialog closes by its ×, Escape, a click on
 * the item or a click elsewhere. Collaborators see each other's selection.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, docPathWith, editorView, entities, exampleSource, hideSidebars, modelSource, openCode, setModelSource, timelineEntry, toolbarButton, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const browser = (page: Page) => page.getByRole("complementary", { name: "Browser" });
const BODY_ROW = ".cad-editor__browser-row:not(.cad-editor__named-row)";
const row = (page: Page, name: string) => browser(page).locator(`${BODY_ROW}[data-name="${name}"]`);
const namedRow = (page: Page, name: string) => browser(page).locator(`.cad-editor__named-row[data-name="${name}"]`);
const rowName = (row: Locator) => row.locator(".cad-editor__browser-name");
const code = (page: Page) => page.locator(".cad-model__code");
const line = (page: Page, text: string) => code(page).locator(".cm-line", { hasText: text });
/** Clicks a line of code at its start: the middle of a long line may be scrolled out of view. */
const clickLine = (page: Page, text: string) => line(page, text).click({ position: { x: 4, y: 4 } });
const paramsEntry = (page: Page) => page.locator(".cad-editor__params-entry");
const returnEntry = (page: Page) => page.locator(".cad-editor__return");
const canvas = (page: Page) => page.locator(".cad-model__viewer > canvas");
const selection = (page: Page) => editorView(page).getAttribute("data-selection");
const scroller = { browser: ".cad-editor__browser", timeline: ".cad-editor__timeline", code: ".cad-model__code .cm-scroller" };
/** Scrolls a pane to its start or its end. */
const scroll = (page: Page, pane: keyof typeof scroller, to: "start" | "end") =>
  page.locator(scroller[pane]).evaluate((el, end) => {
    el.scrollTop = end ? el.scrollHeight : 0;
    el.scrollLeft = end ? el.scrollWidth : 0;
  }, to === "end");
const scrollPosition = (page: Page, pane: keyof typeof scroller) => page.locator(scroller[pane]).evaluate((el) => [el.scrollLeft, el.scrollTop]);

/** M1, with a long comment before fillet1, so that the code pane scrolls. */
const PADDED = exampleSource("m1", [["  const fillet1", `${Array.from({ length: 50 }, (_, i) => `  // ${i + 1}`).join("\n")}\n  const fillet1`]]);

async function openM1(page: Page, source = exampleSource("m1")) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, source);
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
}

/** A point on the canvas without the model, for a click elsewhere in the view. */
async function emptyPoint(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  return { x: box.x + 12, y: box.y + box.height - 12 };
}

interface ViewerHook {
  cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; centroid(e: Entity): number[] | undefined };
}
/** Where the visible face or edge nearest `near` can be clicked. */
async function pointNear(page: Page, kind: Entity["kind"], near: [number, number, number]) {
  const viewer = page.locator(".cad-model__viewer").first();
  const scored = await Promise.all(
    (await entities(page, kind)).map(async (e) => {
      const hook = await viewer.evaluate((el, x) => ({ c: (el as unknown as ViewerHook).cadViewer.centroid(x), p: (el as unknown as ViewerHook).cadViewer.screenPoint(x) }), e);
      return { p: hook.p, d: hook.c ? Math.hypot(hook.c[0]! - near[0], hook.c[1]! - near[1], hook.c[2]! - near[2]) : Infinity };
    }),
  );
  const best = scored.filter((s) => s.p).sort((a, b) => a.d - b.d)[0];
  if (!best?.p) throw new Error(`no visible ${kind} near ${near.join(", ")}`);
  return best.p;
}

test("a selection in one pane scrolls the others to it, but not the pane it was made in", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await page.setViewportSize({ width: 600, height: 560 });
  await openM1(page, PADDED);
  await openCode(page);
  // Views enough that the browser scrolls; Escape in a new view's name field only ends renaming it.
  for (let i = 0; i < 14; i++) {
    await browser(page).getByRole("button", { name: "New view from the current camera" }).click();
    await expect(browser(page).locator(".cad-editor__rename")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(browser(page).locator(".cad-editor__rename")).toHaveCount(0);
  }
  await expect(dialog(page)).toHaveCount(0);
  for (const pane of ["browser", "timeline", "code"] as const) {
    const [overflows] = await page.locator(scroller[pane]).evaluate((el) => [el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth]);
    expect(overflows, `${pane} scrolls`).toBe(true);
  }

  // Timeline → browser and code; the code pane's cursor stays.
  await scroll(page, "browser", "end");
  await scroll(page, "code", "start");
  await expect(rowName(row(page, "block"))).not.toBeInViewport({ ratio: 0.95 });
  const active = await code(page).locator(".cm-activeLine").textContent();
  await timelineEntry(page, "extrude2").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  await expect(row(page, "block")).toHaveAttribute("data-selected", "true");
  await expect(rowName(row(page, "block"))).toBeInViewport({ ratio: 0.95 });
  await expect(line(page, "const extrude2")).toBeInViewport();
  await expect(code(page).locator(".cm-activeLine")).toHaveText(active ?? "");

  // Browser → timeline and code; the browser stays where it is.
  await scroll(page, "timeline", "end");
  await scroll(page, "code", "end");
  await expect(paramsEntry(page)).not.toBeInViewport({ ratio: 0.95 });
  await rowName(namedRow(page, "Defaults")).scrollIntoViewIfNeeded();
  const browserAt = await scrollPosition(page, "browser");
  await rowName(namedRow(page, "Defaults")).click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "parameters");
  await expect(paramsEntry(page)).toHaveAttribute("aria-pressed", "true");
  await expect(paramsEntry(page)).toBeInViewport({ ratio: 0.95 });
  await expect(line(page, "export const defaultParams")).toBeInViewport();
  expect(await scrollPosition(page, "browser")).toEqual(browserAt);

  // Code → timeline and browser.
  await scroll(page, "timeline", "start");
  await scroll(page, "browser", "end");
  await scroll(page, "code", "end");
  await expect(timelineEntry(page, "extrude2")).not.toBeInViewport({ ratio: 0.95 });
  await clickLine(page, "const extrude2");
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  await expect(timelineEntry(page, "extrude2")).toBeInViewport({ ratio: 0.95 });
  await expect(rowName(row(page, "block"))).toBeInViewport({ ratio: 0.95 });
  await expect(code(page).locator(".cm-content")).toBeFocused();

  // Opening the code pane scrolls to the selection's code.
  await toolbarButton(page, "Code").click();
  await timelineEntry(page, "sketch1").click();
  await toolbarButton(page, "Code").click();
  await expect(line(page, "const sketch1")).toBeInViewport();
});

test("the dialog closes by its ×, Escape, a click on its item or a click elsewhere, but not by a drag", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);

  // The ×.
  await timelineEntry(page, "fillet1").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await dialog(page).getByRole("button", { name: "close" }).click();
  await expect(dialog(page)).toHaveCount(0);

  // Escape, after a field has used it to restore its value; the field's text that isn't an expression never reaches the code.
  const source = await modelSource(page);
  await timelineEntry(page, "fillet1").click();
  const radius = dialog(page).getByLabel("Radius", { exact: true });
  await radius.fill("1.5 +");
  await radius.press("Escape");
  await expect(radius).toHaveValue("1.5");
  await expect(dialog(page)).toHaveCount(1);
  await radius.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await modelSource(page)).toBe(source);

  // A context menu closes on Escape alone, and on a click elsewhere alone.
  await timelineEntry(page, "fillet1").click();
  await timelineEntry(page, "fillet1").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await timelineEntry(page, "fillet1").click({ button: "right" });
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");

  // A drag in the view orbits and keeps the dialog; a click there closes it.
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 60, empty.y - 40, { steps: 6 });
  await page.mouse.up();
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await page.mouse.click(empty.x, empty.y);
  await expect(dialog(page)).toHaveCount(0);

  // A click on its item again: an entry, a body's row, the parameters and the return entry.
  for (const [item, feature] of [
    [timelineEntry(page, "notch"), "notch"],
    [rowName(row(page, "block")), "extrude2"],
    [paramsEntry(page), "parameters"],
    [returnEntry(page), "return"],
  ] as const) {
    await item.click();
    await expect(dialog(page)).toHaveAttribute("data-feature", feature);
    await item.click();
    await expect(dialog(page)).toHaveCount(0);
  }

  // Empty space in the timeline, its lanes and the browser.
  const nav = page.locator(".cad-editor__timeline");
  const lanes = page.locator(".cad-editor__lanes");
  const navBox = (await nav.boundingBox())!;
  const lanesBox = (await lanes.boundingBox())!;
  const asideBox = (await browser(page).boundingBox())!;
  for (const point of [
    { x: navBox.x + navBox.width - 8, y: navBox.y + 6 },
    { x: lanesBox.x + lanesBox.width - 8, y: lanesBox.y + lanesBox.height - 3 },
    { x: asideBox.x + asideBox.width / 2, y: asideBox.y + asideBox.height - 8 },
  ]) {
    await timelineEntry(page, "notch").click();
    await expect(dialog(page)).toHaveAttribute("data-feature", "notch");
    await page.mouse.click(point.x, point.y);
    await expect(dialog(page)).toHaveCount(0);
  }

  // Controls elsewhere do what they do: the code pane opens beside the dialog; a new feature is selected.
  await timelineEntry(page, "notch").click();
  await openCode(page);
  await expect(dialog(page)).toHaveAttribute("data-feature", "notch");
  await toolbarButton(page, "Move").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "move1");
  await expect(timelineEntry(page, "move1")).toHaveAttribute("aria-pressed", "true");
});

test("the selection follows the code pane's cursor, and a rename in the code or in place keeps the dialog", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await openCode(page);

  // Line by line: comments, the import and blank lines have no item; main's head and defaultParams are the parameters'.
  await clickLine(page, "// M1 from research");
  const expected = [
    "",
    "",
    "",
    "",
    "parameters",
    "",
    "parameters",
    "sketch1",
    "extrude1",
    "sketch2",
    "notch",
    "fillet1",
    "chamfer1",
    "sketch3",
    "extrude2",
    "return",
    "",
  ];
  for (const [i, feature] of expected.entries()) {
    if (i > 0) await page.keyboard.press("ArrowDown");
    if (feature) await expect(dialog(page), `line ${i + 1}`).toHaveAttribute("data-feature", feature);
    else await expect(dialog(page), `line ${i + 1}`).toHaveCount(0);
  }
  await expect(code(page).locator(".cm-content")).toBeFocused();

  // Typing on: an edit in the code shows in the dialog, which stays.
  await clickLine(page, "const fillet1");
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  const marked = await dialog(page).evaluate((el) => ((el as HTMLElement & { marked?: boolean }).marked = true));
  expect(marked).toBe(true);
  const sameDialog = () => dialog(page).evaluate((el) => (el as HTMLElement & { marked?: boolean }).marked === true);

  // Renaming fillet1 to round in the code, key by key: the dialog stays, disabled while the code doesn't parse.
  await page.keyboard.press("Home");
  for (let i = 0; i < "const fillet1".length; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < "fillet1".length; i++) {
    await page.keyboard.press("Backspace");
    await expect(dialog(page)).toHaveCount(1);
    expect(await sameDialog()).toBe(true);
  }
  await expect(page.locator(".cad-editor__banner")).toContainText("doesn't parse");
  await expect(dialog(page).getByLabel("Radius", { exact: true })).toBeDisabled();
  for (const key of "round") {
    await page.keyboard.type(key);
    await expect(dialog(page)).toHaveCount(1);
    expect(await sameDialog()).toBe(true);
  }
  await expect(dialog(page)).toHaveAttribute("data-feature", "round");
  await expect(dialog(page).getByLabel("Radius", { exact: true })).toBeEnabled();
  expect(await sameDialog()).toBe(true);
  expect(await selection(page)).toBe("feature:4");

  // In place, from the timeline's context menu.
  await timelineEntry(page, "round").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Rename" }).click();
  const field = page.locator(".cad-editor__timeline .cad-editor__rename");
  await field.fill("rounded");
  await field.press("Enter");
  await expect(dialog(page)).toHaveAttribute("data-feature", "rounded");
  expect(await sameDialog()).toBe(true);

  // A body's row renamed with a double click: its first click selects, its second doesn't close.
  await rowName(row(page, "block")).dblclick();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  const rename = browser(page).locator(".cad-editor__rename");
  await rename.fill("part");
  await rename.press("Enter");
  await expect(row(page, "part")).toHaveCount(1);
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
});

test("a face's context menu selects the feature that created it; while a field picks, clicks pick", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);

  const menu = page.getByRole("menu");
  // The block's right side, which extrude1 created.
  const side = await pointNear(page, "face", [60, 20, 10]);
  await page.mouse.click(side.x, side.y, { button: "right" });
  await menu.getByRole("menuitem", { name: "Edit extrude1" }).click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude1");
  // The boss's side: extrude2's.
  const boss = await pointNear(page, "face", [54, -2, 10]);
  await page.mouse.click(boss.x, boss.y, { button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit extrude2"]);
  await menu.getByRole("menuitem").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("aria-pressed", "true");
  // Empty space has none.
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y, { button: "right" });
  await expect(menu).toHaveCount(0);

  // extrude2's target picked in the timeline and in the browser, which lists what exists before extrude2: extrude2 stays selected.
  await dialog(page).locator('.cad-editor__field[data-param="target"]').getByRole("button", { name: "Select body" }).click();
  await timelineEntry(page, "notch").click();
  await expect.poll(() => modelSource(page)).toContain('operation: "join", target: notch');
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  await dialog(page).locator('.cad-editor__field[data-param="target"]').getByRole("button", { name: "Select body" }).click();
  await rowName(browser(page).locator(`${BODY_ROW}[data-version="chamfer1"]`)).click();
  await expect.poll(() => modelSource(page)).toContain('operation: "join", target: chamfer1');
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  // Escape ends picking first, then closes the dialog.
  await dialog(page).locator('.cad-editor__field[data-param="target"]').getByRole("button", { name: "Select body" }).click();
  await expect(dialog(page).getByRole("button", { name: "Done selecting" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page).getByRole("button", { name: "Done selecting" })).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("views and configurations have dialogs, and the browser and the Parameters dialog agree", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);

  // Home: its dialog, without a reset while it isn't changed.
  await rowName(namedRow(page, "Home")).click();
  await expect(dialog(page)).toHaveAttribute("data-view", "home");
  await expect(dialog(page)).toContainText("Home");
  await expect(dialog(page).getByRole("button", { name: "Reset to default" })).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Update to current view" }).click();
  await expect(dialog(page).getByRole("button", { name: "Reset to default" })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Reset to default" }).click();
  await expect(dialog(page).getByRole("button", { name: "Reset to default" })).toBeDisabled();
  // After an orbit, a click on the selected view goes back to it; once there, a click closes it.
  const empty = await emptyPoint(page);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 80, empty.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect(namedRow(page, "Home")).not.toHaveAttribute("data-current", "true");
  await rowName(namedRow(page, "Home")).click();
  await expect(namedRow(page, "Home")).toHaveAttribute("data-current", "true");
  await expect(dialog(page)).toHaveAttribute("data-view", "home");
  await rowName(namedRow(page, "Home")).click();
  await expect(dialog(page)).toHaveCount(0);

  // A view: deleting it in its dialog closes the dialog.
  await browser(page).getByRole("button", { name: "New view from the current camera" }).click();
  const field = browser(page).locator(".cad-editor__rename");
  await field.fill("Corner");
  await field.press("Enter");
  await rowName(namedRow(page, "Corner")).click();
  await expect(namedRow(page, "Corner")).toHaveAttribute("data-selected", "true");
  await expect(dialog(page)).toContainText("Corner");
  await dialog(page).getByRole("button", { name: "Delete" }).click();
  await expect(namedRow(page, "Corner")).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);

  // The parameters entry marks the configuration the model is shown with; a configuration's row selects it.
  await paramsEntry(page).click();
  await expect(namedRow(page, "Defaults")).toHaveAttribute("data-selected", "true");
  await browser(page).getByRole("button", { name: /^New configuration/ }).click();
  await field.fill("Wide");
  await field.press("Enter");
  await expect(namedRow(page, "Wide")).toHaveAttribute("data-selected", "true");
  await expect(namedRow(page, "Defaults")).not.toHaveAttribute("data-selected", "true");
  await rowName(namedRow(page, "Defaults")).click();
  await expect(dialog(page)).toHaveAttribute("data-configuration", "");
  expect(await selection(page)).toBe("configuration:");
  // Choosing one in the dialog selects its row.
  await dialog(page).getByLabel("Configuration", { exact: true }).selectOption({ label: "Wide" });
  await expect(namedRow(page, "Wide")).toHaveAttribute("data-selected", "true");
  await expect(namedRow(page, "Defaults")).not.toHaveAttribute("data-selected", "true");
  await expect(dialog(page)).toHaveAttribute("data-configuration", "Wide");
  await expect(paramsEntry(page)).toHaveAttribute("aria-pressed", "true");
  // Its row again closes the dialog; the model stays shown with it.
  await rowName(namedRow(page, "Wide")).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(namedRow(page, "Wide")).toHaveAttribute("data-current", "true");
});

test("collaborators see each other's selection in every pane, and a deleted item is no longer selected", async ({ users }) => {
  const [ua, ub] = await users(2);
  if (!ua || !ub) throw new Error("users(2) returned fewer than two users");
  const a = ua.page;
  const b = ub.page;
  await openM1(a);
  await bootToFrame(b, docPathWith(a));
  await expect(timelineEntry(b, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await openCode(b);

  await timelineEntry(a, "extrude2").click();
  await expect(timelineEntry(b, "extrude2")).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await expect(row(b, "block")).toHaveAttribute("data-peer", "true");
  await expect(code(b).locator(".cad-model__peer-item")).toContainText("const extrude2");
  // B's own selection is B's.
  await expect(timelineEntry(b, "extrude2")).toHaveAttribute("aria-pressed", "false");

  await returnEntry(a).click();
  await expect(returnEntry(b)).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await expect(timelineEntry(b, "extrude2")).not.toHaveAttribute("data-peer", "true");
  await expect(code(b).locator(".cad-model__peer-item")).toContainText("return");

  await rowName(namedRow(a, "Home")).click();
  await expect(namedRow(b, "Home")).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await expect(code(b).locator(".cad-model__peer-item")).toHaveCount(0);

  await rowName(namedRow(a, "Defaults")).click();
  await expect(namedRow(b, "Defaults")).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await expect(paramsEntry(b)).toHaveAttribute("data-peer", "true");

  // B renames and then deletes A's selected feature: A's dialog follows the rename, and closes with the deletion.
  await timelineEntry(a, "chamfer1").click();
  await expect(timelineEntry(b, "chamfer1")).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await setModelSource(b, (await modelSource(b)).replaceAll("chamfer1", "bevel"));
  await expect(dialog(a)).toHaveAttribute("data-feature", "bevel");
  await expect(timelineEntry(b, "bevel")).toHaveAttribute("data-peer", "true", { timeout: 15_000 });
  await timelineEntry(b, "bevel").click({ button: "right" });
  await b.getByRole("menu").getByRole("menuitem", { name: "Delete" }).click();
  await b.getByRole("menu").getByRole("menuitem", { name: "Delete bevel" }).click();
  await expect(timelineEntry(a, "bevel")).toHaveCount(0);
  await expect(dialog(a)).toHaveCount(0);
  expect(await selection(a)).toBe("");
});

test("a Custom Script is selected without a dialog, and the selection survives replaced text and code that doesn't parse", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, exampleSource("m3"));
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await openCode(page);

  // The loop of ribs: selected, with its code marked, and a dialog that opens its code or deletes it.
  const script = page.locator('.cad-editor__entry[data-kind="script"]');
  await script.click();
  await expect(script).toHaveAttribute("aria-pressed", "true");
  await expect(dialog(page)).toHaveAttribute("data-feature", "script");
  await expect(dialog(page).getByRole("button")).toHaveText(["×", "Edit code", "Delete"]);
  // fillet1 works on the body it makes: deleting it is refused, and the dialog stays.
  const source = await modelSource(page);
  await dialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  await dialog(page).getByRole("button", { name: /^Delete the Custom Script at lines/ }).click();
  await expect(page.locator(".cad-model__notice")).toContainText("Deleting the Custom Script at lines");
  expect(await modelSource(page)).toBe(source);
  await expect(dialog(page)).toHaveAttribute("data-feature", "script");
  const index = await script.getAttribute("data-index");
  expect(await selection(page)).toBe(`script:${index}`);
  await expect(code(page).locator(".cad-model__related--self").first()).toContainText("let body = upright;");
  // Its lines in the code keep it selected; the next statement selects fillet1.
  await clickLine(page, "for (const [i, x]");
  expect(await selection(page)).toBe(`script:${index}`);
  await clickLine(page, "const fillet1");
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await script.click();
  expect(await selection(page)).toBe(`script:${index}`);

  // The whole text replaced, which loses cursors: the Custom Script by its place, a feature by its name.
  await setModelSource(page, (await modelSource(page)).replace("radius: 2 })", "radius: 3 })"), "replace");
  await expect(timelineEntry(page, "fillet1")).toHaveCount(1);
  await expect(script).toHaveAttribute("aria-pressed", "true");
  await timelineEntry(page, "fillet1").click();
  await setModelSource(page, (await modelSource(page)).replace("radius: 3 })", "radius: 2 })"), "replace");
  await expect(dialog(page).getByLabel("Radius", { exact: true })).toHaveValue("2");
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");

  // While the code doesn't parse, another entry can be selected in the timeline's last valid state; its dialog is disabled until the code parses.
  await setModelSource(page, source.replace("return { bracket", "return ( { bracket"));
  await expect(page.locator(".cad-editor__banner")).toContainText("doesn't parse");
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await timelineEntry(page, "chamfer1").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "chamfer1");
  await expect(dialog(page).getByLabel("Distance", { exact: true })).toBeDisabled();
  await setModelSource(page, source);
  await expect(dialog(page).getByLabel("Distance", { exact: true })).toBeEnabled();
  await expect(dialog(page)).toHaveAttribute("data-feature", "chamfer1");
  // Anchored again: a rename by a collaborator keeps it.
  await setModelSource(page, source.replaceAll("chamfer1", "edges"));
  await expect(dialog(page)).toHaveAttribute("data-feature", "edges");
});
