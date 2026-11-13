/**
 * Experiment (research/21, "Canvas"): documents that aren't images on canvases, each shown live by
 * its tool in a `<patchwork-view>` that three's CSS3DRenderer places on the plane, read-only at its
 * current heads or editable. Screenshots only; nothing here is a claim the tool keeps.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, clickHome, hideSidebars, clickViewCube, createModel, docUrl, editorView, setModelSource, timelineEntry } from "../cad.ts";
import { sidebarDocuments, type Repo } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });
// tldraw loads its fonts and icons from its CDN, which the egress proxy refuses.
test.use({ pageErrorsAllowed: ["cdn.tldraw.com", "A network error occurred.", "Failed to load", "font"] });
test.setTimeout(240_000);
test.use({ egressAllowed: true });

const shots = process.env["CAD_SHOTS"] ?? "test-results";

const PLATE = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 5 });
  return { plate: extrude1 };
}
`;

const NOTES = `# Bracket

Mount to the **rear panel** with two M4 screws.

- material: PETG
- wall: 2.4 mm
- infill: 30 %

> Check clearance to the fan before printing.
`;

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + from[0] + ((to[0] - from[0]) * i) / 10, box.y + from[1] + ((to[1] - from[1]) * i) / 10);
  await page.mouse.up();
}

/** A tldraw document with a few shapes, drawn with its own tools. */
async function tldraw(page: Page): Promise<string> {
  await createViaMenu(page, "tldraw");
  await page.locator(".tl-canvas").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const box = (await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("r");
  await drag(page, [150, 150], [400, 300]);
  await page.keyboard.press("o");
  await drag(page, [450, 160], [600, 320]);
  await page.keyboard.press("a");
  await drag(page, [400, 225], [450, 240]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: `${shots}/experiment-tldraw-itself.png` });
  return docUrl(page);
}

async function zoomOut(page: Page, steps: number) {
  const box = (await page.locator(".cad-editor__stage").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, 300);
}

type Canvas = Record<string, unknown>;
async function setCanvases(page: Page, canvases: Canvas[]) {
  await page.evaluate(
    async ([url, list]) => {
      const h = await (window as unknown as { repo: Repo }).repo.find(url as string);
      h.change((d) => {
        const doc = d as { cad?: { canvases?: unknown[] } };
        doc.cad ??= {};
        doc.cad.canvases = JSON.parse(JSON.stringify(list));
      });
    },
    [docUrl(page), canvases] as const,
  );
}

test("documents on canvases: tldraw, markdown and data, read-only and live", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const drawing = await tldraw(page);
  const docs = await sidebarDocuments(page, {
    "notes.md": { file: "notes.md", mimeType: "text/markdown", text: NOTES },
    "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: NOTES },
    "Bracket notes": { data: { "@patchwork": { type: "markdown" }, content: NOTES } },
    "sizes": { data: { title: "sizes", wall: 2.4, holes: { diameter: 4.2, count: 2 } } },
  });
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, PLATE, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });

  const base = { angle: 0, opacity: 1, through: false };
  // Behind the plate on XZ at y = 20, beside it on YZ at x = -15, and the data under it on XY.
  await setCanvases(page, [
    { ...base, id: "t", name: "sketch", image: drawing, tool: "tldraw5", plane: { origin: [0, 20, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }, center: [10, 10], width: 40 },
    { ...base, id: "m", name: "notes", image: docs["notes.md"], tool: "file", plane: { origin: [-15, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, center: [5, 8], width: 24, aspect: 1 },
    { ...base, id: "d", name: "sizes", image: docs["sizes"], tool: "raw", plane: { origin: [0, 0, -0.5], normal: [0, 0, 1], xDir: [1, 0, 0] }, center: [10, 5], width: 30, aspect: 0.6 },
  ]);
  await page.waitForTimeout(8000);
  await zoomOut(page, 6);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/experiment-documents-all.png` });

  // Each alone, face on: behind the plate on XZ, seen from the front.
  const behind = { origin: [0, 20, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
  const one = async (name: string, canvas: Canvas) => {
    await setCanvases(page, [{ ...base, plane: behind, center: [10, 2.5], width: 44, ...canvas }]);
    await clickHome(page);
    await page.waitForTimeout(800);
    await clickViewCube(page, [0, -1, 0]);
    await page.waitForTimeout(800);
    await zoomOut(page, 5);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${shots}/experiment-${name}.png` });
  };
  await one("tldraw-readonly", { id: "t1", name: "sketch", image: drawing, tool: "tldraw5" });
  await one("tldraw-live", { id: "t2", name: "sketch", image: drawing, tool: "tldraw5", live: true });
  await one("markdown-file-readonly", { id: "m1", name: "notes", image: docs["notes.md"], tool: "file", aspect: 0.75 });
  await one("data-raw-readonly", { id: "d1", name: "sizes", image: docs["sizes"], tool: "raw", aspect: 0.75 });
  await one("text-file-readonly", { id: "x1", name: "notes", image: docs["notes.txt"], tool: "file", aspect: 0.75 });
  await one("markdown-doc-readonly", { id: "k1", name: "notes", image: docs["Bracket notes"], aspect: 0.75 });
  await one("tldraw-readonly-bare", { id: "t4", name: "sketch", image: drawing, tool: "tldraw5", bare: true });
  await one("tldraw-readonly-half", { id: "t3", name: "sketch", image: drawing, tool: "tldraw5", opacity: 0.5 });
});

