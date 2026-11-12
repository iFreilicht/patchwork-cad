/**
 * Framing (research/20-view-framing.md): a camera keeps showing what it showed when the view is
 * resized, a camera that shows the whole model keeps its margins around it, the user's own camera
 * follows a changed model only when it left the view or shrank to less than half, a view of a
 * close-up follows the faces it shows, and cameras stored before research/20 still show.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cameraDirection, clickHome, clickViewCube, createModel, docUrl, editorView, hideSidebars, setModelSource } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

/** A flat bar, 200 × 40 × 10 at scale 1, centred on the origin. */
const bar = (scale: number) => `import { drawRectangle } from "replicad";

export default function main() {
  return drawRectangle(${200 * scale}, ${40 * scale}).sketchOnPlane("XY").extrude(${10 * scale});
}
`;

/** A 200 × 200 plate with a boss of radius 5 on top at x = `a`, built with the feature library, so that its faces have names. */
const plate = (a: number) => `import { sketch, plane, rect, circle, extrude } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [-100, -100], to: [100, 100] }) });
  const plate = extrude({ sketch: sketch1, distance: 5 });
  const sketch2 = sketch({ plane: plane("XY", 5), profile: circle({ center: [${a}, 0], radius: 5 }) });
  const boss = extrude({ sketch: sketch2, distance: 5, operation: "join", target: plate });
  return { plate: boss };
}
`;

interface FramingHook {
  cadViewer: {
    onScreen(points?: [number, number, number][]): { inView: boolean; fill: number; center: [number, number] };
    intent(): { fit?: number[]; subject?: { faces: unknown[] }; extent: [number, number]; direction: number[] } | undefined;
    eye(): [number, number, number];
  };
}
const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
const onScreen = (page: Page, points?: [number, number, number][]) => viewer(page).evaluate((el, p) => (el as unknown as FramingHook).cadViewer.onScreen(p), points);
const intent = (page: Page) => viewer(page).evaluate((el) => (el as unknown as FramingHook).cadViewer.intent());
const eye = (page: Page) => viewer(page).evaluate((el) => (el as unknown as FramingHook).cadViewer.eye());

/** Replaces the model and waits for its build. */
async function build(page: Page, source: string): Promise<void> {
  const view = editorView(page);
  const builds = async () => Number(await view.getAttribute("data-builds-executed"));
  const before = await builds();
  await setModelSource(page, source, "replace");
  await expect.poll(builds).toBeGreaterThan(before);
  await expect(view).toHaveAttribute("data-state", "ready");
  await expect(viewer(page)).toHaveAttribute("data-turning", "false");
}

/** Dollies the camera with the mouse wheel over the view's centre: negative `delta` closer. */
async function dolly(page: Page, delta: number): Promise<void> {
  const box = await viewer(page).locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
}

async function open(page: Page, source: string): Promise<void> {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await build(page, source);
}

/** Points on the boss of `plate(x)`: around its top and bottom. */
const boss = (x: number): [number, number, number][] => [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [5, 10].map((z): [number, number, number] => [x + 5 * Math.cos((i * Math.PI) / 4), 5 * Math.sin((i * Math.PI) / 4), z]));

/**
 * How much of the view the model spans on one axis with the default margin of 0.1 on each side:
 * 1 / 1.2 in the plane through the model's middle, which perspective makes a little more or less on the screen.
 */
const FITTED = 1 / 1.2;
const fitted = (fill: number) => Math.abs(fill - FITTED) < 0.04;

test("a resized view keeps showing the whole model, with its margins", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, bar(1));
  await clickHome(page);
  await expect.poll(async () => fitted((await onScreen(page)).fill)).toBe(true);
  const home = (await onScreen(page)).fill;
  const homeEye = await eye(page);

  // Taller than wide, as in the screenshots of research/20: the bar still fits, as wide as before relative to the view.
  await page.setViewportSize({ width: 1000, height: 1400 });
  await expect.poll(async () => {
    const box = await viewer(page).locator("canvas").boundingBox();
    return box && box.height > box.width * 1.2;
  }).toBe(true);
  await expect.poll(async () => fitted((await onScreen(page)).fill)).toBe(true);
  expect((await onScreen(page)).inView).toBe(true);
  // The eye stays, so the perspective does; the field of view widens.
  expect(await eye(page)).toEqual(homeEye.map((c) => expect.closeTo(c, 6)));

  // The user's own camera keeps the margins it had when the dolly ended.
  await dolly(page, 400);
  await expect.poll(async () => (await intent(page))?.fit).toBeTruthy();
  const zoomedOut = (await onScreen(page)).fill;
  expect(zoomedOut).toBeLessThan(home - 0.05);
  const ownEye = await eye(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => (await eye(page))[0]).toBeCloseTo(ownEye[0], 6);
  expect(await eye(page)).toEqual(ownEye.map((c) => expect.closeTo(c, 6)));
  // As large as before, up to perspective, which shows the plane through the model's middle as kept.
  await expect.poll(async () => Math.abs((await onScreen(page)).fill - zoomedOut)).toBeLessThan(0.04);
  expect((await onScreen(page)).inView).toBe(true);
});

