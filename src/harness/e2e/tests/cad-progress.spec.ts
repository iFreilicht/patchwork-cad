/**
 * Build progress (research/23-build-progress.md): a slow build reports each feature, so the kernel's
 * watchdog limits one feature, not the build; after a delay the status bar shows the running feature,
 * a bar and Abort, the timeline and the code pane what the build is doing, and Abort stops it.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, createModel, openCode, setModelSource, timelineEntry, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

/** The kernel watchdog's limit in these tests; each feature below stays under it, the builds don't. */
const TIMEOUT_MS = 5000;

/** Three boxes adopted with body(), each busy for its ms first, as a slow kernel call would be. */
const slow = (a: number, b: number, c: number, x = 10) => `import { drawRectangle } from "replicad";
import { body } from "@patchwork-cad/features";

const busy = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

export default function main() {
  const a = body(() => {
    busy(${a});
    return drawRectangle(5, 5).sketchOnPlane().extrude(5);
  });
  const b = body(() => {
    busy(${b});
    return drawRectangle(5, 5).sketchOnPlane().extrude(5).translate(${x}, 0, 0);
  });
  const c = body(() => {
    busy(${c});
    return drawRectangle(5, 5).sketchOnPlane().extrude(5).translate(${2 * x}, 0, 0);
  });
  return [a, b, c];
}
`;

const status = (page: Page) => page.locator(".cad-model__status");
const progress = (page: Page) => page.locator(".cad-model__progress");
const bar = (page: Page) => page.getByRole("progressbar", { name: "Build progress" });
const restarts = async (page: Page) => Number((await cadView(page).getAttribute("data-kernel-restarts")) ?? 0);
const executed = async (page: Page) => Number((await cadView(page).getAttribute("data-builds-executed")) ?? 0);

async function openModel(page: Page): Promise<void> {
  await page.addInitScript((ms) => void ((globalThis as { patchworkCadTimeout?: number }).patchworkCadTimeout = ms), TIMEOUT_MS);
  await bootToFrame(page);
  await createModel(page);
  await openCode(page);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
}

test("a slow build shows its progress and outlives the watchdog", async ({ users }) => {
  test.setTimeout(120_000);
  const [user] = await users(1);
  const { page } = user!;
  await openModel(page);
  const before = await restarts(page);

  // 3 × 2 s: longer than the watchdog's limit, which each feature stays under.
  await setModelSource(page, slow(2000, 2000, 2000));
  await expect(status(page)).toContainText("Building…");
  // The first build of this model has no feature times to estimate with: the bar only moves.
  await expect(bar(page)).toHaveAttribute("data-indeterminate", "true");
  await expect(progress(page).locator(".cad-model__progress-feature")).toHaveText("a");
  await expect(timelineEntry(page, "a")).toHaveAttribute("data-build", "running");
  await expect(timelineEntry(page, "c")).toHaveAttribute("data-build", "waiting");
  await expect(page.locator(".cad-model__code .cm-line[data-running]")).toHaveText("  const a = body(() => {");
  await expect(timelineEntry(page, "b")).toHaveAttribute("data-build", "running", { timeout: 5000 });
  await expect(timelineEntry(page, "a")).toHaveAttribute("data-build", "done");
  await expect(progress(page).getByRole("button", { name: "Abort" })).toBeVisible();

  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(await restarts(page)).toBe(before);
  await expect(progress(page)).toHaveCount(0);
  await expect(timelineEntry(page, "c")).not.toHaveAttribute("data-build", /./);
  await expect(status(page)).toContainText(/build \d+\.\d s, slowest [abc] 2\.\d s/);

  // The next build is estimated from this one's feature times.
  await setModelSource(page, slow(2000, 2000, 2000, 12));
  await expect(bar(page)).toHaveAttribute("aria-valuenow", /\d+/);
  const early = Number(await bar(page).getAttribute("aria-valuenow"));
  await expect.poll(async () => Number(await bar(page).getAttribute("aria-valuenow")), { timeout: 10_000 }).toBeGreaterThan(early + 20);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
});

test("Abort stops a slow build and keeps the last result", async ({ users }) => {
  test.setTimeout(120_000);
  const [user] = await users(1);
  const { page } = user!;
  await openModel(page);
  await setModelSource(page, slow(0, 0, 0));
  await expect.poll(() => page.locator(".cad-editor__entry").count()).toBe(3);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  const shown = await vertices(page);
  const before = await restarts(page);

  // c would take 60 s, longer than the watchdog allows; Abort stops it before.
  await setModelSource(page, slow(0, 0, 60_000));
  await expect(timelineEntry(page, "c")).toHaveAttribute("data-build", "running");
  await progress(page).getByRole("button", { name: "Abort" }).click();
  await expect(cadView(page)).toHaveAttribute("data-state", "error");
  await expect(status(page)).toContainText("the build was aborted");
  expect(await restarts(page)).toBe(before + 1);
  expect(await vertices(page)).toBe(shown);
  // The features that were done keep their status; the one that didn't finish didn't run.
  await expect(timelineEntry(page, "a")).toHaveAttribute("data-status", "ok");
  await expect(timelineEntry(page, "c")).toHaveAttribute("data-status", "not-run");
  // Nothing builds until the next edit, which does. The count is read once a result is shown.
  const builds = await executed(page);
  await page.waitForTimeout(500);
  expect(await executed(page)).toBe(builds);
  await setModelSource(page, slow(0, 0, 0, 12));
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(timelineEntry(page, "c")).toHaveAttribute("data-status", "ok");
});
