import { CAD_MODULES, clickEntity, dialog, editorView, entities, isVisible, modelSource, setModelSource, timelineEntry } from "../cad.ts";
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
  await expect(page.locator(".cad-editor__entry")).toHaveText(["✎sketch1", "⬆plate", "✎sketch2", "⬆bore", "◜fillet1"]);
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
