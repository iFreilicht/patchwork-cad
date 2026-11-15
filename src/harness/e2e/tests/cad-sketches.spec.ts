/**
 * Sketches from drawings (research/21-embedding.md, "Sketch from a drawing"): an SVG dragged from
 * Patchwork's sidebar onto a face becomes a sketch on it, imported as text, in one undo step; an
 * extrusion of it starts with picking its profiles in the view, where a click adds or removes one
 * and Filled takes what the drawing fills; a second extrusion picks others of the same sketch. An SVG
 * dropped elsewhere is a sketch on XY once Sketch is chosen, at its own size if it has one, which its
 * dialog changes.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, editorView, entities, modelSource, setModelSource, timelineEntry, toolbarButton, type Entity } from "../cad.ts";
import { drag, sidebarDocuments } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const PLATE = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [-60, -40], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance: 8 });
  return { plate };
}
`;

/**
 * Two overlapping rectangles, which enclose three profiles; a circle that isn't filled, a path that
 * doesn't close and encloses nothing, and a text in a font the editor doesn't have, whose e has a hole.
 */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
  <rect id="a" x="0" y="0" width="50" height="40" fill="#4080ff"/>
  <rect id="b" x="25" y="20" width="50" height="40" fill="#ff8040"/>
  <circle id="dot" cx="100" cy="20" r="15" fill="none" stroke="black"/>
  <path id="tail" d="M85 45 L115 45 L115 58" fill="none" stroke="black"/>
  <text x="85" y="58" font-family="Arial" font-size="10">Hey</text>
</svg>`;
/** a, a and b, b, the circle, H, e, its hole, y. */
const LOGO_PROFILES = 8;

/** A drawing 50 mm × 20 mm: a frame and a slot in it. */
const PLAN = `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm" viewBox="0 0 50 20"><path id="frame" fill-rule="evenodd" d="M0 0H50V20H0Z M10 8H40V12H10Z"/></svg>`;

async function open(page: Page) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // The document sidebar stays, where documents are dragged from.
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, PLATE, "replace");
  await expect(timelineEntry(page, "plate")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => entities(page, "face").then((f) => f.length), { timeout: 60_000 }).toBeGreaterThan(0);
  // Changes within 500 ms of each other are one undo step (research/16).
  await page.waitForTimeout(600);
}

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
const status = (page: Page) => page.locator(".cad-model__status").first();
type Region = { key: string; chosen: boolean; hovered: boolean; point: { x: number; y: number } | undefined };
const regions = (page: Page) => viewer(page).evaluate((el) => (el as unknown as { cadViewer: { regions(): Region[] } }).cadViewer.regions());
const regionsArgument = async (page: Page, feature: string) => new RegExp(`const ${feature} = extrude\\(\\{[^\\n]*regions: (\\[[^\\]]*\\]|[\\w.]+)`).exec(await modelSource(page))?.[1];

