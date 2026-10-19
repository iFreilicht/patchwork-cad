/**
 * Adopting replicad shapes with body() (research/11): the quick fix for a join onto a replicad
 * shape, body() entries in the timeline and at the marker, picking faces of an adopted body, and the
 * timeline's context menu with rename, wrap, unwrap and delete.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, editorView, hideSidebars, modelSource, pickNear, setModelSource, timelineEntry, toolbarButton, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const plate = (target: string, extra = "", returned = "[cut_plate, extrude1]") => `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
import { drawRoundedRectangle, drawCircle } from "replicad";

export const defaultParams = { width: 100, depth: 40, height: 12, hole: 30 };

export default function main({ width, depth, height, hole }) {
  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
  const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 20, ${target} });${extra}
  return ${returned};
}
`;

const entries = (page: Page) => page.locator(".cad-editor__entry");
const names = (page: Page) => entries(page).evaluateAll((els) => els.map((e) => (e.getAttribute("data-kind") === "script" ? "script" : (e.textContent ?? "").replace(/^\W+/, ""))));
const menu = (page: Page) => page.getByRole("menu");
const notice = (page: Page) => page.locator(".cad-model__notice");

async function open(page: Page, source: string): Promise<void> {
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, source);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
}

/** Opens the context menu of entry `index` with a right-click and runs `item`. */
async function fromMenu(page: Page, index: number, item: string): Promise<void> {
  await entries(page).nth(index).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: item, exact: true }).click();
}

test("a join onto a replicad shape fails alone, and its fix wraps the shape in body()", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, plate('operation: "join", target: cut_plate'));
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "failed");
  // The rest of the model still builds: the error is the feature's, not the model's.
  await expect(page.locator(".cad-model__status .cad-model__error")).toHaveCount(0);
  await timelineEntry(page, "extrude1").click();
  await expect(dialog(page)).toContainText("target: a replicad shape, not a feature body; wrap it with body(…)");
  await dialog(page).getByRole("button", { name: "Wrap cut_plate in body()" }).click();
  await expect.poll(() => modelSource(page)).toContain("  const cut_plate = body(() => {\n    const plate = drawRoundedRectangle");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok");
  await expect.poll(() => names(page)).toEqual(["cut_plate", "sketch1", "extrude1"]);
  await expect(timelineEntry(page, "cut_plate")).toHaveAttribute("data-type", "body");
  // A body() has no dialog: selecting it opens its code.
  await timelineEntry(page, "cut_plate").click();
  await expect(editorView(page)).toHaveAttribute("data-open", "");
  await expect(page.locator(".cad-model__code .cad-model__focus").first()).toContainText("const cut_plate = body(() => {");
  // The editor has the focus, with the cursor at the start of the code; the next key removes the mark.
  const code = page.locator(".cad-model__code");
  const mark = code.locator(".cad-model__focus");
  await expect(code.locator(".cm-content")).toBeFocused();
  await expect(code.locator(".cm-activeLine")).toHaveText("  const cut_plate = body(() => {");
  await page.keyboard.press("ArrowDown");
  await expect(mark).toHaveCount(0);
  await expect(code.locator(".cm-activeLine")).toHaveText("    const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);");

  // "Edit code" in a feature's menu marks its code the same way; a click in the editor removes the mark.
  await timelineEntry(page, "extrude1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit code" }).click();
  await expect(mark.first()).toContainText("const extrude1 = extrude(");
  await expect(code.locator(".cm-content")).toBeFocused();
  await code.locator(".cm-line").first().click();
  await expect(mark).toHaveCount(0);

  // Leaving the editor removes it, too, and it doesn't come back when the code pane opens again.
  await timelineEntry(page, "sketch1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit code" }).click();
  await expect(mark.first()).toContainText("const sketch1 = sketch(");
  await page.locator(".cad-model__viewer").click({ position: { x: 5, y: 5 } });
  await expect(mark).toHaveCount(0);
  const toggle = page.locator(".cad-editor__toolbar").getByRole("button", { name: "Code" });
  await toggle.click();
  await toggle.click();
  await expect(code.locator(".cm-content")).toBeVisible();
  await expect(mark).toHaveCount(0);
});

test("the marker rolls replicad shapes back once they are bodies", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  const other = "\n  const other_plate = drawRoundedRectangle(depth, width, 6).sketchOnPlane().extrude(-height);";
  await open(page, plate('operation: "new"', other, "[cut_plate, extrude1, other_plate]"));
  await fromMenu(page, 0, "Wrap in body()");
  await expect.poll(() => names(page)).toEqual(["cut_plate", "sketch1", "extrude1", "script"]);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  const all = await vertices(page);
  const at = async (position: number) => {
    await page.getByRole("slider", { name: "Timeline marker" }).focus();
    await page.keyboard.press("End");
    for (let i = position; i < 4; i++) await page.keyboard.press("ArrowLeft");
    await expect(editorView(page)).toHaveAttribute("data-marker", String(position));
    await expect(editorView(page)).toHaveAttribute("data-rolled-back", "true");
    await expect.poll(() => vertices(page)).not.toBe(all);
    return vertices(page);
  };
  // Before the script that makes other_plate: no feature runs after the marker, so it shows the state after extrude1.
  const two = await at(3);
  // Before extrude1: only cut_plate.
  const one = await at(2);
  expect(one).toBeLessThan(two);
  expect(two).toBeLessThan(all);
  expect(one).toBeGreaterThan(0);
  await at(0);
  await expect.poll(() => vertices(page)).toBe(0);
});

