import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { CAD_MODULES, M1_SOURCE, cadView, createModel, openCode, replaceSource } from "../cad.ts";
import { firefoxLaunchOptions } from "../firefox.ts";
import { expect, LOOPBACK, test } from "../fixtures.ts";
import { bootToFrame, docPath, editor } from "../ui.ts";

// Timings for research/06. Run alone, so that nothing else competes for the CPU:
//   CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-measure
test.skip(!process.env["CAD_MEASURE"], "set CAD_MEASURE=1 to measure");
test.use({ siteModules: CAD_MODULES });

const REPEAT = 5;

interface Build {
  build: number;
  total: number;
}

const executed = async (page: Page) => Number((await cadView(page).getAttribute("data-builds-executed")) ?? 0);
const requested = async (page: Page) => Number((await cadView(page).getAttribute("data-builds-requested")) ?? 0);

/** Waits until the view has finished a build after `before` executed builds, and returns its timings. */
async function nextBuild(page: Page, before: number): Promise<Build> {
  await expect.poll(() => executed(page), { timeout: 60_000 }).toBeGreaterThan(before);
  await expect(cadView(page)).toHaveAttribute("data-state", /^(ready|error)$/, { timeout: 60_000 });
  return JSON.parse((await cadView(page).getAttribute("data-build")) ?? "null") as Build;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
};
const summary = (values: number[]) => ({ median: Math.round(median(values)), min: Math.round(Math.min(...values)), max: Math.round(Math.max(...values)), n: values.length });

test("CAD load, re-run and burst timings", async ({ users, localStack, browserName, playwright, egress }, testInfo) => {
  test.setTimeout(900_000);
  const [author] = await users(1);
  if (!author) throw new Error("users(1) returned no user");
  await bootToFrame(author.page);
  await createModel(author.page);
  await openCode(author.page);
  await expect(cadView(author.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const doc = docPath(author.page);
  const wasmRequests = () => localStack.siteRequests.filter((r) => r.path.endsWith(".wasm") && r.path.includes("replicad_single")).length;

  // Loads in two kinds of profile, because each lacks a cache in one browser
  // (Playwright 1.59.1): in default (off-the-record) contexts, Chromium's HTTP
  // cache refetches the 23 MB wasm on every load; in persistent contexts,
  // WebKit's Cache API stores nothing. Cold: a fresh profile opens the doc.
  // Reload: the same page reloads. Restart (persistent only): the browser is
  // closed and reopened on the same profile.
  type Kind = "cold" | "reload" | "restart";
  const loads: Record<string, { shown: number[]; compile: number[]; instantiate: number[]; wasmFetched: number[]; cached: boolean[] }> = {};
  const measure = async (key: string, page: Page, kind: Kind, open: () => Promise<void>) => {
    const before = wasmRequests();
    const start = Date.now();
    await open();
    await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
    const init = JSON.parse((await cadView(page).getAttribute("data-init")) ?? "{}") as { compile: number; instantiate: number; cached: boolean };
    const load = (loads[`${key} ${kind}`] ??= { shown: [], compile: [], instantiate: [], wasmFetched: [], cached: [] });
    load.shown.push(Date.now() - start);
    load.compile.push(init.compile);
    load.instantiate.push(init.instantiate);
    load.wasmFetched.push(wasmRequests() - before);
    load.cached.push(init.cached);
  };
  for (let i = 0; i < REPEAT; i++) {
    const [user] = await users(1);
    if (!user) throw new Error("users(1) returned no user");
    await measure("default", user.page, "cold", () => bootToFrame(user.page, doc));
    await measure("default", user.page, "reload", () => user.page.reload().then(() => undefined));
    await user.context.close();

    const profile = await mkdtemp(join(tmpdir(), "cad-measure-profile-"));
    const launch = async () => {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        ...(browserName === "firefox" ? firefoxLaunchOptions() : {}),
        baseURL: localStack.siteUrl,
        serviceWorkers: "allow",
        proxy: { server: egress.proxyUrl, bypass: LOOPBACK },
        viewport: { width: 1280, height: 720 },
      });
      return { context, page: context.pages()[0] ?? (await context.newPage()) };
    };
    let { context, page } = await launch();
    await measure("persistent", page, "cold", () => bootToFrame(page, doc));
    await measure("persistent", page, "reload", () => page.reload().then(() => undefined));
    await context.close();
    ({ context, page } = await launch());
    await measure("persistent", page, "restart", () => bootToFrame(page, doc));
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }

  // Re-runs: alternate between two variants, so that every edit is a real change.
  const page = author.page;
  const rerun = async (variants: [string, string]) => {
    const builds: Build[] = [];
    for (let i = 0; i < 2 * REPEAT; i++) {
      const before = await executed(page);
      await replaceSource(page, variants[i % 2]!);
      builds.push(await nextBuild(page, before));
      await expect(cadView(page), "every variant builds without error").toHaveAttribute("data-state", "ready");
    }
    return { total: summary(builds.map((b) => b.total)), build: summary(builds.map((b) => b.build)) };
  };
  const seed = (width: number) =>
    `import { drawRoundedRectangle, drawCircle } from "replicad";\n\nexport const defaultParams = { width: ${width}, depth: 40, height: 12, hole: 8 };\n\nexport default function main({ width, depth, height, hole }) {\n  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);\n  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);\n  return plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));\n}\n`;
  const seedRuns = await rerun([seed(60), seed(61)]);
  const m1Runs = await rerun([M1_SOURCE(30), M1_SOURCE(25)]);

  // Bursts: type a comment character by character, each key a new source.
  const bursts = [];
  for (const delay of [40, 10]) {
    await replaceSource(page, M1_SOURCE(30));
    await nextBuild(page, (await executed(page)) - 1);
    const [requestedBefore, executedBefore] = [await requested(page), await executed(page)];
    await editor(page).click();
    const text = "// a comment typed into the model\n";
    const start = Date.now();
    await page.keyboard.type(text, { delay });
    const typed = Date.now() - start;
    await expect.poll(() => requested(page)).toBeGreaterThanOrEqual(requestedBefore + text.length);
    await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    bursts.push({
      delay,
      keys: text.length,
      requested: (await requested(page)) - requestedBefore,
      executed: (await executed(page)) - executedBefore,
      typedMs: typed,
      settledMs: Date.now() - start,
    });
  }

  const result = {
    browser: browserName,
    loads: Object.fromEntries(
      Object.entries(loads).map(([kind, l]) => [
        kind,
        { shown: summary(l.shown), compile: summary(l.compile), instantiate: summary(l.instantiate), wasmFetched: l.wasmFetched, cached: l.cached },
      ]),
    ),
    rerun: { seed: seedRuns, m1: m1Runs },
    bursts,
  };
  console.log(JSON.stringify(result, null, 2));
  await testInfo.attach("cad-measure.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
