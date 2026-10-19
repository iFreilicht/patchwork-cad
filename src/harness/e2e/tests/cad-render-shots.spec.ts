/**
 * Screenshots for research/14-edge-contrast.md: M1 with a selected and a hovered edge, from the home
 * view and turned to the back left, in light and dark mode, with and without `prefers-contrast: more`.
 *
 *   CAD_RENDER_SHOTS=<dir> pnpm test:e2e --project=chromium --workers=1 cad-render-shots
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, clickHome, clickViewCube, createModel, entities, exampleSource, hideSidebars, isVisible, reloadStored, setModelSource, timelineEntry, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

const dir = process.env["CAD_RENDER_SHOTS"];
test.skip(!dir, "set CAD_RENDER_SHOTS=<dir> to take the screenshots");
test.use({ siteModules: CAD_MODULES, viewport: { width: 900, height: 700 } });


const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
type Hook = { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; centroid(e: Entity): number[] | undefined } };
/** The visible edge or face whose centroid is nearest to a point of M1 (a 60 × 40 × 20 block, seen from the front right). */
async function edgeNear(page: Page, near: [number, number, number], kind: "edge" | "face" = "edge"): Promise<Entity> {
  let best: { e: Entity; d: number } | undefined;
  for (const e of await entities(page, kind)) {
    const c = await viewer(page).evaluate((el, x) => (el as unknown as Hook).cadViewer.centroid(x), e);
    const d = c ? Math.hypot(c[0]! - near[0], c[1]! - near[1], c[2]! - near[2]) : Infinity;
    if ((!best || d < best.d) && (await isVisible(page, e))) best = { e, d };
  }
  return best!.e;
}
const screenPoint = (page: Page, e: Entity) => viewer(page).evaluate((el, x) => (el as unknown as { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined } }).cadViewer.screenPoint(x), e);

for (const [colorScheme, contrast] of [["dark", "no-preference"], ["light", "no-preference"], ["dark", "more"], ["light", "more"]] as const) {
  const mode = contrast === "more" ? `${colorScheme}-more` : colorScheme;
  test.describe(mode, () => {
    test.use({ colorScheme });

    test(`the 3D view in ${mode} mode`, async ({ users }) => {
      test.setTimeout(600_000);
      const [a] = await users(1);
      if (!a) throw new Error("users(1) returned no user");
      const { page } = a;
      await bootToFrame(page);
      await createModel(page);
      await hideSidebars(page);
      await setModelSource(page, exampleSource("m1"));
      await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
      {
        // Read when the viewer mounts.
        await page.emulateMedia({ contrast });
        await reloadStored(page);
        await hideSidebars(page);
        // The comment button at the selection would cover the edge.
        await page.addStyleTag({ content: ".cad-model__selection-action { display: none !important; }" });
        await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
        await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
        // The same camera every time: the viewer keeps the last one, e.g. the turned one below.
        await clickHome(page);
        // The same edges every time: the geometry is the same.
        await expect.poll(async () => (await entities(page, "edge")).length).toBeGreaterThan(0);
        // Edges between lit faces: the top's front edge left of the notch, and its right edge.
        const selected = await edgeNear(page, [11, 0, 20]);
        const hovered = await edgeNear(page, [60, 20, 20]);
        const s = (await screenPoint(page, selected))!;
        await page.mouse.click(s.x, s.y);
        await expect(viewer(page)).toHaveAttribute("data-selected", `${selected.body}:edge:${selected.index}`);
        const h = (await screenPoint(page, hovered))!;
        await page.mouse.move(h.x, h.y);
        await expect(viewer(page)).toHaveAttribute("data-hovered", `${hovered.body}:edge:${hovered.index}`);
        await page.waitForTimeout(300);
        await viewer(page).screenshot({ path: `${dir}/${mode}.png` });
        // Details around both edges, for the edges themselves.
        const detail = (name: string, p: { x: number; y: number }) => page.screenshot({ path: `${dir}/${mode}-${name}.png`, clip: { x: p.x - 80, y: p.y - 60, width: 160, height: 120 } });
        await detail("selected", s);
        await detail("hovered", h);
        // Hovering the selected edge, and a selected face.
        await page.mouse.move(s.x, s.y);
        await expect(viewer(page)).toHaveAttribute("data-hovered", `${selected.body}:edge:${selected.index}`);
        await page.waitForTimeout(300);
        await detail("selected-hovered", s);
        const top = await edgeNear(page, [45, 25, 20], "face");
        const t = (await screenPoint(page, top))!;
        // Hovered alone first; the edge stays selected.
        await page.mouse.move(t.x, t.y);
        await expect(viewer(page)).toHaveAttribute("data-hovered", `${top.body}:face:${top.index}`);
        await page.waitForTimeout(300);
        await detail("face-hovered", t);
        await page.mouse.click(t.x, t.y);
        await expect(viewer(page)).toHaveAttribute("data-selected", `${top.body}:face:${top.index}`);
        await page.waitForTimeout(300);
        await detail("face-selected-hovered", t);
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
        await detail("face-selected", t);
        // The timeline: sketch2 open, sketch1 hovered; then sketch2 hovered too.
        const timeline = page.locator(".cad-editor__timeline-wrap");
        await timelineEntry(page, "sketch2").click();
        await timelineEntry(page, "sketch1").hover();
        await timeline.screenshot({ path: `${dir}/${mode}-timeline.png` });
        await timelineEntry(page, "sketch2").hover();
        await timeline.screenshot({ path: `${dir}/${mode}-timeline-open-hovered.png` });
        await timelineEntry(page, "sketch2").click();
        // From the back left and above, where the fixed light doesn't reach the faces in view.
        await clickViewCube(page, [-1, 1, 1]);
        await expect(viewer(page)).toHaveAttribute("data-turning", "false");
        await page.mouse.move(5, 5);
        await viewer(page).screenshot({ path: `${dir}/${mode}-turned.png` });
      }
    });
  });
}
