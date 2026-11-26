/** Estimating a build's progress from the previous build's feature times (research/23-build-progress.md). */
import { expect, test } from "vitest";
import { duration, estimate, featureLabel, remainingText, timesOf } from "../src/components/progress.ts";
import type { FeatureTrace } from "../src/kernel/protocol.ts";

const trace = (name: string, ms: number, cost = ms) => ({ name, ms, cost, cached: cost !== ms }) as FeatureTrace;

test("feature times: by name, and the rest of the build outside features", () => {
  expect(timesOf([trace("a", 100), trace("b", 300)], 500)).toEqual({ features: { a: 100, b: 300 }, rest: 100 });
  // A total below the features' sum, e.g. rounded, leaves no rest.
  expect(timesOf([trace("a", 100)], 90).rest).toBe(0);
});

test("a cached feature counts with what it took when it last ran, which the next build may take again (research/24)", () => {
  expect(timesOf([trace("a", 1, 2000), trace("b", 300)], 400)).toEqual({ features: { a: 2000, b: 300 }, rest: 99 });
});

test("the estimate counts time, not features, and overestimates what remains", () => {
  const times = { features: { a: 100, b: 800, c: 100 }, rest: 0 };
  // After a, at 100 ms: 900 ms of features remain, overestimated.
  const afterA = estimate(times, new Map([["a", 1]]), undefined, 100)!;
  expect(afterA.remaining).toBeCloseTo(900 * 1.15);
  expect(afterA.fraction).toBeLessThan(0.1);
  // b ran 400 of its 800 ms.
  const inB = estimate(times, new Map([["a", 1]]), { name: "b", since: 100 }, 500)!;
  expect(inB.remaining).toBeCloseTo(500 * 1.15);
  // b overran: only c remains, and the bar still moves, towards its cap.
  const late = estimate(times, new Map([["a", 1]]), { name: "b", since: 100 }, 2000)!;
  expect(late.remaining).toBeCloseTo(100 * 1.15);
  expect(late.fraction).toBeGreaterThan(estimate(times, new Map([["a", 1]]), { name: "b", since: 100 }, 1500)!.fraction);
  expect(estimate(times, new Map([["a", 1], ["b", 1], ["c", 1]]), undefined, 1000)!.fraction).toBe(0.95);
});

test("no estimate from another model's times: none of the features that ran were in it", () => {
  const times = { features: { sketch1: 10, extrude1: 20 }, rest: 50 };
  expect(estimate(times, new Map(), undefined, 100)).toBeDefined();
  expect(estimate(times, new Map(), { name: "a", since: 0 }, 100)).toBeUndefined();
  expect(estimate(times, new Map([["a", 1]]), { name: "extrude1", since: 50 }, 100)).toBeDefined();
});

test("durations and remaining times in words", () => {
  expect(duration(180.4)).toBe("180 ms");
  expect(duration(3240)).toBe("3.2 s");
  expect(duration(65_000)).toBe("1 min 5 s");
  expect(remainingText(4000)).toBe("a few seconds left");
  expect(remainingText(16_000)).toBe("about 20 s left");
  expect(remainingText(70_000)).toBe("about 2 min left");
  expect(featureLabel({ name: "fillet1", type: "fillet", line: 3, variable: true })).toBe("fillet1");
  expect(featureLabel({ name: "extrude@L12#3", type: "extrude", line: 12, variable: false })).toBe("extrude on line 12");
});
