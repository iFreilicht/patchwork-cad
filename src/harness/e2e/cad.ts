import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { HARNESS_DIR } from "./stack.ts";
import { createViaMenu, editor, pressMod } from "./ui.ts";

/** The CAD tool package (src/cad), served as a static module. Build it first (`pnpm --filter patchwork-cad build`). */
export const CAD_DIR = join(HARNESS_DIR, "..", "cad");
export const CAD_MODULES = { cad: CAD_DIR };

/**
 * M1 from the naming benchmark (research/03), written with replicad: a block
 * with a through notch on its front face, the notch's top arc filleted, the
 * front-top edge right of the notch chamfered, and a boss on the front face.
 */
export const M1_SOURCE = (a: number) => `import { drawRectangle, drawCircle } from "replicad";

export default function main() {
  const w = 60, d = 40, h = 20, a = ${a}, r = 8;
  let s = drawRectangle(w, d).translate(w / 2, d / 2).sketchOnPlane("XY").extrude(h);
  s = s.cut(drawCircle(r).translate(a, 0).sketchOnPlane("XY").extrude(h));
  s = s.fillet(1.5, (e) => e.ofCurveType("CIRCLE").inPlane("XY", h));
  s = s.chamfer(1, (e) => e.ofCurveType("LINE").containsPoint([w - 2, 0, h]));
  return s.fuse(drawCircle(2).translate(w - 6, h / 2).sketchOnPlane("XZ").extrude(4));
}
`;

export const cadView = (page: Page) => page.locator(".cad-model");

/** Vertices of the shown mesh, or 0 before the first one. */
export async function vertices(page: Page): Promise<number> {
  return Number((await page.locator(".cad-model__viewer").getAttribute("data-vertices")) ?? 0);
}

/** Replaces the whole model source by typing into the editor (one undoable edit per key). */
export async function replaceSource(page: Page, source: string): Promise<void> {
  // Focus rather than click: in the editor's narrow code pane, the center of long lines is scrolled out of view.
  await editor(page).focus();
  await pressMod(page, "a");
  await page.keyboard.press("Delete");
  // insertText skips CodeMirror's auto-indent and bracket closing, so the text arrives verbatim.
  await page.keyboard.insertText(source);
}

export type EntityKind = "face" | "edge";
export interface Entity {
  body: string;
  kind: EntityKind;
  index: number;
}

interface ViewerHook {
  cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; entities(kind: EntityKind): Entity[] };
}

/** The open document's URL fragment parameters. */
const hashParams = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));

/** Switches the open document to another tool, as the tool picker does (`#doc=…&tool=…`). */
export async function openWithTool(page: Page, toolId: string): Promise<void> {
  const params = hashParams(page);
  params.set("tool", toolId);
  await page.evaluate((hash) => (location.hash = hash), params.toString());
}

/** Opens the code pane of the editor (the default tool), unless it is open. */
export async function openCode(page: Page): Promise<void> {
  const toggle = page.locator(".cad-editor__toolbar").getByRole("button", { name: "Code" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await page.locator(".cad-model__code .cm-content").waitFor();
}

/** Hides Patchwork's document and context sidebars, which leaves the tool the whole width, e.g. for a long timeline. */
export async function hideSidebars(page: Page): Promise<void> {
  for (const name of ["Hide sidebar", "Hide context sidebar"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible()) await button.click();
  }
}

/** Creates a CAD model through the create-new menu; it opens in the default tool, or then in `tool`. */
export async function createModel(page: Page, tool?: string): Promise<void> {
  await createViaMenu(page, "CAD Model");
  if (tool) await openWithTool(page, tool);
}

/** The path that opens the current document, in `tool` if given. */
export function docPathWith(page: Page, tool?: string): string {
  const params = hashParams(page);
  if (tool) params.set("tool", tool);
  else params.delete("tool");
  return `/#${params.toString()}`;
}

/** The open document's automerge URL. */
export const docUrl = (page: Page) => hashParams(page).get("doc")!;

/** Reloads the page once the tab's repo has stored every change, so that the reload can't lose a recent one. */
export async function reloadStored(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { repo: { flush(): Promise<void> } }).repo.flush());
  await page.reload();
}

/** The model source, read from the tab's repo. */
export async function modelSource(page: Page): Promise<string> {
  return page.evaluate(async (url) => {
    const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): { source: string } }> } }).repo;
    return (await repo.find(url)).doc().source;
  }, docUrl(page));
}

/**
 * Changes the model source through the tab's repo. By default with `updateText`, which splices only
 * the changed characters, as typing them would; "replace" assigns the string, which replaces the
 * whole text object, as a tool rewriting the file might.
 */
export async function setModelSource(page: Page, source: string, how: "splice" | "replace" = "splice"): Promise<void> {
  await page.evaluate(
    async ([url, text, mode]) => {
      const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(fn: (d: { source: string }) => void): void }> } }).repo;
      // The page's importmap provides the same automerge as the repo's.
      const specifier = "@automerge/automerge";
      const { updateText } = (await import(specifier)) as { updateText(d: unknown, path: string[], text: string): void };
      (await repo.find(url!)).change((d) => (mode === "replace" ? (d.source = text!) : updateText(d, ["source"], text!)));
    },
    [docUrl(page), source, how],
  );
}

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();