const shapeCount = (page: Page, url: string) =>
  page.evaluate(async (u) => Object.values(((await (window as unknown as { repo: Repo }).repo.find(u)).doc() as { store: Record<string, { typeName?: string }> }).store).filter((r) => r.typeName === "shape").length, url);

test("a tldraw drawing fitted to its canvas, and edited in place; a markdown document too", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const drawing = await tldraw(page);
  const docs = await sidebarDocuments(page, { "Bracket notes": { data: { "@patchwork": { type: "markdown" }, content: NOTES } } });
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, PLATE, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });

  const base = { angle: 0, opacity: 1, through: false };
  const behind = { origin: [0, 20, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
  await setCanvases(page, [
    { ...base, id: "t", name: "sketch", image: drawing, tool: "tldraw5", bare: true, plane: behind, center: [10, 2.5], width: 44 },
    { ...base, id: "m", name: "notes", image: docs["Bracket notes"], plane: { origin: [-15, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, center: [5, 8], width: 24, aspect: 1 },
  ]);
  await clickViewCube(page, [0, -1, 0]);
  await page.waitForTimeout(800);
  await zoomOut(page, 5);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${shots}/experiment-tldraw-fitted.png` });

  // Its dialog: Height, Fit and Edit in place besides an image's fields.
  await page.getByRole("list", { name: "Canvases", exact: true }).locator(".cad-editor__browser-name").first().click();
  await expect(page.locator(".cad-editor__dialog")).toHaveAttribute("data-role", "canvas");
  await page.screenshot({ path: `${shots}/experiment-tldraw-dialog.png` });

  // Edited in place: face on, live, with tldraw's own UI; a rectangle drawn there is in the drawing, and tldraw's undo takes it back.
  const before = await shapeCount(page, drawing);
  await page.getByRole("button", { name: "Edit in place", exact: true }).click();
  const overlay = page.locator(".cad-model__document-edit");
  await overlay.locator(".tl-canvas").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}/experiment-tldraw-edit.png` });
  const box = (await overlay.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.press("r");
  const from = [box.x + box.width * 0.4, box.y + box.height * 0.55];
  await page.mouse.move(from[0]!, from[1]!);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from[0]! + i * box.width * 0.02, from[1]! + i * box.height * 0.015);
  await page.mouse.up();
  await page.screenshot({ path: `${shots}/experiment-tldraw-after-drag.png` });
  await expect.poll(() => shapeCount(page, drawing)).toBe(before + 1);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/experiment-tldraw-edit-drawn.png` });
  // The CAD editor's undo, Mod+Z (Ctrl under the harness's Windows emulation), leaves a key pressed in the drawing to tldraw.
  const cadCanvases = () => page.evaluate(async (u) => JSON.stringify(((await (window as unknown as { repo: Repo }).repo.find(u)).doc() as { cad?: unknown }).cad), docUrl(page));
  const cadBefore = await cadCanvases();
  await pressMod(page, "z");
  await page.waitForTimeout(800);
  expect(await cadCanvases()).toBe(cadBefore);
  // tldraw takes its undo from the host, macOS here, whatever the emulated platform.
  await page.keyboard.press("Meta+z");
  await expect.poll(() => shapeCount(page, drawing)).toBe(before);
  await expect(overlay).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(() => shapeCount(page, drawing)).toBe(before + 1);

  // Done: back to the read-only canvas, which shows the new rectangle.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${shots}/experiment-tldraw-done.png` });

  // The markdown document, edited in place from the side.
  await page.getByRole("list", { name: "Canvases", exact: true }).locator(".cad-editor__browser-name").nth(1).click();
  await page.getByRole("button", { name: "Edit in place", exact: true }).click();
  await overlay.locator(".cm-content").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await overlay.locator(".cm-content").click();
  await pressMod(page, "End");
  await page.keyboard.type("\nAdded in the CAD editor.");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${shots}/experiment-markdown-edit.png` });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await zoomOut(page, 3);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${shots}/experiment-markdown-done.png` });
});

test("documents in front of the model fade into it by their opacity", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const drawing = await tldraw(page);
  const docs = await sidebarDocuments(page, { "Bracket notes": { data: { "@patchwork": { type: "markdown" }, content: NOTES } } });
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, PLATE, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  const base = { angle: 0, through: false };
  // In front of the plate seen from the front (XZ at y = -4) and from the right (YZ at x = 26).
  await setCanvases(page, [
    { ...base, id: "t", name: "sketch", image: drawing, tool: "tldraw5", bare: true, opacity: 0.5, plane: { origin: [0, -4, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }, center: [10, 2.5], width: 30 },
    { ...base, id: "m", name: "notes", image: docs["Bracket notes"], opacity: 0.6, plane: { origin: [26, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, center: [5, 3], width: 16, aspect: 0.8 },
  ]);
  await zoomOut(page, 4);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${shots}/experiment-opacity-home.png` });
  await clickViewCube(page, [0, -1, 0]);
  await page.waitForTimeout(800);
  await zoomOut(page, 3);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${shots}/experiment-opacity-front.png` });
});
