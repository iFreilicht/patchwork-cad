import type { Page } from "@playwright/test";
import { CAD_MODULES, CODE_TOOL, M1_SOURCE, cadView, createModel, exampleSource, replaceSource } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

// Rebuild cost with the feature library, for research/07. Run alone:
//   CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-measure-features
test.skip(!process.env["CAD_MEASURE"], "set CAD_MEASURE=1 to measure");
test.use({ siteModules: CAD_MODULES });

const REPEAT = 10;

const executed = async (page: Page) => Number((await cadView(page).getAttribute("data-builds-executed")) ?? 0);
const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? NaN;
const round = (x: number) => Math.round(x * 10) / 10;

test("rebuild cost of models written with the feature library", async ({ users, browserName }, testInfo) => {
  test.setTimeout(600_000);
  const [user] = await users(1);
  if (!user) throw new Error("users(1) returned no user");
  const { page } = user;
  await bootToFrame(page);
  await createModel(page, CODE_TOOL);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });

  // Alternates between two variants, so that every edit is a real change.
  const rerun = async (variants: [string, string]) => {
    const builds: { total: number; features: number; naming: number }[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const before = await executed(page);
      await replaceSource(page, variants[i % 2]!);
      await expect.poll(() => executed(page), { timeout: 60_000 }).toBeGreaterThan(before);
      await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
      const build = JSON.parse((await cadView(page).getAttribute("data-build"))!) as { total: number };
      const features = JSON.parse((await cadView(page).getAttribute("data-features"))!) as { count: number; ms: number; namingMs: number };
      builds.push({ total: build.total, features: features.ms, naming: features.namingMs });
    }
    return { total: round(median(builds.map((b) => b.total))), features: round(median(builds.map((b) => b.features))), naming: round(median(builds.map((b) => b.naming))) };
  };

  const result = {
    browser: browserName,
    "M1, replicad only": await rerun([M1_SOURCE(30), M1_SOURCE(25)]),
    "M1, library": await rerun([exampleSource("m1"), exampleSource("m1", [["a: 30", "a: 25"]])]),
    "M3, library": await rerun([exampleSource("m3"), exampleSource("m3", [["ribs: [30]", "ribs: [15]"]])]),
    "M3, library, 3 ribs": await rerun([exampleSource("m3", [["ribs: [30]", "ribs: [10, 30, 50]"]]), exampleSource("m3", [["ribs: [30]", "ribs: [12, 30, 50]"]])]),
  };
  console.log(JSON.stringify(result, null, 2));
  await testInfo.attach("cad-measure-features.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
