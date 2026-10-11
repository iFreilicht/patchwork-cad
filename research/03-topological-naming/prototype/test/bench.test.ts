/** The benchmark itself: runs everything and requires every non-correct cell to be explained. */
import { beforeAll, expect, test } from "vitest";
import { loadOC } from "../src/oc.ts";
import { classify, runAll } from "../src/report.ts";

beforeAll(loadOC);

test("every non-correct cell has a classified mechanism", { timeout: 120_000 }, () => {
  const unexplained = runAll()
    .filter((r) => r.score !== "correct" && classify(r) === "UNCLASSIFIED")
    .map((r) => `${r.model} | ${r.edit} | ${r.slot} | ${r.strategy}: ${r.explanation}`);
  expect(unexplained).toEqual([]);
});
