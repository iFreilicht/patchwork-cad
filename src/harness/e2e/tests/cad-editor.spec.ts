import type { Page } from "@playwright/test";
import { CAD_MODULES, clickEntity, dialog, editorView, entities, isVisible, modelSource, setField, setModelSource, timelineEntry, toolbarButton } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

// The WYSIWYG editor shows the seed model's features as a timeline, edits a parameter through a
// form by splicing only its argument, and fills an edge reference by picking in the 3D view.
test("timeline, form edit and edge picking", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  // The WYSIWYG editor is the default tool.
  await createViaMenu(page, "CAD Model");
  const view = editorView(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(page.locator(".cad-editor__entry")).toHaveText(["✎\uFE0Esketch1", "⬆\uFE0Eplate", "✎\uFE0Esketch2", "⬆\uFE0Ebore", "◜\uFE0Efillet1"]);
  for (const name of ["sketch1", "plate", "sketch2", "bore", "fillet1"]) await expect(timelineEntry(page, name)).toHaveAttribute("data-status", "ok");
  if (shots) await page.screenshot({ path: `${shots}/editor-1-timeline.png` });

  await timelineEntry(page, "fillet1").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  const chips = dialog(page).locator(".cad-editor__chip");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("data-status", "ok");

  const before = await modelSource(page);
  const radius = dialog(page).getByLabel("Radius");
  await radius.fill("2");
  await radius.press("Enter");
  await expect.poll(() => modelSource(page)).toBe(before.replace("radius: 1.5", "radius: 2"));
  await expect(view).toHaveAttribute("data-state", "ready");

  await dialog(page).getByRole("button", { name: "Select edges" }).click();
  await expect(view).toHaveAttribute("data-rolled-back", "true");
  if (shots) await page.screenshot({ path: `${shots}/editor-2-select.png` });
  // Any visible edge of the rolled-back body that isn't selected yet.
  const candidates = (await entities(page, "edge")).filter((e) => e.body === "bore");
  let picked = false;
  for (const e of candidates) {
    if (!(await isVisible(page, e))) continue;
    await clickEntity(page, e);
    picked = true;
    break;
  }
  expect(picked).toBe(true);
  await expect(chips).toHaveCount(2);
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-status", "ok");
  await expect(chips.nth(1)).toHaveAttribute("data-status", "ok");
  if (shots) await page.screenshot({ path: `${shots}/editor-3-picked.png` });
  console.log(await modelSource(page));
});

// Form fields apply as they are typed, while their text is an expression and the code parses with it. Typing -10 into -20 passes
// through -0: an extrusion by 0 hung the kernel in the cut after it; now it fails alone.
test("form fields apply as they are typed, and an extrusion by 0 fails alone", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createViaMenu(page, "CAD Model");
  const view = editorView(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const before = await modelSource(page);
  const withDistance = (d: string) => before.replace("distance: height", `distance: ${d}`);

  await timelineEntry(page, "plate").click();
  const distance = dialog(page).getByLabel("Distance", { exact: true });
  // End doesn't move the caret on macOS hosts, whichever platform the device emulates.
  const caretToEnd = () => distance.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
  await distance.fill("");
  await page.keyboard.type("-10");
  await expect.poll(() => modelSource(page)).toBe(withDistance("-10"));
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-status", "ok");

  await distance.press("ArrowLeft");
  await distance.press("Backspace");
  await expect.poll(() => modelSource(page)).toBe(withDistance("-0"));
  await expect(timelineEntry(page, "plate")).toHaveAttribute("data-status", "failed");
  await expect(timelineEntry(page, "plate")).toHaveAttribute("title", /distance: expected a finite length other than 0, got 0/);

  await page.keyboard.type("2");
  await expect.poll(() => modelSource(page)).toBe(withDistance("-20"));
  await expect(timelineEntry(page, "plate")).toHaveAttribute("data-status", "ok");
  await expect(view).toHaveAttribute("data-state", "ready");

  // Text that isn't an expression is marked and stays out of the code; leaving the field drops it.
  await caretToEnd();
  await page.keyboard.type("+");
  await expect(distance).toHaveAttribute("aria-invalid", "true");
  expect(await modelSource(page)).toBe(withDistance("-20"));
  await distance.blur();
  await expect(distance).toHaveValue("-20");
  await expect(distance).toHaveAttribute("aria-invalid", "false");
  // Escape restores the value from before the edit.
  await distance.focus();
  await caretToEnd();
  await page.keyboard.type("0");
  await expect.poll(() => modelSource(page)).toBe(withDistance("-200"));
  await distance.press("Escape");
  await expect(distance).toHaveValue("-20");
  await expect.poll(() => modelSource(page)).toBe(withDistance("-20"));
  // An expression that the module wouldn't parse, a legacy octal, is invalid, too; the dialog stays.
  await distance.fill("01");
  await expect(distance).toHaveAttribute("aria-invalid", "true");
  expect(await modelSource(page)).toBe(withDistance("-20"));
  await expect(dialog(page)).toHaveAttribute("data-feature", "plate");
});

