import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PageBuild } from "./src/main.ts";
import type { Mode, ModelName } from "./src/protocol.ts";

const MODES: Mode[] = ["none", "events", "mesh", "throttled", "budget"];

interface Case {
  name: string;
  model: ModelName;
  params: Record<string, unknown>;
  repeat: number;
}
const M3_RIBS = { w: 60, d: 40, t: 8, H: 50, ribs: [10, 30, 50], ribT: 6 };
const PLATE = { n: 12, m: 10, pitch: 12, r: 3, t: 6, fil: 0.8, combine: false };
const CASES: Case[] = [
  { name: "M1", model: "m1", params: { w: 60, d: 40, h: 20, a: 30, r: 8 }, repeat: 10 },
  { name: "M3, 3 ribs", model: "m3", params: M3_RIBS, repeat: 10 },
  { name: "plate 12×10, cuts", model: "plate", params: PLATE, repeat: 3 },
  { name: "plate 16×12, one combine", model: "plate", params: { ...PLATE, n: 16, m: 12, combine: true }, repeat: 3 },
];

const build = (page: Page, model: ModelName, params: Record<string, unknown>, mode: Mode, blockMs = 0): Promise<PageBuild> =>
  page.evaluate(([model, params, mode, blockMs]) => window.experiment.build(model, params, mode, blockMs), [model, params, mode, blockMs] as const);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? NaN;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The longest time the page went without news: between posting, progress messages and the result. */
function longestGap(b: PageBuild): number {
  const times = [b.posted, ...b.progress.map((p) => p.received), b.posted + b.pageMs];
  return Math.max(...times.slice(1).map((t, i) => t - times[i]!));
}

/**
 * Progress estimates for build `b` from the previous build `prev`, at each progress message,
 * against the fraction of the build's time actually elapsed then.
 * - count: features done / features in prev
 * - time: elapsed / (elapsed + prev's ms of the features not yet done, by name + prev's final meshing)
 */
function estimates(prev: PageBuild, b: PageBuild) {
  const start = b.posted;
  const end = b.built.sent;
  const prevMs = new Map(prev.built.trace.map((t) => [t.name, t.ms]));
  const done = new Set<string>();
  const rows = b.progress.map((p) => {
    done.add(p.feature.name);
    const elapsed = p.sent - start;
    let remaining = prev.built.finalMeshMs;
    for (const [name, ms] of prevMs) if (!done.has(name)) remaining += ms;
    return { actual: elapsed / (end - start), count: Math.min(1, done.size / prev.built.trace.length), time: elapsed / (elapsed + remaining), remainingEstimate: remaining, remainingActual: end - p.sent };
  });
  const err = (key: "count" | "time") => rows.map((r) => Math.abs(r[key] - r.actual));
  const half = rows.find((r) => r.actual >= 0.5);
  return {
    features: b.built.trace.length,
    ms: Math.round(end - start),
    countMeanErr: r1(100 * err("count").reduce((s, x) => s + x, 0) / rows.length),
    countMaxErr: r1(100 * Math.max(...err("count"))),
    timeMeanErr: r1(100 * err("time").reduce((s, x) => s + x, 0) / rows.length),
    timeMaxErr: r1(100 * Math.max(...err("time"))),
    /** At half the build: the estimated and the actual remaining time. */
    halfwayRemaining: half ? { estimated: Math.round(half.remainingEstimate), actual: Math.round(half.remainingActual) } : undefined,
    /** Percent shown when the build is at 25, 50, 75 % of its time. */
    at: [0.25, 0.5, 0.75].map((q) => {
      const r = rows.find((x) => x.actual >= q);
      return r ? { actual: Math.round(100 * r.actual), count: Math.round(100 * r.count), time: Math.round(100 * r.time) } : undefined;
    }),
  };
}

