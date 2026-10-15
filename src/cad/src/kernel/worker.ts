/// <reference lib="webworker" />
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as replicad from "replicad";
import { createBuilder } from "replicad-evaluator/builder";
import { createBrowserCodeEvaluator } from "replicad-evaluator/evaluate/browser";
import * as features from "@patchwork-cad/features";
import { beginBuild, currentTrace, liveBodies, meshIds, outline, pickCode, type TraceEntry } from "@patchwork-cad/features/runtime";
import { prepare, PrepareError, PROVIDED } from "./prepare.ts";
import type { BuildTimings, FeatureTrace, InitTimings, MeshedShape, ModelError, WorkerRequest, WorkerResponse } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

/**
 * The wasm through the Cache API: WebKit (Playwright 1.59.1) keeps the 23 MB
 * response in no HTTP cache, so it would be downloaded on every load. The URL
 * is content-hashed, so a cached copy never goes stale.
 */
async function fetchWasm(): Promise<{ response: Response; cached: boolean }> {
  const cache = await caches.open("patchwork-cad-occt").catch(() => undefined);
  const hit = await cache?.match(wasmUrl);
  if (hit) return { response: hit, cached: true };
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Fetching ${wasmUrl} failed: ${response.status}`);
  // Stores a copy while the original streams into the compiler.
  cache?.put(wasmUrl, response.clone()).catch((error: unknown) => console.warn("patchwork-cad: caching OCCT failed", error));
  return { response, cached: false };
}

/** OCCT's memory, once loaded. Its size only grows; the engine restarts the worker when it gets large. */
let memory: WebAssembly.Memory | undefined;
const heapBytes = () => memory?.buffer.byteLength ?? 0;

async function loadKernel(): Promise<{ oc: unknown; timings: InitTimings }> {
  const t0 = performance.now();
  const { response, cached } = await fetchWasm();
  const bytes = Number(response.headers.get("content-length") ?? 0);
  const module = await WebAssembly.compileStreaming(response);
  const t1 = performance.now();
  const oc = await initOpenCascade({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
      return {};
    },
  });
  const t2 = performance.now();
  memory = (oc as { wasmMemory: WebAssembly.Memory }).wasmMemory;
  return { oc, timings: { compile: t1 - t0, instantiate: t2 - t1, wasmBytes: bytes, cached } };
}

// The feature library is provided like replicad (prepare.ts rewrites its imports to this global).
(globalThis as Record<string, unknown>)[PROVIDED["@patchwork-cad/features"]!] = features;

const browserEvaluator = createBrowserCodeEvaluator();

/** What `main` returned in the running build, to find the bodies behind the meshed shapes. */
let returned: unknown;
/** The last successful build's trace, with its bodies, for rollback and picking. */
let lastTrace: readonly TraceEntry[] = [];

/** Wraps a model module so that its `main` result is recorded. */
function recordMain(module: Record<string, unknown>): Record<string, unknown> {
  const main = module["default"];
  if (typeof main !== "function") return module;
  return {
    ...module,
    default: (...args: unknown[]) => (returned = (main as (...a: unknown[]) => unknown)(...args)),
  };
}
/**
 * The model module of the running build. buildShapesFromCode imports the model
 * a second time only to read `defaultName`, which runs its top level again
 * (research/08); within one build, the first import is reused instead.
 */
let buildModule: { code: string; module: Promise<Record<string, unknown>> } | undefined;
const kernel = loadKernel();
const builder = createBuilder({
  runtime: async () => ({ replicad, oc: (await kernel).oc }),
  codeEvaluator: {
    runInContext: browserEvaluator.runInContext,
    evaluateModule<TModule>(code: string, options?: Parameters<typeof browserEvaluator.evaluateModule>[1]): Promise<TModule> {
      if (buildModule?.code !== code) buildModule = { code, module: browserEvaluator.evaluateModule<Record<string, unknown>>(prepare(code), options).then(recordMain) };
      return buildModule.module as Promise<TModule>;
    },
  },
});

kernel.then(
  ({ timings }) => post({ type: "ready", timings }),
  (error: unknown) => post({ type: "init-failed", message: String((error as Error)?.message ?? error) }),
);

/** The first `blob:` frame of a stack is the model module; its line is the source line (see prepare). */
function lineFromStack(stack: unknown): number | undefined {
  const match = typeof stack === "string" ? /blob:[^\s)]*?:(\d+):\d+/.exec(stack) : null;
  return match ? Number(match[1]) : undefined;
}

interface BuiltShape {
  name: string;
  color?: string;
  opacity?: number;
  mesh?: MeshedShape["faces"] | null;
  edges?: MeshedShape["edges"] | null;
  error?: boolean;
  message?: string | null;
  format?: string;
}

/**
 * Bodies that no feature consumed and main didn't return: geometry that a branch in the model
 * silently drops, e.g. after a feature was retargeted to an earlier body.
 */
function unusedBodies(values: unknown[]): Set<features.Body> {
  const shown = new Set(values.flatMap((v) => (v instanceof features.Body ? [v.shape] : v && typeof v === "object" && "shape" in v ? [(v as { shape: unknown }).shape] : [])));
  return new Set(liveBodies().filter((b) => !shown.has(b.shape)));
}

const serialize = (trace: readonly TraceEntry[], unused: Set<features.Body> = new Set()): FeatureTrace[] =>
  trace.map((t) => ({
    name: t.name,
    type: t.type,
    line: t.line,
    variable: t.variable,
    status: t.status,
    message: t.message,
    refs: t.refs,
    before: t.before.map((b) => b.name),
    result: t.result?.name,
    outline: t.sketch && !t.sketch.broken ? outline(t.sketch) : undefined,
    unused: t.result !== undefined && unused.has(t.result),
    ms: t.ms,
    namingMs: t.namingMs,
  }));

/** Bodies of a trace by name: results, and whatever was visible before each feature. */
function bodiesOf(trace: readonly TraceEntry[]): Map<string, features.Body> {
  const out = new Map<string, features.Body>();
  for (const t of trace) for (const b of [...t.before, ...(t.result ? [t.result] : [])]) out.set(b.name, b);
  return out;
}

const MESH = { tolerance: 0.1, angularTolerance: 30 };

/** Meshes a body directly, as replicad-evaluator would, with its pickable entity indices. */
function meshBody(body: features.Body): MeshedShape {
  const shape = body.shape as unknown as { mesh(o: typeof MESH): MeshedShape["faces"]; meshEdges(o: typeof MESH): NonNullable<MeshedShape["edges"]> };
  const faces = shape.mesh(MESH);
  const edges = shape.meshEdges(MESH);
  return { name: body.name, color: undefined, opacity: undefined, faces, edges, ...indices(body, faces, edges) };
}

function indices(body: features.Body, faces: MeshedShape["faces"], edges: MeshedShape["edges"]) {
  const faceIds = meshIds(body, "face");
  const edgeIds = meshIds(body, "edge");
  return {
    body: body.name,
    faceIndex: faces.faceGroups?.map((g) => faceIds.indexOf(g.faceId)),
    edgeIndex: edges?.edgeGroups?.map((g) => edgeIds.indexOf(g.edgeId)),
  };
}

async function build(id: number, source: string): Promise<void> {
  const t0 = performance.now();
  const fail = (error: ModelError) => {
    const t = performance.now() - t0;
    post({ type: "failed", id, error, trace: serialize(currentTrace()), timings: { build: t, total: t }, heapBytes: heapBytes() });
  };
  try {
    prepare(source);
  } catch (error) {
    if (error instanceof PrepareError) return fail({ message: error.message, line: error.line, kind: error.kind });
    throw error;
  }
  await kernel;
  const t1 = performance.now();
  buildModule = undefined;
  returned = undefined;
  beginBuild({ lenient: true });
  const result = (await builder.buildShapesFromCode(source).finally(() => (buildModule = undefined))) as
    | BuiltShape[]
    | { error: true; message: string; stack?: unknown };
  const t2 = performance.now();
  if (!Array.isArray(result)) {
    const line = lineFromStack(result.stack);
    return fail({ message: result.message, line, kind: line === undefined ? "kernel" : "runtime" });
  }
  const broken = result.find((shape) => shape.error);
  if (broken) return fail({ message: broken.message ?? "Could not mesh the shape", line: undefined, kind: "mesh" });
  // The evaluator keeps the order of what main returned; a body there makes its shape pickable.
  const values = Array.isArray(returned) ? returned : [returned];
  const shapes: MeshedShape[] = result.flatMap((shape, i) => {
    if (shape.format === "svg" || !shape.mesh) return [];
    const value = values[i];
    const edges = shape.edges ?? undefined;
    const pickable = value instanceof features.Body ? indices(value, shape.mesh, edges) : { body: undefined, faceIndex: undefined, edgeIndex: undefined };
    return [{ name: shape.name, color: shape.color, opacity: shape.opacity, faces: shape.mesh, edges, ...pickable }];
  });
  lastTrace = [...currentTrace()];
  const timings: BuildTimings = { build: t2 - t1, total: performance.now() - t0 };
  post({ type: "built", id, shapes, trace: serialize(lastTrace, unusedBodies(values)), timings, heapBytes: heapBytes() });
}

/**
 * Runs a model on trial without meshing, keeping the last build's trace for rollback and picking.
 * Its bodies are left to the heap limit (research/08).
 */
async function check(id: number, source: string): Promise<void> {
  const problems = () => currentTrace().filter((t) => t.status !== "ok").length;
  try {
    const code = prepare(source);
    await kernel;
    beginBuild({ lenient: true });
    // The globals that replicad-evaluator's builder gives a model (`evaluateModule` in its builder).
    const module = await browserEvaluator.evaluateModule<Record<string, unknown>>(code, { filename: "__entry__.ts", globals: { replicad, replicadShapeFns: undefined, oc: (await kernel).oc } });
    const main = module["default"];
    if (typeof main === "function") (main as (p: unknown) => unknown)(module["defaultParams"] ?? {});
    post({ type: "checked", id, error: undefined, problems: problems() });
  } catch (error) {
    const kind = error instanceof PrepareError ? error.kind : "runtime";
    const line = error instanceof PrepareError ? error.line : lineFromStack((error as Error)?.stack);
    post({ type: "checked", id, error: { message: String((error as Error)?.message ?? error), line, kind }, problems: problems() });
  }
}

function answer(request: Exclude<WorkerRequest, { type: "build" | "check" }>): void {
  const bodies = bodiesOf(lastTrace);
  if (request.type === "rollback") {
    const entry = lastTrace.find((t) => t.name === request.feature);
    if (!entry) throw new Error(`No feature ${request.feature} in the last build`);
    post({ type: "rolledBack", id: request.id, shapes: entry.before.map(meshBody) });
  } else {
    const body = bodies.get(request.body);
    if (!body) throw new Error(`No body ${request.body} in the last build`);
    post({ type: "picked", id: request.id, code: pickCode(body, request.kind, request.index, lastTrace) });
  }
}

/** Builds and checks run one after another: both use the feature library's one build context. */
let queue: Promise<void> = Promise.resolve();
const enqueue = (job: () => Promise<void>) => (queue = queue.then(job, job));

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "check") {
    enqueue(() => check(request.id, request.source));
    return;
  }
  if (request.type !== "build") {
    try {
      answer(request);
    } catch (error) {
      post({ type: "requestFailed", id: request.id, message: String((error as Error)?.message ?? error) });
    }
    return;
  }
  enqueue(() => build(request.id, request.source).catch((error: unknown) =>
    post({
      type: "failed",
      id: request.id,
      error: { message: String((error as Error)?.message ?? error), line: lineFromStack((error as Error)?.stack), kind: "runtime" },
      trace: serialize(currentTrace()),
      timings: { build: 0, total: 0 },
      heapBytes: heapBytes(),
    }),
  ));
};
