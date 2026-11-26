/**
 * Feature caching (research/24-feature-caching.md): a build reruns only the features an edit
 * changes, and what it shows, picks and names is what a build without the cache shows after a reload.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, createModel, editorView, entities, exampleSource, hideSidebars, reloadStored, setModelSource, timelineEntry, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
const reference = (page: Page) => page.locator(".cad-model__reference code");
/** The features the last build ran rather than reused. */
const ran = async (page: Page) => (JSON.parse((await cadView(page).getAttribute("data-features")) ?? "{}") as { ran?: string[] }).ran;

interface Hook {
  cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; centroid(e: Entity): number[] | undefined };
}

/** What the view shows: every face and edge, by body and index, with its centroid, and the mesh's vertices. */
async function shown(page: Page) {
  const all = [...(await entities(page, "face")), ...(await entities(page, "edge"))];
  const centroids = await viewer(page).evaluate((el, es) => es.map((e) => (el as unknown as Hook).cadViewer.centroid(e)?.map((x) => x.toFixed(4))), all);
  return { entities: all.map((e, i) => `${e.body}:${e.kind}:${e.index} ${centroids[i]?.join(",")}`), vertices: await viewer(page).getAttribute("data-vertices") };
}

/** Hovers the faces until the status bar names one `name`, and gives its reference. */
async function referenceOf(page: Page, name: string): Promise<string> {
  for (const e of await entities(page, "face")) {
    const point = await viewer(page).evaluate((el, x) => (el as unknown as Hook).cadViewer.screenPoint(x), e);
    if (!point) continue;
    await page.mouse.move(point.x, point.y);
    if ((await viewer(page).getAttribute("data-hovered")) !== `${e.body}:face:${e.index}`) continue;
    const text = (await reference(page).textContent()) ?? "";
    if (text.startsWith(name)) return `${e.body}:${e.index} ${text}`;
  }
  throw new Error(`no face named ${name}…`);
}

const M1 = ["sketch1", "extrude1", "sketch2", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"];

test("an edit reruns the features it changes, and gives what a build without the cache gives", async ({ users }) => {
  test.setTimeout(180_000);
  const [user] = await users(1);
  const { page } = user!;
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  // The new model's seed has built, so that its first sketch, which is M1's, is in the cache.
  await expect(timelineEntry(page, "bore")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await setModelSource(page, exampleSource("m1"));
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect.poll(() => ran(page)).toEqual(M1.slice(1));

  // The chamfer, the sketch on the face it changes and the boss on that sketch; the rest is reused.
  const edited = exampleSource("m1", [["], distance: 1 });", "], distance: 1.5 });"]]);
  await setModelSource(page, edited);
  await expect.poll(() => ran(page)).toEqual(["chamfer1", "sketch3", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  const cached = await shown(page);
  const picked = await referenceOf(page, "extrude1.side.front.piece(notch, 2");
  // Rolled back before the fillet: the bodies of the last build, two of them reused.
  await timelineEntry(page, "fillet1").click();
  await expect.poll(async () => (await entities(page, "face")).length).toBeGreaterThan(0);
  const rolledBack = await shown(page);

  // A reload starts a new kernel, whose first build reuses nothing.
  await reloadStored(page);
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect.poll(() => ran(page)).toEqual(M1);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  expect(await shown(page)).toEqual(cached);
  expect(await referenceOf(page, "extrude1.side.front.piece(notch, 2")).toBe(picked);
  await timelineEntry(page, "fillet1").click();
  await expect.poll(async () => (await entities(page, "face")).length).toBeGreaterThan(0);
  expect(await shown(page)).toEqual(rolledBack);
});
