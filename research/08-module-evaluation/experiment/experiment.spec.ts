import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { models, type ModelName } from "./src/models.ts";
import { M1_STEPS, type DirectMode, type Variant, type WorkerReply } from "./src/protocol.ts";

type Built = Extract<WorkerReply, { type: "built" }>;
type Probed = Extract<WorkerReply, { type: "probed" }>;

const VARIANTS: Variant[] = ["as-is", "memo"];
const MODELS: ModelName[] = ["inMain", "topLevel"];
/** Builds per worker for the timing and counting runs. */
const BUILDS = 20;
/** Builds per worker for the retention runs, probed every PROBE_EVERY builds. */
const RETENTION_BUILDS = 200;
const PROBE_EVERY = 25;

async function start(page: Page, variant: Variant): Promise<number> {
  const reply = await page.evaluate((v) => window.experiment.start(v), variant);
  if (reply.type !== "ready") throw new Error(`unexpected ${reply.type}`);
  return reply.wasmBytes;
}

async function build(page: Page, source: string): Promise<Built> {
  const reply = await page.evaluate((s) => window.experiment.build(s), source);
  if (reply.type !== "built") throw new Error(`unexpected ${reply.type}`);
  expect(reply.error, "every build succeeds").toBeUndefined();
  return reply;
}

async function probe(page: Page): Promise<Probed> {
  const reply = await page.evaluate(() => window.experiment.probe());
  if (reply.type !== "probed") throw new Error(`unexpected ${reply.type}`);
  return reply;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;
const mb = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

test("module evaluations per build, their cost, and module retention", async ({ page, browserName }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("ready");

  // 1. Evaluations and cost: a fresh worker per variant and model; the first
  // build is a warm-up and not counted.
  const runs: Record<string, unknown>[] = [];
  for (const variant of VARIANTS) {
    for (const model of MODELS) {
      await start(page, variant);
      await build(page, models[model](-1));
      const builds: Built[] = [];
      for (let i = 0; i < BUILDS; i++) builds.push(await build(page, models[model](i)));
      runs.push({
        variant,
        model,
        importsPerBuild: [...new Set(builds.map((b) => b.imports))],
        topLevelRunsPerBuild: [...new Set(builds.map((b) => b.topLevelRuns))],
        medianMs: Math.round(median(builds.map((b) => b.ms)) * 10) / 10,
      });
    }
  }

  // 2. Retention: are modules of earlier builds, and the OCCT memory their
  // top-level shapes hold, ever released?
  const retention: Record<string, unknown>[] = [];
  for (const variant of VARIANTS) {
    for (const model of MODELS) {
      const initial = await start(page, variant);
      const samples: { builds: number; modulesAlive: number; modulesTotal: number; wasmMB: number; collected: boolean; canary: boolean }[] = [];
      for (let i = 1; i <= RETENTION_BUILDS; i++) {
        await build(page, models[model](i));
        if (i % PROBE_EVERY === 0) {
          const p = await probe(page);
          samples.push({ builds: i, modulesAlive: p.modulesAlive, modulesTotal: p.modulesTotal, wasmMB: mb(p.wasmBytes), collected: p.collected, canary: p.canaryCollected && p.canaryFinalized });
        }
      }
      retention.push({ variant, model, initialWasmMB: mb(initial), samples });
    }
  }

  // 3. Control: the same M1, built by worker code without evaluator or modules,
  // with a forced collection every PROBE_EVERY builds or after every build.
  const control: Record<string, unknown>[] = [];
  for (const gcEvery of [PROBE_EVERY, 1]) {
    for (const mode of ["build", "build+mesh", "build+mesh+delete"] satisfies DirectMode[]) {
      const initial = await start(page, "as-is");
      const samples: { builds: number; wasmMB: number }[] = [];
      for (let i = 1; i <= RETENTION_BUILDS; i++) {
        const reply = await page.evaluate((m) => window.experiment.direct(m), mode);
        if (reply.type !== "direct-built") throw new Error(`unexpected ${reply.type}`);
        if (i % gcEvery === 0) {
          const { wasmBytes } = await probe(page);
          if (i % PROBE_EVERY === 0) samples.push({ builds: i, wasmMB: mb(wasmBytes) });
        }
      }
      control.push({ mode, gcEvery, initialWasmMB: mb(initial), samples });
    }
  }

  // 4. Bisection: which of M1's operations leaves memory behind? GC after every build.
  const bisection: Record<string, unknown>[] = [];
  for (const until of M1_STEPS) {
    const initial = await start(page, "as-is");
    const samples: { builds: number; wasmMB: number }[] = [];
    for (let i = 1; i <= RETENTION_BUILDS; i++) {
      const reply = await page.evaluate((u) => window.experiment.direct("build+mesh+delete", u), until);
      if (reply.type !== "direct-built") throw new Error(`unexpected ${reply.type}`);
      const { wasmBytes } = await probe(page);
      if (i % PROBE_EVERY === 0) samples.push({ builds: i, wasmMB: mb(wasmBytes) });
    }
    bisection.push({ until, initialWasmMB: mb(initial), samples });
  }

  const result = { browser: browserName, userAgent: await page.evaluate(() => navigator.userAgent), runs, retention, control, bisection };
  await writeFile(join(import.meta.dirname, `results-${browserName}.json`), JSON.stringify(result, null, 2) + "\n");
  await testInfo.attach("result.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});

// 5. Leak or bounded pool? Full M1, built, meshed and deleted by worker code
// 1000 times, with a collection after every build.
test("OCCT heap over 1000 direct M1 builds", async ({ page, browserName }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("ready");
  const initial = await start(page, "as-is");
  const samples: { builds: number; wasmMB: number }[] = [];
  for (let i = 1; i <= 1000; i++) {
    const reply = await page.evaluate(() => window.experiment.direct("build+mesh+delete"));
    if (reply.type !== "direct-built") throw new Error(`unexpected ${reply.type}`);
    const { wasmBytes } = await probe(page);
    if (i % 100 === 0) samples.push({ builds: i, wasmMB: mb(wasmBytes) });
  }
  const result = { browser: browserName, initialWasmMB: mb(initial), samples };
  await writeFile(join(import.meta.dirname, `results-long-${browserName}.json`), JSON.stringify(result, null, 2) + "\n");
  await testInfo.attach("result.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