test("faces of an adopted body are picked by their centroids, and features resolve them", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(
    page,
    `import { body } from "@patchwork-cad/features";
import { drawRoundedRectangle } from "replicad";

export default function main() {
  const block = body(() => drawRoundedRectangle(60, 40, 6).sketchOnPlane().extrude(10));
  return block;
}
`,
  );
  await toolbarButton(page, "Fillet").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await pickNear(page, "edge", [0, -20, 10], "block");
  await expect.poll(() => modelSource(page)).toMatch(/edges: \[edge\(block\.faceAt\(\[[^\]]+\]\), block\.faceAt\(\[[^\]]+\]\)\)\]/);
  await expect(dialog(page).locator(".cad-editor__chip").first()).toHaveAttribute("data-status", "ok");
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-status", "ok");
});

test("the context menu: keyboard, ⋯ button, rename, unwrap and delete", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, plate('operation: "join", target: cut_plate'));
  await fromMenu(page, 0, "Wrap in body()");
  await expect.poll(() => names(page)).toEqual(["cut_plate", "sketch1", "extrude1"]);

  // Keyboard: Shift+F10 opens it on the focused entry, the arrows move, Escape closes and refocuses.
  await timelineEntry(page, "sketch1").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Edit", "Edit code", "Roll back to here", "Comment", "Rename", "Delete"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitem", { name: "Roll back to here" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(timelineEntry(page, "sketch1")).toBeFocused();

  // The ⋯ button floats above the selected entry, right-aligned with it, and shifts nothing.
  const more = page.getByRole("button", { name: "Actions for sketch1" });
  const before = await timelineEntry(page, "extrude1").boundingBox();
  await timelineEntry(page, "sketch1").click();
  await expect(more).toBeVisible();
  const [button, entry] = [(await more.boundingBox())!, (await timelineEntry(page, "sketch1").boundingBox())!];
  expect(Math.abs(button.x + button.width - (entry.x + entry.width))).toBeLessThan(1);
  expect(button.y + button.height).toBeLessThanOrEqual(entry.y);
  expect(await timelineEntry(page, "extrude1").boundingBox()).toEqual(before);
  // Closing the dialog unselects the feature, and the button goes.
  await timelineEntry(page, "sketch1").click();
  await expect(more).toHaveCount(0);
  // A body() stays selected after a click, until something else is.
  await timelineEntry(page, "cut_plate").click();
  await expect(page.getByRole("button", { name: "Actions for cut_plate" })).toBeVisible();
  await page.locator(".cad-model__viewer").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("button", { name: "Actions for cut_plate" })).toHaveCount(0);
  // It opens the same menu; "Roll back to here" puts the marker after the entry.
  await timelineEntry(page, "sketch1").click();
  await more.click();
  await menu(page).getByRole("menuitem", { name: "Roll back to here" }).click();
  await expect(editorView(page)).toHaveAttribute("data-marker", "2");
  await page.getByRole("button", { name: "Move the timeline marker to the end" }).click();

  // Rename in place; a taken name is refused in the status bar.
  await fromMenu(page, 0, "Rename");
  const field = page.getByRole("textbox", { name: "New name for cut_plate" });
  await field.fill("sketch1");
  await field.press("Enter");
  await expect(notice(page)).toHaveText("Renaming cut_plate to sketch1 doesn't work: sketch1 is already used in the model.");
  await field.fill("base");
  await field.press("Enter");
  await expect.poll(() => names(page)).toEqual(["base", "sketch1", "extrude1"]);
  const source = await modelSource(page);
  expect(source).toContain("const base = body(() => {");
  expect(source).toContain("target: base });");
  expect(source).toContain("return [base, extrude1];");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok");

  // F2 renames too; Escape keeps the name.
  await timelineEntry(page, "base").focus();
  await page.keyboard.press("F2");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect.poll(() => names(page)).toEqual(["base", "sketch1", "extrude1"]);

  // Unwrapping is refused while a feature uses the body.
  await fromMenu(page, 0, "Unwrap");
  await expect(notice(page)).toHaveText("Unwrapping base doesn't work: extrude1 uses it as a body.");

  // Delete asks again; extrude1's target becomes a broken reference, and base leaves the result.
  await entries(page).nth(0).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Delete", exact: true }).click();
  await menu(page).getByRole("menuitem", { name: "Delete base" }).click();
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1"]);
  const deleted = await modelSource(page);
  expect(deleted).toContain("target: ref.base });");
  expect(deleted).toContain("return extrude1;");

  // Delete twice on a focused entry deletes it as well.
  await timelineEntry(page, "extrude1").focus();
  await page.keyboard.press("Delete");
  await expect(notice(page)).toHaveText("Press Delete again to delete extrude1.");
  await page.keyboard.press("Delete");
  await expect.poll(() => names(page)).toEqual(["sketch1"]);
});
