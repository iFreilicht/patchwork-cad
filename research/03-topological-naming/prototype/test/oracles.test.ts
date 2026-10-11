/**
 * The oracles define ground truth, so they get their own checks: every oracle must find exactly the
 * declared number of entities in the base model and after every edit.
 */
import { beforeAll, describe as group, expect, test } from "vitest";
import { buildCase, consumerOf, type Case } from "../src/bench.ts";
import { cases } from "../src/cases/index.ts";
import { loadOC } from "../src/oc.ts";

beforeAll(loadOC);

for (const c of cases as Case<unknown>[]) {
  group(c.model, () => {
    const count = (p: unknown, features: ReturnType<typeof c.features>, slot: string) => {
      const consumer = consumerOf(features, slot);
      if (!consumer) return "no consumer";
      const r = c.refs.find((x) => x.slot === slot)!.oracle(buildCase(c, p, features).before(consumer), p);
      return r === "gone" ? "gone" : r.length;
    };
    test("base", () => {
      const f = c.features(c.params);
      expect(buildCase(c, c.params, f).failures).toEqual([]);
      for (const ref of c.refs) expect(count(c.params, f, ref.slot), ref.slot).toBe(c.baseExpect[ref.slot] ?? "no consumer");
    });
    for (const e of c.edits) {
      test(e.name, () => {
        const p = { ...(c.params as object), ...e.params };
        const f = e.features ? e.features(c.features(p), p) : c.features(p);
        // Only features whose reference is intentionally gone may fail.
        const gone = Object.entries(e.expect).filter(([, v]) => v === "gone").map(([k]) => consumerOf(f, k));
        expect(buildCase(c, p, f).failures.filter((x) => !gone.includes(x.feature) && !e.allowFailures?.[x.feature])).toEqual([]);
        for (const ref of c.refs) expect(count(p, f, ref.slot), ref.slot).toBe(e.expect[ref.slot] ?? "no consumer");
      });
    }
  });
}
