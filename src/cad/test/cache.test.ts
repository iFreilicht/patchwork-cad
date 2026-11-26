/**
 * Feature caching through the tool's evaluation (research/24): every step of the edit sequences,
 * built with the cache as the worker builds, is the build without it, down to the B-rep, the names
 * and the meshes; and each edit reruns where it lands, no more.
 */
import { beforeAll, expect, test } from "vitest";
import { FeatureCache } from "@patchwork-cad/features/runtime";
import { loadOC } from "../../features/test/oc.ts";
import { buildPrint, diff } from "../../features/test/fingerprint.ts";
import { buildSource, sequences } from "./sequences.ts";

beforeAll(loadOC);

/**
 * The features each step reran, by model and step. A configuration that was shown two builds ago
 * or more is built again where it differs from the last two builds (`FeatureCache`'s generations).
 */
const RAN: Record<string, string[][]> = {
  m1: [
    ["sketch1", "extrude1", "sketch2", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"],
    ["chamfer1", "sketch3", "extrude2"],
    ["sketch3", "extrude2"],
    ["fillet1", "chamfer1", "sketch3", "extrude2"],
    [],
    ["extrude1", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"],
    ["sketch1", "extrude1", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"],
    ["extrude1", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"],
    [],
  ],
  m4: [
    ["sketch1", "plate", "sketch2", "boss", "fillet1", "joined", "rounded", "corner", "notched", "lid"],
    ["lid"],
    ["rounded"],
    ["fillet1", "joined", "notched"],
    ["plate", "sketch2", "boss", "fillet1", "joined", "rounded", "corner", "notched", "lid"],
    ["sketch1", "plate", "sketch2", "boss", "fillet1", "joined", "rounded", "corner", "notched", "lid"],
    ["plate", "sketch2", "boss", "fillet1", "joined", "rounded", "corner", "notched", "lid"],
    [],
  ],
};

for (const { model, steps } of sequences()) {
  test(`${model}: each step of the edit sequence with the cache is the step without it`, async () => {
    const cache = new FeatureCache();
    const ran: string[][] = [];
    for (const step of steps) {
      const cached = await buildSource(step.source, step.params, cache);
      const withCache = buildPrint(cached.trace, cached.shown);
      const fresh = await buildSource(step.source, step.params);
      expect(diff(withCache, buildPrint(fresh.trace, fresh.shown)), step.label).toEqual([]);
      ran.push(cached.trace.filter((t) => !t.cached).map((t) => t.name));
    }
    if (RAN[model]) expect(ran).toEqual(RAN[model]);
    if (model === "plate") {
      // The chamfer, then the fillet and the chamfer; switching between two configurations reruns nothing.
      expect(ran.slice(1, 3)).toEqual([["chamfer1"], ["fillet1", "chamfer1"]]);
      expect(ran.slice(5, 7)).toEqual([[], []]);
    }
    // A comment that moves every line reruns nothing: the features are named by their variables.
    steps.forEach((s, i) => s.label === "comment above main" && expect(ran[i], model).toEqual([]));
  }, 600_000);
}