/** The plate's top face, where a click or a drop reaches it. */
async function topFace(page: Page): Promise<{ x: number; y: number }> {
  for (const face of await entities(page, "face")) {
    const centroid = await viewer(page).evaluate((el, e) => (el as unknown as { cadViewer: { centroid(e: Entity): number[] | undefined } }).cadViewer.centroid(e), face);
    if (!centroid || Math.abs(centroid[2]! - 8) > 1e-6) continue;
    const at = await viewer(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
    if (at) return at;
  }
  throw new Error("the plate's top face isn't in the view");
}

/** Clicks a region that a click reaches, which isn't chosen or is, and returns its key. */
async function clickRegion(page: Page, chosen: boolean): Promise<string> {
  const region = (await regions(page)).find((r) => r.point && r.chosen === chosen);
  if (!region) throw new Error(`no ${chosen ? "chosen" : "unchosen"} region in the view`);
  await page.mouse.move(region.point!.x, region.point!.y);
  await expect.poll(() => regions(page).then((all) => all.find((r) => r.key === region.key)?.hovered)).toBe(true);
  await expect(status(page)).toContainText(chosen ? "Remove sketch2." : "Add sketch2.");
  await page.mouse.click(region.point!.x, region.point!.y);
  return region.key;
}

async function undo(page: Page, redo = false) {
  await page.locator(".cad-editor__stage").focus();
  await pressMod(page, redo ? "Shift+z" : "z");
}

test("an SVG dropped on a face is a sketch there; an extrusion picks its profiles in the view, and another extrusion others", async ({ users }, info) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, { "logo.svg": { file: "logo.svg", mimeType: "image/svg+xml", text: LOGO } });

  // Dropped on the top face: a sketch on it, centred where it was dropped and about as wide as the model, its drawing imported as text, in one change.
  await drag(page, "logo.svg", await topFace(page), false);
  await expect(status(page)).toContainText("Sketch logo.svg on the face");
  await page.mouse.up();
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  const source = await modelSource(page);
  expect(source).toContain(`import logo from "${docs["logo.svg"]}" with { type: "text" };`);
  expect(source).toMatch(/import \{ sketch, plane, rect, extrude, svg \} from "@patchwork-cad\/features";/);
  expect(source).toMatch(/const sketch2 = sketch\(\{ plane: plate\.end, body: plate, profile: svg\(logo, \{ width: 100, center: \[-?[\d.]+, -?[\d.]+\] \}\) \}\);/);
  await expect(dialog(page)).toHaveAttribute("data-feature", "sketch2");
  // A font the editor doesn't have is drawn in one with its metrics, and said so.
  await expect(dialog(page).locator('.cad-editor__problem[data-status="warning"]')).toHaveText(['text1: "Arial" isn\'t available: drawn in Liberation Sans, which has its metrics']);
  await expect(dialog(page).getByLabel("Size", { exact: true })).toHaveValue("width");
  await expect(dialog(page).locator("[data-size]")).toHaveText("100 × 52.24");
  await expect(page.locator('.cad-editor__document-row[data-role="import"]')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/sketch-dropped-${info.project.name}.png` });

  // The import and the sketch are one undo step.
  await page.waitForTimeout(600);
  await undo(page);
  await expect.poll(() => modelSource(page)).toBe(PLATE);
  await undo(page, true);
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });

  // An extrusion of it starts with picking its profiles: the regions the curves bound, without the open path.
  await toolbarButton(page, "Extrude").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude1");
  await expect(dialog(page).getByRole("button", { name: "Done selecting" })).toBeVisible();
  await expect.poll(() => regions(page).then((r) => r.length), { timeout: 60_000 }).toBe(LOGO_PROFILES);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "failed");
  await expect(dialog(page).locator(".cad-editor__problem")).toContainText(`sketch2 has ${LOGO_PROFILES} profiles: select which to use`);

  // A click adds a region, accented; another adds a second; a click on a chosen one removes it.
  const first = await clickRegion(page, false);
  await expect.poll(() => regions(page).then((r) => r.find((x) => x.key === first)?.chosen), { timeout: 60_000 }).toBe(true);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await clickRegion(page, false);
  await expect.poll(() => regions(page).then((r) => r.filter((x) => x.chosen).length), { timeout: 60_000 }).toBe(2);
  expect(await regionsArgument(page, "extrude1")).toMatch(/^\[sketch2\.region\([^)]*\), sketch2\.region\([^)]*\)\]$/);
  await expect(dialog(page).locator('[data-param="regions"] .cad-editor__chip')).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/sketch-picking-${info.project.name}.png` });
  await clickRegion(page, true);
  await expect.poll(() => regions(page).then((r) => r.filter((x) => x.chosen).length), { timeout: 60_000 }).toBe(1);
  expect(await regionsArgument(page, "extrude1")).toMatch(/^\[sketch2\.region\([^)]*\)\]$/);

  // Filled: the rectangles and the letters, without the circle and the e's hole.
  await dialog(page).getByRole("button", { name: "Filled" }).click();
  await expect.poll(() => regionsArgument(page, "extrude1")).toBe("sketch2.filled");
  await expect.poll(() => regions(page).then((r) => r.filter((x) => x.chosen).length), { timeout: 60_000 }).toBe(LOGO_PROFILES - 2);
  await dialog(page).getByRole("button", { name: "Done selecting" }).click();
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => entities(page, "face").then((f) => f.some((e) => e.body === "extrude1")), { timeout: 60_000 }).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/sketch-filled-${info.project.name}.png` });

  // A second extrusion of the same sketch picks another of its profiles.
  await toolbarButton(page, "Extrude").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "extrude2");
  expect(await modelSource(page)).toContain("const extrude2 = extrude({ sketch: sketch2");
  await expect.poll(() => regions(page).then((r) => r.length), { timeout: 60_000 }).toBe(LOGO_PROFILES);
  await clickRegion(page, false);
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok");
});

test("an SVG dropped in the view is a sketch on XY once Sketch is chosen, at its own size, which its dialog changes", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "plan.svg": { file: "plan.svg", mimeType: "image/svg+xml", text: PLAN } });
  const box = (await page.locator(".cad-editor__stage").boundingBox())!;
  await drag(page, "plan.svg", { x: box.x + 40, y: box.y + 40 });
  const roles = dialog(page).getByRole("radiogroup", { name: "Use as" }).getByRole("radio");
  await expect(roles).toHaveText(["Sketch", "Canvas", "Import", "Annotation"]);
  await roles.getByText("Sketch", { exact: true }).click();

  // On XY, under the model's centre, in millimetres as drawn: no size of its own to write.
  await expect(timelineEntry(page, "sketch2")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  expect(await modelSource(page)).toContain(`const sketch2 = sketch({ plane: plane("XY"), profile: svg(plan) });`);
  await expect(dialog(page).getByLabel("Size", { exact: true })).toHaveValue("natural");
  await expect(dialog(page).locator("[data-size]")).toHaveText("50 × 20");

  // Sized by its width, from its size now; then typed.
  await dialog(page).getByLabel("Size", { exact: true }).selectOption("width");
  await expect.poll(() => modelSource(page)).toContain("profile: svg(plan, { width: 50 })");
  await dialog(page).getByLabel("width", { exact: true }).fill("25");
  await expect(dialog(page).locator("[data-size]")).toHaveText("25 × 10", { timeout: 60_000 });
  // By its height instead, at the height it has; and moved.
  await dialog(page).getByLabel("Size", { exact: true }).selectOption("height");
  await expect.poll(() => modelSource(page)).toContain("profile: svg(plan, { height: 10 })");
  await dialog(page).getByLabel("center x", { exact: true }).fill("5");
  await expect.poll(() => modelSource(page)).toContain("profile: svg(plan, { height: 10, center: [5, 0] })");
  await dialog(page).getByLabel("Size", { exact: true }).selectOption("natural");
  await expect.poll(() => modelSource(page)).toContain("profile: svg(plan, { center: [5, 0] })");

  // Its two profiles, the frame and the slot, which a new extrusion picks; the frame is what the drawing fills.
  await toolbarButton(page, "Extrude").click();
  await expect.poll(() => regions(page).then((r) => r.length), { timeout: 60_000 }).toBe(2);
  await dialog(page).getByRole("button", { name: "Filled" }).click();
  await expect.poll(() => regions(page).then((r) => r.filter((x) => x.chosen).length), { timeout: 60_000 }).toBe(1);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
});

test("a drawing that changes keeps its profiles by their ids; one whose profile is gone is held back, and says why", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, { "logo.svg": { file: "logo.svg", mimeType: "image/svg+xml", text: LOGO } });
  const source = PLATE.replace('extrude } from "@patchwork-cad/features";', `extrude, svg } from "@patchwork-cad/features";\nimport logo from "${docs["logo.svg"]}" with { type: "text" };`).replace(
    "  return { plate };",
    `  const sketch2 = sketch({ plane: plate.end, body: plate, profile: svg(logo, { width: 100 }) });
  const boss = extrude({ sketch: sketch2, regions: [sketch2.region("dot")], distance: 3 });
  return { plate, boss };`,
  );
  await setModelSource(page, source, "replace");
  await expect(timelineEntry(page, "boss")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  const change = (text: string) =>
    page.evaluate(
      async ([url, text]) => (await (window as unknown as { repo: { find(u: string): Promise<{ change(f: (d: Record<string, unknown>) => void): void }> } }).repo.find(url!)).change((d) => (d["content"] = new TextEncoder().encode(text!))),
      [docs["logo.svg"]!, text] as const,
    );

  // The circle moves and the rectangles go: its region is still the circle, by its id.
  await change(LOGO.replace('cx="100"', 'cx="90"').replace(/<rect[^>]*\/>/g, ""));
  await expect(page.locator('.cad-editor__document-row[data-role="import"]')).not.toHaveAttribute("data-state", "held", { timeout: 30_000 });
  await expect(timelineEntry(page, "boss")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });

  // Without the circle, the extrusion would break: the drawing is held back at the version the model last built with.
  await change(LOGO.replace(/<circle[^>]*\/>/, ""));
  await expect(status(page)).toContainText('logo is held back at the version the model last built with: boss: broken reference: sketch2.region("dot"): no profile lies inside "dot" alone', { timeout: 60_000 });
  await expect(page.locator('.cad-editor__document-row[data-role="import"]')).toHaveAttribute("data-state", "held");
  await expect(timelineEntry(page, "boss")).toHaveAttribute("data-status", "ok");
});
