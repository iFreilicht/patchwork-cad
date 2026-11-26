/**
 * Models built as the kernel worker builds them (`prepare`, `evaluate`, `main` with parameters
 * over the defaults, lenient, with or without a feature cache), and the edit sequences that
 * research/24 measures and the cache's tests check: late and early edits of code and parameters,
 * switching configurations back and forth, a comment that moves every line.
 */
import { readFileSync } from "node:fs";
import * as replicad from "replicad";
import * as features from "@patchwork-cad/features";
import { beginBuild, currentTrace, type FeatureCache, type TraceEntry } from "@patchwork-cad/features/runtime";
import { evaluate } from "../src/kernel/modules.ts";
import { prepare, PROVIDED } from "../src/kernel/prepare.ts";

Object.assign(globalThis, { [PROVIDED["@patchwork-cad/features"]!]: features, [PROVIDED["replicad"]!]: replicad });

export type Params = Record<string, unknown>;

export interface Built {
  trace: TraceEntry[];
  /** The bodies main returned, which the worker meshes. */
  shown: features.Body[];
  /** Milliseconds evaluating the module and running main. */
  ms: number;
}

/** Builds `source` with `params` over its defaults, as the worker does, reusing and keeping results in `cache` if given. */
export async function buildSource(source: string, params: Params, cache?: FeatureCache): Promise<Built> {
  const code = prepare(source);
  const t0 = performance.now();
  beginBuild({ lenient: true, ...(cache ? { cache } : {}) });
  const module = await evaluate(code, "cad-model", () => {
    throw new Error("no documents");
  });
  const value = (module["default"] as (p: Params) => unknown)({ ...(module["defaultParams"] as Params), ...params });
  const ms = performance.now() - t0;
  const values = value instanceof features.Body ? [value] : Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  return { trace: [...currentTrace()], shown: values.filter((v): v is features.Body => v instanceof features.Body), ms };
}

export interface Step {
  label: string;
  source: string;
  params: Params;
}

export interface Sequence {
  model: string;
  steps: Step[];
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const example = (name: string) => read(`../../features/examples/${name}.js`);
/** research/23's slow plate: a grid of holes cut one feature at a time, one fillet of their top edges, a chamfer. */
export const PLATE = read("../../../research/23-build-progress/experiment/src/plate.js");

/** `source` with each `[from, to]` replaced once; throws if one isn't there, so that a sequence can't silently not edit. */
function edited(source: string, ...replacements: [string, string][]): string {
  return replacements.reduce((s, [from, to]) => {
    if (!s.includes(from)) throw new Error(`no ${JSON.stringify(from)} to edit`);
    return s.replace(from, to);
  }, source);
}

/** A sequence of edits, each step from the one before: `edit` changes the code, `params` the parameters, `label` says what the step does. */
function sequence(model: string, base: string, baseParams: Params, edits: { label: string; edit?: [string, string][]; params?: Params }[]): Sequence {
  let source = base;
  let params = baseParams;
  const steps: Step[] = [{ label: "first build", source, params }];
  for (const e of edits) {
    if (e.edit) source = edited(source, ...e.edit);
    if (e.params) params = { ...baseParams, ...e.params };
    steps.push({ label: e.label, source, params });
  }
  return { model, steps };
}

const comment: [string, string] = ["export default function", "// A comment above main moves every line.\nexport default function"];

/** The edit sequences; `plate` gives the plate's parameters, e.g. a smaller grid for tests. */
export function sequences(plate: Params = {}): Sequence[] {
  return [
    sequence("m1", example("m1"), {}, [
      { label: "late: chamfer distance 1 → 1.5", edit: [["], distance: 1 });", "], distance: 1.5 });"]] },
      { label: "late: boss radius 2 → 2.5", edit: [["h / 2], radius: 2 })", "h / 2], radius: 2.5 })"]] },
      { label: "middle: fillet radius 1.5 → 2", edit: [["radius: 1.5 });", "radius: 2 });"]] },
      { label: "comment above main", edit: [comment] },
      { label: "early: h 20 → 25", params: { h: 25 } },
      { label: "configuration: w 70", params: { w: 70 } },
      { label: "configuration: defaults", params: {} },
      { label: "configuration: w 70", params: { w: 70 } },
    ]),
    sequence("m3", example("m3"), {}, [
      { label: "late: hole radius 4 → 5", edit: [["(t + H) / 2], radius: 4 })", "(t + H) / 2], radius: 5 })"]] },
      { label: "late: chamfer distance 1 → 1.5", edit: [["distance: 1 });", "distance: 1.5 });"]] },
      { label: "middle: rib thickness 6 → 8", params: { ribT: 8 } },
      { label: "configuration: ribs [15, 45]", params: { ribs: [15, 45] } },
      { label: "configuration: defaults", params: {} },
      { label: "configuration: ribs [15, 45]", params: { ribs: [15, 45] } },
      { label: "early: t 8 → 10", params: { t: 10 } },
    ]),
    sequence("m4", example("m4"), {}, [
      { label: "late: lid z 30 → 40", edit: [["z: 30 })", "z: 40 })"]] },
      { label: "branch: rounded radius 3 → 4", edit: [["radius: 3 })", "radius: 4 })"]] },
      { label: "middle: boss fillet radius 2 → 3", edit: [["radius: 2 })", "radius: 3 })"]] },
      { label: "early: h 8 → 10", params: { h: 10 } },
      { label: "configuration: w 80", params: { w: 80 } },
      { label: "configuration: defaults", params: {} },
      { label: "configuration: w 80", params: { w: 80 } },
    ]),
    sequence("plate", PLATE, plate, [
      { label: "late: chamfer 0.5 → 0.6", edit: [["distance: 0.5 })", "distance: 0.6 })"]] },
      { label: "late: fillet 0.8 → 1", params: { fil: 1 } },
      { label: "comment above main", edit: [comment], params: { fil: 1 } },
      { label: "early: hole radius 3 → 3.5", params: { fil: 1, r: 3.5 } },
      { label: "configuration: r 3", params: { fil: 1 } },
      { label: "configuration: r 3.5", params: { fil: 1, r: 3.5 } },
      { label: "early: thickness 6 → 7", params: { fil: 1, r: 3.5, t: 7 } },
    ]),
  ];
}