/** A plate with a chamfer around a filleted edge, and an extrusion joined to the body before the chamfer. */
const branched = `import { sketch, plane, rect, circle, extrude, fillet, edge, chamfer } from "@patchwork-cad/features";

export const defaultParams = { width: 60, depth: 40, height: 12, hole: 20 };

export default function main({ width, depth, height, hole }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [width, depth] }) });
  const plate = extrude({ sketch: sketch1, distance: height });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [width / 2, depth / 2], radius: hole / 2 }) });
  const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" });
  const fillet1 = fillet({ body: bore, edges: [edge(plate.end, bore.side.c)], radius: 1.5 });
  const fillet2 = fillet({ body: fillet1, edges: [edge(plate.end, plate.side.front), edge(plate.end, plate.side.right), edge(plate.end, plate.side.back), edge(plate.side.front, plate.side.right), edge(plate.side.back, plate.side.right)], radius: 5 });
  const chamfer1 = chamfer({ body: fillet2, edges: [edge(plate.end, plate.side.left)], distance: 3 });
  const sketch3 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch3, distance: -10, operation: "join", target: fillet2 });
  return extrude1;
}
`;

// Two features build on fillet2, but main returns only one of them: the chamfer's geometry would be
// dropped silently. The timeline marks it, and retargeting in the form never drops a body.
test("a result that nothing uses is marked, and retargeting keeps bodies in the result", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createViaMenu(page, "CAD Model");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await setModelSource(page, branched);
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "unused");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok");

  await timelineEntry(page, "chamfer1").click();
  await dialog(page).getByRole("button", { name: "Add to result" }).click();
  await expect.poll(() => modelSource(page)).toContain("return [extrude1, chamfer1];");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");

  await timelineEntry(page, "extrude1").click();
  const target = dialog(page).getByLabel("Target body", { exact: true });
  await target.selectOption("chamfer1");
  await expect.poll(() => modelSource(page)).toContain("return extrude1;");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
  await target.selectOption("fillet2");
  await expect.poll(() => modelSource(page)).toContain("return [extrude1, chamfer1];");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
});

const shownSketches = (page: Page) => page.locator(".cad-model__viewer").getAttribute("data-sketches");

// A sketch shows while nothing uses it: a new one goes into what main returns, an extrusion takes
// its place there, and deleting the extrusion brings it back. One that isn't returned is unused.
test("sketches that no feature uses show in the view", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createViaMenu(page, "CAD Model");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => shownSketches(page)).toBe("");

  await toolbarButton(page, "Sketch").click();
  await expect.poll(() => modelSource(page)).toContain("return [fillet1, sketch3];");
  await expect.poll(() => shownSketches(page)).toBe("sketch3");
  await expect(page.locator(".cad-model__warning")).toHaveCount(0);
  // On the plate's top face, where it shows without the open dialog's highlight.
  await setField(page, "Offset", "height");
  await expect.poll(() => modelSource(page)).toContain('plane("XY", height)');
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  await timelineEntry(page, "sketch3").click();
  await page.mouse.move(0, 0);
  if (shots) await page.screenshot({ path: `${shots}/editor-sketch-shown.png` });

  await toolbarButton(page, "Extrude").click();
  await expect.poll(() => modelSource(page)).toContain("return [fillet1, extrude1];");
  await expect.poll(() => shownSketches(page)).toBe("");
  // Rolled back before the extrusion, the sketch is unused again.
  const marker = page.getByRole("slider", { name: "Timeline marker" });
  await marker.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => shownSketches(page)).toBe("sketch3");
  await page.keyboard.press("End");
  await expect.poll(() => shownSketches(page)).toBe("");

  // The toolbar left the extrusion's dialog open.
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude1");
  await dialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Delete extrude1" }).click();
  await expect.poll(() => modelSource(page)).toContain("return [fillet1, sketch3];");
  await expect.poll(() => shownSketches(page)).toBe("sketch3");

  await setModelSource(page, (await modelSource(page)).replace("return [fillet1, sketch3];", "return fillet1;"));
  await expect(timelineEntry(page, "sketch3")).toHaveAttribute("data-status", "unused");
  await expect.poll(() => shownSketches(page)).toBe("");
  await timelineEntry(page, "sketch3").click();
  await dialog(page).getByRole("button", { name: "Add to result" }).click();
  await expect.poll(() => shownSketches(page)).toBe("sketch3");
  await expect(timelineEntry(page, "sketch3")).toHaveAttribute("data-status", "ok");
});
