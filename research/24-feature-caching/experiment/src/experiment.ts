/**
 * Feature caching measured (research/24): each step of src/cad/test/sequences.ts's edit sequences
 * built with and without the cache, as the tool's worker builds and meshes, in Node with the
 * library's OCCT, each run of a sequence in a process of its own, as OCCT's heap only grows (the tool
 * restarts its worker past 1 GiB); OCCT's heap after each step; each step with and without the
 * cache compared (`buildPrint`); meshing copies; and what writing and reading back a build's bodies
 * as B-rep text would cost a cache kept across reloads.
 *
 * `node --experimental-transform-types src/experiment.ts` writes results-node.json.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { getOC, setOC } from "replicad";
import init from "replicad-opencascadejs";
import { FeatureCache, meshable, type TraceEntry } from "@patchwork-cad/features/runtime";
import type { Body } from "@patchwork-cad/features";
import { buildPrint, diff } from "../../../../src/features/test/fingerprint.ts";
import { buildSource, sequences, type Params, type Sequence } from "../../../../src/cad/test/sequences.ts";

setOC(await init());
const oc = getOC();
const REPEAT = Number(process.env["REPEAT"] ?? 3);
const PLATES: Record<string, Params> = { "plate, cuts (12 × 10)": { n: 12, m: 10 }, "plate, one combine (16 × 12)": { n: 16, m: 12, combine: true } };
const MESH = { tolerance: 0.1, angularTolerance: 30 };

/** Meshes the shown bodies as the worker does (`meshable`), in ms. */
function mesh(bodies: Body[]): number {
  const t0 = performance.now();
  for (const b of bodies) {
    const shape = meshable(b).meshes;
    shape.mesh(MESH);
    shape.meshEdges(MESH);
  }
  return performance.now() - t0;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const allSequences = (): { name: string; sequence: Sequence }[] => [
  ...sequences().filter((s) => s.model !== "plate").map((sequence) => ({ name: sequence.model.toUpperCase(), sequence })),
  ...Object.entries(PLATES).map(([name, params]) => ({ name, sequence: sequences(params).find((s) => s.model === "plate")! })),
];

interface Run {
  label: string;
  features: number;
  ran: number;
  build: number;
  mesh: number;
  /** OCCT's heap after the step, in bytes. */
  heap: number;
}

const heapBytes = () => (oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory.buffer.byteLength;

/** One run of a sequence, with or without the cache. */
async function run(name: string, cached: boolean): Promise<Run[]> {
  const { sequence } = allSequences().find((s) => s.name === name)!;
  const cache = cached ? new FeatureCache() : undefined;
  const out: Run[] = [];
  for (const step of sequence.steps) {
    const built = await buildSource(step.source, step.params, cache);
    const meshMs = mesh(built.shown);
    out.push({ label: step.label, features: built.trace.length, ran: built.trace.filter((t: TraceEntry) => !t.cached).length, build: built.ms, mesh: meshMs, heap: heapBytes() });
  }
  return out;
}

/** Each step with and without the cache, compared (`buildPrint`): the differences per step. */
async function verify(name: string): Promise<number[]> {
  const { sequence } = allSequences().find((s) => s.name === name)!;
  const cache = new FeatureCache();
  const out: number[] = [];
  for (const step of sequence.steps) {
    const cached = await buildSource(step.source, step.params, cache);
    const withCache = buildPrint(cached.trace, cached.shown);
    const fresh = await buildSource(step.source, step.params);
    out.push(diff(withCache, buildPrint(fresh.trace, fresh.shown)).length);
  }
  return out;
}

/** Writing every body a build made as B-rep text and reading it back, as a cache kept across reloads would. */
async function serialization(name: string) {
  const { sequence } = allSequences().find((s) => s.name === name)!;
  const { source, params } = sequence.steps[0]!;
  const built = await buildSource(source, params);
  const bodies = [...new Set(built.trace.flatMap((t) => t.results))];
  const t0 = performance.now();
  const texts = bodies.map((b) => oc.BRepToolsWrapper.Write(b.topo.shape));
  const t1 = performance.now();
  for (const text of texts) oc.BRepToolsWrapper.Read(text);
  const t2 = performance.now();
  const last = texts.at(-1)!;
  const t3 = performance.now();
  oc.BRepToolsWrapper.Read(last);
  const t4 = performance.now();
  return { build: built.ms, bodies: bodies.length, writeAll: t1 - t0, readAll: t2 - t1, bytesAll: texts.reduce((a, t) => a + t.length, 0), bytesLast: last.length, readLast: t4 - t3 };
}

/** Meshing the shown bodies of a build in place, as the tool did before research/24, against copying them first (`meshable`), in ms. */
async function meshCopies(name: string) {
  const { sequence } = allSequences().find((s) => s.name === name)!;
  const { source, params } = sequence.steps[0]!;
  const timesOf = async () => {
    const { shown } = await buildSource(source, params);
    const t0 = performance.now();
    for (const b of shown) {
      const s = b.shape as unknown as { mesh(o: typeof MESH): unknown; meshEdges(o: typeof MESH): unknown };
      s.mesh(MESH);
      s.meshEdges(MESH);
    }
    const inPlace = performance.now() - t0;
    const { shown: again } = await buildSource(source, params);
    const t1 = performance.now();
    for (const b of again) meshable(b);
    const copy = performance.now() - t1;
    const copied = mesh(again);
    const remesh = mesh(again);
    return { inPlace, copy, copied, remesh };
  };
  const runs = [];
  for (let r = 0; r < REPEAT; r++) runs.push(await timesOf());
  return { inPlace: median(runs.map((r) => r.inPlace)), copy: median(runs.map((r) => r.copy)), copiedAndMeshed: median(runs.map((r) => r.copied)), meshedAgain: median(runs.map((r) => r.remesh)) };
}

/** Runs this script in a process of its own and gives what it printed, as JSON. */
const child = <T>(...args: string[]): T => {
  process.stderr.write(`${args.join(" ")}\n`);
  return JSON.parse(execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { encoding: "utf8", env: { ...process.env }, maxBuffer: 1 << 26 }).trim()) as T;
};

const [mode, arg, cachedArg] = process.argv.slice(2);
if (mode === "run") console.log(JSON.stringify(await run(arg!, cachedArg === "cached")));
else if (mode === "verify") console.log(JSON.stringify(await verify(arg!)));
else if (mode === "persisted") console.log(JSON.stringify(await serialization(arg!)));
else if (mode === "meshing") console.log(JSON.stringify(await meshCopies(arg!)));
else {
  type Step = { label: string; features: number; ran: number; fresh: { build: number; mesh: number; heap: number }; cached: { build: number; mesh: number; heap: number }; differences: number | undefined };
  const results: Record<string, Step[]> = {};
  const meshing: Record<string, unknown> = {};
  for (const { name, sequence } of allSequences()) {
    const fresh: Run[][] = [];
    const cached: Run[][] = [];
    for (let r = 0; r < REPEAT; r++) {
      // Alternating which runs first, so that neither always meets the host in the same state.
      if (r % 2) fresh.push(child<Run[]>("run", name, "fresh"));
      cached.push(child<Run[]>("run", name, "cached"));
      if (!(r % 2)) fresh.push(child<Run[]>("run", name, "fresh"));
    }
    let differences: (number | undefined)[] = [];
    try {
      differences = child<number[]>("verify", name);
    } catch (error) {
      process.stderr.write(`verify ${name} failed: ${String(error).slice(0, 300)}\n`);
    }
    const of = (runs: Run[][], i: number) => ({ build: median(runs.map((x) => x[i]!.build)), mesh: median(runs.map((x) => x[i]!.mesh)), heap: median(runs.map((x) => x[i]!.heap)) });
    results[name] = sequence.steps.map((step, i) => ({ label: step.label, features: cached[0]![i]!.features, ran: cached[0]![i]!.ran, fresh: of(fresh, i), cached: of(cached, i), differences: differences[i] }));
    meshing[name] = child("meshing", name);
  }
  const persisted = { [Object.keys(PLATES)[0]!]: child("persisted", Object.keys(PLATES)[0]!) };
  writeFileSync(new URL("../results-node.json", import.meta.url), JSON.stringify({ node: process.version, repeat: REPEAT, results, persisted, meshing }, null, 2));
  const mb = (b: number) => `${Math.round(b / 2 ** 20)} MB`;
  for (const [name, steps] of Object.entries(results)) {
    console.log(`\n${name}`);
    for (const s of steps) console.log(`  ${s.label.padEnd(36)} ran ${String(s.ran).padStart(3)}/${s.features}  build ${s.fresh.build.toFixed(1)} → ${s.cached.build.toFixed(1)} ms  mesh ${s.fresh.mesh.toFixed(1)} → ${s.cached.mesh.toFixed(1)} ms  heap ${mb(s.fresh.heap)} → ${mb(s.cached.heap)}  differences ${s.differences ?? "not checked"}`);
  }
  console.log("\npersisted", JSON.stringify(persisted), "\nmeshing", JSON.stringify(meshing));
}