/** The pickable entities the viewer shows. */
export async function entities(page: Page, kind: EntityKind): Promise<Entity[]> {
  return viewer(page).evaluate((el, k) => (el as unknown as ViewerHook).cadViewer.entities(k), kind);
}

/** Clicks the pixel where the viewer's raycasting finds the entity, as a user would. */
export async function clickEntity(page: Page, entity: Entity): Promise<void> {
  const point = await viewer(page).evaluate((el, e) => (el as unknown as ViewerHook).cadViewer.screenPoint(e), entity);
  if (!point) throw new Error(`entity ${JSON.stringify(entity)} is not visible`);
  await page.mouse.click(point.x, point.y);
}

/** Whether an entity is visible and clickable. */
export async function isVisible(page: Page, entity: Entity): Promise<boolean> {
  return viewer(page).evaluate((el, e) => (el as unknown as ViewerHook).cadViewer.screenPoint(e) !== undefined, entity);
}

export const editorView = (page: Page) => page.locator(".cad-model--editor");
export const timelineEntry = (page: Page, name: string) => page.locator(`.cad-editor__entry[data-name="${name}"]`);
export const dialog = (page: Page) => page.locator(".cad-editor__dialog");

/** Picks the visible entity of `kind` whose centroid is nearest to `near`, by clicking it. */
export async function pickNear(page: Page, kind: EntityKind, near: [number, number, number], body?: string): Promise<Entity> {
  const candidates = (await entities(page, kind)).filter((e) => !body || e.body === body);
  const scored: { e: Entity; d: number }[] = [];
  for (const e of candidates) {
    const c = await viewer(page).evaluate((el, x) => (el as unknown as { cadViewer: { centroid(e: Entity): number[] | undefined } }).cadViewer.centroid(x), e);
    if (c) scored.push({ e, d: Math.hypot(c[0]! - near[0], c[1]! - near[1], c[2]! - near[2]) });
  }
  scored.sort((a, b) => a.d - b.d);
  for (const { e } of scored) {
    if (!(await isVisible(page, e))) continue;
    await clickEntity(page, e);
    return e;
  }
  throw new Error(`no visible ${kind} near ${near.join(", ")}`);
}

/** Types an expression into a dialog field and commits it. */
export async function setField(page: Page, label: string, value: string): Promise<void> {
  const input = dialog(page).getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press("Enter");
}

export async function chooseField(page: Page, label: string, value: string): Promise<void> {
  await dialog(page).getByLabel(label, { exact: true }).selectOption(value);
}

export const toolbarButton = (page: Page, label: string) => page.locator(".cad-editor__toolbar").getByRole("button", { name: label, exact: true });

/** An example model of the feature library (src/features/examples), with `replace` applied to it. */
export function exampleSource(name: "m1" | "m3", replace: [string, string][] = []): string {
  let source = readFileSync(join(CAD_DIR, "..", "features", "examples", `${name}.js`), "utf8");
  for (const [from, to] of replace) {
    if (!source.includes(from)) throw new Error(`${name}.js has no ${from}`);
    source = source.replace(from, to);
  }
  return source;
}

/** A ViewCube region: a face, edge or corner as the sign of each axis, e.g. [0, -1, 0] for Front. */
export type Region = [number, number, number];

interface CameraHook {
  cadViewer: { viewCubePoint(r: Region): { x: number; y: number } | undefined; cameraDirection(): [number, number, number] };
}

/** Expands a viewer's ViewCube if it is collapsed, as in the viewer tool. */
export async function expandViewCube(target: Locator): Promise<void> {
  const toggle = target.getByRole("button", { name: "ViewCube" });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

/** Clicks a region of the ViewCube, which must face the camera, and waits until the camera looks from it. */
export async function clickViewCube(page: Page, region: Region): Promise<void> {
  await expandViewCube(viewer(page));
  const point = await viewer(page).evaluate((el, r) => (el as unknown as CameraHook).cadViewer.viewCubePoint(r), region);
  if (!point) throw new Error(`ViewCube region ${region.join(",")} isn't visible`);
  await page.mouse.click(point.x, point.y);
  await expect(viewer(page)).toHaveAttribute("data-turning", "false");
}

/** Clicks the ViewCube's Home button and waits until the camera is there. */
export async function clickHome(page: Page): Promise<void> {
  await expandViewCube(viewer(page));
  await viewer(page).getByRole("button", { name: "Home view" }).click();
  await expect(viewer(page)).toHaveAttribute("data-turning", "false");
}

/** The direction from the orbit target to the camera. */
export async function cameraDirection(page: Page): Promise<[number, number, number]> {
  return viewer(page).evaluate((el) => (el as unknown as CameraHook).cadViewer.cameraDirection());
}