test("build progress: overhead, latency, prediction, restart", async ({ page, browserName }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("ready");

  // 1. Restarting the worker, which is what aborting a build costs.
  const restarts: number[] = [];
  for (let i = 0; i < 5; i++) restarts.push(await page.evaluate(() => window.experiment.start()));

  // 2. Overhead of each reporting mode: the build, the reporting inside it, the final meshing.
  const overhead: Record<string, unknown>[] = [];
  for (const c of CASES) {
    await build(page, c.model, c.params, "events"); // warm-up
    const runs = new Map<Mode, PageBuild[]>(MODES.map((m) => [m, []]));
    for (let i = 0; i < c.repeat; i++) for (const mode of MODES) runs.get(mode)!.push(await build(page, c.model, c.params, mode));
    for (const [mode, builds] of runs) {
      for (const b of builds) expect(b.built.problems, `${c.name}: no broken features`).toEqual([]);
      const meshed = builds.map((b) => b.progress.filter((p) => p.meshes.length > 0));
      overhead.push({
        case: c.name,
        mode,
        features: builds[0]!.built.trace.length,
        pageMs: r1(median(builds.map((b) => b.pageMs))),
        buildMs: r1(median(builds.map((b) => b.built.buildMs))),
        reportMs: r1(median(builds.map((b) => b.built.reportMs))),
        reportMeshMs: r1(median(builds.map((b) => b.built.reportMeshMs))),
        finalMeshMs: r1(median(builds.map((b) => b.built.finalMeshMs))),
        messages: builds[0]!.built.messages,
        meshMessages: meshed[0]!.length,
        triangles: meshed[0]!.reduce((s, p) => s + p.meshes.reduce((t, m) => t + m.triangles, 0), 0),
        firstNewsMs: r1(median(builds.map((b) => (b.progress[0]?.received ?? b.posted + b.pageMs) - b.posted))),
        firstGeometryMs: r1(median(builds.map((b, i) => (meshed[i]![0]?.received ?? b.posted + b.pageMs) - b.posted))),
        longestGapMs: r1(median(builds.map(longestGap))),
        framesPerSecond: r1(median(builds.map((b) => (b.frames / b.pageMs) * 1000))),
      });
    }
  }

  // 3. Latency of progress messages, with the page idle and with its main thread blocked for 1 s.
  const latency: Record<string, unknown>[] = [];
  for (const blockMs of [0, 1000]) {
    const builds: PageBuild[] = [];
    for (let i = 0; i < 3; i++) builds.push(await build(page, "plate", PLATE, "events", blockMs));
    const all = builds.flatMap((b) => b.progress.map((p) => p.received - p.sent));
    latency.push({
      blockMs,
      buildMs: r1(median(builds.map((b) => b.built.buildMs))),
      pageMs: r1(median(builds.map((b) => b.pageMs))),
      messages: all.length,
      median: r1(median(all)),
      p95: r1(quantile(all, 0.95)),
      max: r1(Math.max(...all)),
      resultLatency: r1(median(builds.map((b) => b.posted + b.pageMs - b.built.sent))),
    });
  }

  // 4. How well the previous build predicts progress, over a sequence of edits.
  const edits: [string, Record<string, unknown>][] = [
    ["same", PLATE],
    ["same", PLATE],
    ["r 3 → 3.5", { ...PLATE, r: 3.5 }],
    ["fil 0.8 → 1.2", { ...PLATE, r: 3.5, fil: 1.2 }],
    ["n 12 → 14", { ...PLATE, r: 3.5, fil: 1.2, n: 14 }],
    ["n 14 → 10", { ...PLATE, r: 3.5, fil: 1.2, n: 10 }],
    ["cuts → one combine", { ...PLATE, r: 3.5, fil: 1.2, n: 10, combine: true }],
    ["same", { ...PLATE, r: 3.5, fil: 1.2, n: 10, combine: true }],
  ];
  let prev = await build(page, "plate", PLATE, "events");
  const prediction: Record<string, unknown>[] = [];
  for (const [edit, params] of edits) {
    const b = await build(page, "plate", params, "events");
    prediction.push({ edit, ...estimates(prev, b) });
    prev = b;
  }

  const result = { browser: browserName, userAgent: await page.evaluate(() => navigator.userAgent), restartMs: { median: r1(median(restarts)), all: restarts.map(r1) }, heapRestarts: await page.evaluate(() => window.experiment.restarts()), overhead, latency, prediction };
  await writeFile(join(import.meta.dirname, `results-${browserName}.json`), JSON.stringify(result, null, 2) + "\n");
  await testInfo.attach("result.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