test("a changed model is framed again: a given camera exactly, the user's own only when it left the view or shrank to less than half", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, bar(1));

  // Home is given: it fits the half-size bar as it fit the bar.
  await clickHome(page);
  const home = (await onScreen(page)).fill;
  expect(fitted(home)).toBe(true);
  await build(page, bar(0.5));
  await expect.poll(async () => (await onScreen(page)).fill).toBeCloseTo(home, 2);

  // The user's own camera, after a dolly, stays while the bar grows within its margins or shrinks a little.
  await dolly(page, 400);
  await expect.poll(async () => (await intent(page))?.fit).toBeTruthy();
  const own = (await onScreen(page)).fill;
  const camera = await intent(page);
  await build(page, bar(0.55));
  expect(await intent(page)).toEqual(camera);
  expect((await onScreen(page)).fill).toBeGreaterThan(own);
  await build(page, bar(0.3));
  expect(await intent(page)).toEqual(camera);
  expect((await onScreen(page)).fill).toBeLessThan(own);
  // Less than half of what it framed: it shows the bar with its margins again.
  await build(page, bar(0.2));
  await expect.poll(async () => (await onScreen(page)).fill).toBeCloseTo(own, 2);
  // Out of the view: the same.
  await build(page, bar(2));
  await expect.poll(async () => (await onScreen(page)).fill).toBeCloseTo(own, 2);
  expect((await onScreen(page)).inView).toBe(true);
});

test("a view of a close-up follows the faces it shows", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, plate(0));
  await clickViewCube(page, [0, 0, 1]);

  // Close to the boss in the plate's middle: the plate is cut off, the boss's faces are its subject.
  await dolly(page, -3500);
  await expect.poll(async () => (await intent(page))?.subject?.faces.length ?? 0).toBeGreaterThan(0);
  expect((await intent(page))?.fit).toBeUndefined();
  const views = page.locator(".cad-editor__browser").getByRole("list", { name: "Views" });
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  await views.locator(".cad-editor__rename").fill("Boss");
  await views.locator(".cad-editor__rename").press("Enter");
  const row = views.locator('.cad-editor__named-row[data-name="Boss"]');
  await expect(row).toHaveAttribute("data-current", "true");

  // The boss moves; the user's own close-up stays where it is, as the plate is still in it.
  await build(page, plate(60));
  expect((await onScreen(page, boss(60))).inView).toBe(false);

  // Going to the view finds the boss again, in the middle and as large as before.
  await clickViewCube(page, [1, -1, 1]);
  await row.getByRole("button", { name: "Boss" }).click();
  await expect.poll(async () => (await onScreen(page, boss(60))).inView).toBe(true);
  const { center, fill } = await onScreen(page, boss(60));
  expect(Math.hypot(...center)).toBeLessThan(0.05);
  expect(fill).toBeGreaterThan(0.2);
  expect(await cameraDirection(page)).toEqual([0, 0, 1].map((c) => expect.closeTo(c, 2)));
});

test("a camera stored before research/20 shows its old height, and frames the model as it changes if it showed all of it", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, bar(1));
  const url = docUrl(page);
  await page.evaluate(async (u) => {
    const repo = (window as unknown as { repo: { find(url: string): Promise<{ change(f: (d: { cad?: { home?: unknown } }) => void): void }> } }).repo;
    (await repo.find(u)).change((d) => {
      d.cad ??= {};
      d.cad.home = { direction: [0, -1, 0], target: [0, 0, 5], distance: 300, projection: "perspective", zoom: 1 };
    });
  }, url);
  await clickHome(page);
  expect(await cameraDirection(page)).toEqual([0, 1, 0].map((c) => expect.closeTo(-c, 6)));
  const height = 2 * 300 * Math.tan(Math.PI / 8);
  expect((await intent(page))?.extent).toEqual([expect.closeTo(height, 6), expect.closeTo(height, 6)]);
  expect(await eye(page)).toEqual([0, -300, 5].map((c) => expect.closeTo(c, 6)));
  // It showed all of the bar, so it keeps its margins around it: twice as long, the bar still shows whole.
  await expect.poll(async () => (await intent(page))?.fit).toBeTruthy();
  await build(page, bar(2));
  await expect.poll(async () => (await onScreen(page)).inView).toBe(true);
});
