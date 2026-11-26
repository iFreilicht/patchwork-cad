/**
 * Build progress (research/23-build-progress.md): what each feature of the last build took predicts
 * how far the running build is. The status bar and the timeline show it once a build has run for a while.
 */
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { FeatureTrace, ShownSketch } from "../kernel/protocol.ts";

/** How long a build runs before its progress shows, and how long progress shows at least, so that it doesn't flash. */
export const PROGRESS_DELAY_MS = 500;
export const PROGRESS_MIN_MS = 500;
/** From this long on, the remaining time shows in words ("Anything slower than 10 seconds needs a percent-done indicator", Nielsen). */
export const REMAINING_FROM_MS = 10_000;
/** Builds at least this long are slow: their feature times are kept in this browser, and the status bar names their slowest feature. */
export const SLOW_BUILD_MS = 1000;
/** Remaining times are overestimated by this factor: a bar that jumps to the end feels faster than one that stalls before it (Harrison et al. 2007). */
const PESSIMISM = 1.15;
/** The bar stays below this until the result arrives. */
const CAP = 0.95;

/** Milliseconds per feature, by name, when it last ran, and those of a build outside features: evaluating the code, meshing and sending. */
export interface FeatureTimes {
  features: Record<string, number>;
  rest: number;
}

/**
 * A build's feature times by what each took when it last ran (`cost`), also when it was cached
 * (research/24): a feature that is cached in one build may run in the next, and the estimate
 * expects every feature not yet done to run, so that a build that reuses some ends early rather
 * than late.
 */
export function timesOf(trace: readonly FeatureTrace[], total: number): FeatureTimes {
  const features: Record<string, number> = {};
  for (const t of trace) features[t.name] = (features[t.name] ?? 0) + t.cost;
  const ran = trace.reduce((a, t) => a + t.ms, 0);
  return { features, rest: Math.max(0, total - ran) };
}

/** A feature as progress names it. */
export interface RunningFeature {
  name: string;
  type: string;
  line: number | undefined;
  variable: boolean;
}

/**
 * How far a build is after `elapsed` ms, by the previous build's `times`: the elapsed time over it
 * and the previous times of the features that haven't run, the running one's less what it has run
 * (`since` is when it started). Not by counting features, which later features, on larger bodies,
 * make run ahead (research/23, "Prediction"). Below `CAP`, and the remaining time overestimated.
 * None once the build has run features and none of them were in the previous build, e.g. after the
 * code was replaced: those times are another model's.
 */
export function estimate(times: FeatureTimes, done: ReadonlyMap<string, unknown>, running: { name: string; since: number } | undefined, elapsed: number): { fraction: number; remaining: number } | undefined {
  const ran = [...done.keys(), ...(running ? [running.name] : [])];
  if (ran.length > 0 && !ran.some((name) => name in times.features)) return undefined;
  let remaining = times.rest;
  for (const [name, ms] of Object.entries(times.features)) {
    if (done.has(name)) continue;
    remaining += name === running?.name ? Math.max(0, ms - (elapsed - running.since)) : ms;
  }
  remaining *= PESSIMISM;
  return { fraction: elapsed + remaining > 0 ? Math.min(CAP, elapsed / (elapsed + remaining)) : 0, remaining };
}

/** A duration as the status bar shows it: "180 ms", "3.2 s", "1 min 5 s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The remaining time in words, rounded up: "about 15 s left", "about 2 min left". */
export function remainingText(ms: number): string {
  if (ms < 10_000) return "a few seconds left";
  if (ms < 60_000) return `about ${Math.ceil(ms / 5000) * 5} s left`;
  return `about ${Math.ceil(ms / 60_000)} min left`;
}

/** Whether a sketch of the running build looks different from the last build's, by its trace entry, which stays the same object while the build runs. */
const changed = new WeakMap<FeatureTrace, boolean>();

/**
 * The sketches the running build is done with that are new or look different from the last build's
 * (`trace`): the view shows their outlines at once, before the features that use them have run
 * (research/23, "The view").
 */
export function changedSketches(done: ReadonlyMap<string, FeatureTrace>, trace: readonly FeatureTrace[]): ShownSketch[] {
  const out: ShownSketch[] = [];
  for (const t of done.values()) {
    if (!t.outline) continue;
    let differs = changed.get(t);
    if (differs === undefined) {
      const before = trace.find((x) => x.name === t.name)?.outline;
      differs = JSON.stringify(before) !== JSON.stringify(t.outline);
      changed.set(t, differs);
    }
    if (differs) out.push({ name: t.name, outline: t.outline });
  }
  return out;
}

/** A feature's name, or for one without a variable its type and line. */
export const featureLabel = (f: RunningFeature): string => (f.variable ? f.name : `${f.type}${f.line !== undefined ? ` on line ${f.line}` : ""}`);

/** Where this browser keeps a model's last slow build's feature times: they are this machine's. */
const timesKey = (docUrl: AutomergeUrl) => `patchwork-cad:feature-times:${docUrl}`;

export function loadTimes(docUrl: AutomergeUrl): FeatureTimes | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(timesKey(docUrl)) ?? "null") as Partial<FeatureTimes> | null;
    return value && typeof value.rest === "number" && value.features && typeof value.features === "object" ? (value as FeatureTimes) : undefined;
  } catch {
    return undefined;
  }
}

export function storeTimes(docUrl: AutomergeUrl, times: FeatureTimes): void {
  try {
    localStorage.setItem(timesKey(docUrl), JSON.stringify(times));
  } catch {
    // Storage is full or blocked: the first build after a reload has no estimate.
  }
}
