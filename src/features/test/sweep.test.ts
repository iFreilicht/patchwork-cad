/**
 * The reference sweep (research/17-parameters.md, "Parameters stress references"): the examples,
 * built with each numeric parameter scaled and with other rib lists, and every broken feature
 * classified. A reference that reports itself as broken does so because the geometry it names is
 * gone (`gone`), because its `near` hint vetoes the piece it names after a dimension grew
 * (`hint`), or because OCCT fails on the changed geometry (`kernel`).
 */
import { beforeAll, expect, test } from "vitest";
import { beginBuild, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const FACTORS = [0.25, 0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2, 3];
const RIBS = [[], [20], [45], [15, 45], [10, 30, 50]];

type Kind = "gone" | "hint" | "kernel";

function kindOf(message: string): Kind | undefined {
  if (/no longer the one nearest/.test(message)) return "hint";
  if (/nothing matches/.test(message)) return "gone";
  if (/OCCT/.test(message)) return "kernel";
  return undefined;
}

/** Which variants break, and why: the notch or the rib leaves the part or sits on its edge, or a dimension triples. */
const EXPECTED: Record<string, Kind> = {
  "m1 w×0.25": "gone",
  "m1 w×0.5": "gone",
  "m1 w×3": "hint",
  "m1 a×0.25": "gone",
  "m1 a×2": "gone",
  "m1 a×3": "gone",
  "m3 w×0.25": "gone",
  "m3 w×0.5": "gone",
  "m3 w×3": "hint",
  "m3 d×0.25": "kernel",
  "m3 ribs=[]": "gone",
};

test("every reference that breaks under changed parameters is explained", async () => {
  const found: Record<string, Kind | "unexplained"> = {};
  let builds = 0;
  for (const name of ["m1", "m3", "m4"]) {
    const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: Record<string, unknown> };
    const variants: [string, Record<string, unknown>][] = [["defaults", {}]];
    for (const [key, value] of Object.entries(model.defaultParams)) if (typeof value === "number") for (const f of FACTORS) variants.push([`${key}×${f}`, { [key]: +(value * f).toFixed(3) }]);
    if (name === "m3") for (const ribs of RIBS) variants.push([`ribs=${JSON.stringify(ribs)}`, { ribs }]);
    for (const [label, values] of variants) {
      beginBuild({ lenient: true });
      model.default({ ...model.defaultParams, ...values });
      builds++;
      // A feature that fails because one before it broke is explained by that one.
      const first = currentTrace().find((t) => t.status !== "ok");
      if (first) found[`${name} ${label}`] = kindOf(first.message ?? "") ?? "unexplained";
    }
  }
  expect(builds).toBe(125);
  expect(found).toEqual(EXPECTED);
}, 600_000);
