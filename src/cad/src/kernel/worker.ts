/// <reference lib="webworker" />
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as replicad from "replicad";
import { createBuilder } from "replicad-evaluator/builder";
import { createBrowserCodeEvaluator } from "replicad-evaluator/evaluate/browser";
import * as features from "@patchwork-cad/features";
import { beginBuild, changedVolume, currentTrace, liveBodies, locate, meshIds, outline, owners, shapers, pickCode, pickData, pickRegion, extentOf, pathsOf, samplePath, type RefData as LibraryRefData, type TraceEntry } from "@patchwork-cad/features/runtime";
import { loadFonts, mayDrawText } from "./fonts.ts";
import { moduleKey, type Imports } from "./imports.ts";
import { dataNamespace, evaluate, fileNamespace, lineFromStack, type Namespace } from "./modules.ts";
import { DERIVED, prepare, prepareImported, PrepareError, PROVIDED, type Resolve } from "./prepare.ts";
import type { BuildParams, BuildTimings, ParamValues, FeatureTrace, InitTimings, MeshedShape, ModelError, ShownSketch, SketchRegion, WorkerRequest, WorkerResponse } from "./protocol.ts";

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

/** For scripts without exports, which the builder runs with `runInContext`; modules run with `evaluate`. */
const browserEvaluator = createBrowserCodeEvaluator();

/** The running build's values of parameters, over the model's `defaultParams` (research/17-parameters.md). */
let params: BuildParams | undefined;
/** `main`'s argument: the module's defaults, with the build's values over them. */
const withParams = (defaults: unknown): unknown => (params ? { ...(typeof defaults === "object" && defaults ? defaults : {}), ...params } : defaults);
/** What the running build's `main` got, and its derived parameters' values, which prepare.ts makes them report. */
let paramValues: ParamValues = { params: {}, derived: {} };
/** A value as JSON, if it is one: numbers, strings, booleans, and arrays and plain objects of them. */
const json = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
};
(globalThis as Record<string, unknown>)[DERIVED] = (name: string, value: unknown) => (paramValues.derived[name] = json(value));

/** What `main` returned in the running build, to find the bodies behind the meshed shapes. */
let returned: unknown;
/** The last successful build's trace, with its bodies, for rollback and picking. */
let lastTrace: readonly TraceEntry[] = [];

/** A body without faces, which a failed feature leaves behind; there is nothing to mesh. */
const isEmptyBody = (v: unknown) => v instanceof features.Body && v.topo.faces.length === 0;

/** Whether main returned an object of outputs, `{ plate: notched, lid }`, rather than a shape or a list of them. */
const isOutputs = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype && !("shape" in value);

/**
 * Wraps a model module so that its `main` result is recorded, without empty bodies. The evaluator
 * gets it without sketches, which it can't show; the view draws them itself. Outputs of an object
 * are named by their keys (research/15, "Output").
 */
function recordMain(module: Record<string, unknown>): Record<string, unknown> {
  const main = module["default"];
  if (typeof main !== "function") return module;
  return {
    ...module,
    default: (...args: unknown[]) => {
      // The builder passes the module's defaults, as it gets no values of its own.
      const arg = params ? withParams(module["defaultParams"]) : args[0];
      paramValues.params = (json(arg) ?? {}) as Record<string, unknown>;
      const value = (main as (...a: unknown[]) => unknown)(arg, ...args.slice(1));
      if (isOutputs(value)) {
        const entries = Object.entries(value).filter(([, v]) => !isEmptyBody(v));
        returned = entries.map(([, v]) => v);
        return entries.flatMap(([name, v]) => (v instanceof features.Sketch ? [] : v instanceof features.Body ? [{ name, shape: v.shape }] : v instanceof replicad.Shape ? [{ name, shape: v }] : [v]));
      }
      returned = Array.isArray(value) ? value.filter((v) => !isEmptyBody(v)) : isEmptyBody(value) ? [] : value;
      return Array.isArray(returned) ? returned.filter((v) => !(v instanceof features.Sketch)) : returned instanceof features.Sketch ? [] : returned;
    },
  };
}
/**
 * The model module of the running build. buildShapesFromCode imports the model
 * a second time only to read `defaultName`, which runs its top level again
 * (research/08); within one build, the first import is reused instead.
 */
let buildModule: { code: string; module: Promise<Record<string, unknown>> } | undefined;

/**
 * Imported documents' modules, by their code or content: a document that didn't change stays one
 * module, evaluated once in the worker's life, and one that changed is a new module.
 */
const documentModules = new Map<string, Promise<Namespace>>();
const evaluated = new Map<string, Namespace>();
const load = (key: string): Namespace => {
  const module = evaluated.get(key);
  if (!module) throw new Error("an imported document was used before it was evaluated");
  return module;
};

/** Evaluates a prepared module once the documents it imports (`keys`) are. */
async function run(code: string, name: "cad-model" | "cad-document", keys: readonly string[]): Promise<Namespace> {
  await Promise.all(keys.map((key) => documentModules.get(key)));
  return evaluate(code, name, load);
}

/**
 * Makes the documents of `imports` modules, each after the documents it imports itself: the
 * `Resolve` it returns for a module collects the keys of the documents that module imports in `keys`.
 */
function resolver(imports: Imports): (keys: string[]) => Resolve {
  const resolving = new Set<string>();
  const resolveInto = (keys: string[]): Resolve => (specifier, type) => {
    const name = moduleKey(specifier, type);
    const imported = imports[name];
    if (!imported) throw new Error("it wasn't loaded");
    if (imported.kind === "problem") throw new Error(imported.problem);
    if (resolving.has(name)) throw new Error("it imports itself, through the documents it imports");
    let key: string;
    let make: () => Promise<Namespace>;
    if (imported.kind === "js") {
      resolving.add(name);
      const own: string[] = [];
      let code: string;
      try {
        code = prepareImported(imported.code, resolveInto(own));
      } catch (error) {
        throw error instanceof PrepareError ? new Error(`${error.message} (its line ${error.line})`) : error;
      } finally {
        resolving.delete(name);
      }
      key = `js\n${code}`;
      make = () => run(code, "cad-document", own);
    } else if (imported.kind === "data") {
      key = `data\n${imported.json ? "json" : ""}\n${JSON.stringify(imported.value)}`;
      make = async () => dataNamespace(imported.value, imported.json);
    } else if (imported.kind === "text") {
      key = `text\n${imported.text}`;
      make = async () => fileNamespace(imported.text);
    } else {
      key = `bytes\n${imported.id}`;
      make = async () => fileNamespace(imported.bytes);
    }
    if (!documentModules.has(key)) documentModules.set(key, make().then((module) => (evaluated.set(key, module), module)));
    keys.push(key);
    return key;
  };
  return resolveInto;
}
/** The running build's or check's documents. */
let resolveInto = resolver({});
const kernel = loadKernel();
const builder = createBuilder({
  runtime: async () => ({ replicad, oc: (await kernel).oc }),
  codeEvaluator: {
    runInContext: browserEvaluator.runInContext,
    evaluateModule<TModule>(code: string, options?: { globals?: Record<string, unknown> }): Promise<TModule> {
      if (buildModule?.code !== code) {
        Object.assign(globalThis, options?.globals);
        const keys: string[] = [];
        buildModule = { code, module: run(prepare(code, resolveInto(keys)), "cad-model", keys).then(recordMain) };
      }
      return buildModule.module as Promise<TModule>;
    },
  },
});

kernel.then(
  ({ timings }) => post({ type: "ready", timings }),
  (error: unknown) => post({ type: "init-failed", message: String((error as Error)?.message ?? error) }),
);


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
 * Bodies and sketches that no feature used and main didn't return: geometry that a branch in the
 * model silently drops, e.g. after a feature was retargeted to an earlier body.
 */
function unusedResults(trace: readonly TraceEntry[], values: unknown[]): Set<features.Body | features.Sketch> {
  const shown = new Set(values.flatMap((v) => (v instanceof features.Body ? [v.shape] : v && typeof v === "object" && "shape" in v ? [(v as { shape: unknown }).shape] : [])));
  const used = new Set(trace.flatMap((t) => t.sketches));
  const sketches = trace.flatMap((t) => (t.sketch && !used.has(t.sketch) && !values.includes(t.sketch) ? [t.sketch] : []));
  return new Set([...liveBodies().filter((b) => !shown.has(b.shape)), ...sketches]);
}

const shownSketch = (sketch: features.Sketch): ShownSketch[] => (sketch.broken ? [] : [{ name: sketch.name, outline: outline(sketch) }]);

/** The sketches that the first `end` features of a trace made and didn't use, e.g. at a rollback. */
function liveSketches(trace: readonly TraceEntry[], end: number): ShownSketch[] {
  const ran = trace.slice(0, end);
  const used = new Set(ran.flatMap((t) => t.sketches));
  return ran.flatMap((t) => (t.sketch && !used.has(t.sketch) ? shownSketch(t.sketch) : []));
}

/** A trace entry as a feature's progress message sends it: a sketch's outline, which the view shows early, but not its regions; not unused, which only the whole build tells. */
const brief = (t: TraceEntry): FeatureTrace => ({
  name: t.name,
  type: t.type,
  line: t.line,
  variable: t.variable,
  status: t.status,
  message: t.message,
  refs: t.refs,
  before: t.before.map((b) => b.name),
  inputs: t.inputs.map((b) => b.name),
  result: t.result?.name,
  results: t.results.map((b) => b.name),
  names: t.names,
  outline: t.sketch && !t.sketch.broken ? outline(t.sketch) : undefined,
  warnings: t.warnings,
  unused: false,
  ms: t.ms,
  namingMs: t.namingMs,
});

const serialize = (trace: readonly TraceEntry[], unused: Set<features.Body | features.Sketch> = new Set()): FeatureTrace[] =>
  trace.map((t) => ({
    ...brief(t),
    regions: t.sketch && !t.sketch.broken ? regionsOf(t.sketch) : undefined,
    size: t.sketch && !t.sketch.broken ? sizeOf(t.sketch) : undefined,
    unused: t.sketch ? unused.has(t.sketch) : t.results.length > 0 && t.results.every((b) => unused.has(b)),
  }));

/** A sketch's width and height on its plane, as far as its curves reach. */
function sizeOf(sketch: features.Sketch): [number, number] | undefined {
  const { paths } = pathsOf(sketch.profile);
  const rough = extentOf(paths);
  if (!rough) return undefined;
  const tolerance = Math.max(rough.max[0] - rough.min[0], rough.max[1] - rough.min[1]) * 1e-5;
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  for (const p of paths)
    for (const point of samplePath(p, tolerance))
      for (const i of [0, 1]) {
        min[i] = Math.min(min[i]!, point[i]!);
        max[i] = Math.max(max[i]!, point[i]!);
      }
  return [max[0]! - min[0]!, max[1]! - min[1]!];
}

/** A sketch's regions, with the code a pick of each writes and its triangles in world coordinates. */
function regionsOf(sketch: features.Sketch): SketchRegion[] {
  const { origin, normal, xDir } = sketch.frame;
  const yDir = [normal[1] * xDir[2] - normal[2] * xDir[1], normal[2] * xDir[0] - normal[0] * xDir[2], normal[0] * xDir[1] - normal[1] * xDir[0]] as const;
  return sketch.regions.map((r, i) => {
    const triangles: number[] = [];
    for (let k = 0; k < r.triangles.length; k += 2) for (let a = 0; a < 3; a++) triangles.push(origin[a]! + xDir[a]! * r.triangles[k]! + yDir[a]! * r.triangles[k + 1]!);
    return { code: String(pickRegion(sketch, i)), filled: r.filled, triangles };
  });
}

/** Bodies of a trace by name: results, and whatever was visible before each feature. */
function bodiesOf(trace: readonly TraceEntry[]): Map<string, features.Body> {
  const out = new Map<string, features.Body>();
  for (const t of trace) for (const b of [...t.before, ...t.results, ...t.after]) out.set(b.name, b);
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
    features: owners(body),
    shapers: shapers(body),
  };
}

async function build(id: number, source: string, buildParams: BuildParams | undefined, imports: Imports): Promise<void> {
  params = buildParams;
  resolveInto = resolver(imports);
  paramValues = { params: {}, derived: {} };
  const t0 = performance.now();
  const fail = (error: ModelError) => {
    const t = performance.now() - t0;
    post({ type: "failed", id, error, trace: serialize(currentTrace()), timings: { build: t, total: t }, heapBytes: heapBytes() });
  };
  try {
    prepare(source, resolveInto([]));
  } catch (error) {
    if (error instanceof PrepareError) return fail({ message: error.message, line: error.line, kind: error.kind });
    throw error;
  }
  await kernel;
  if (mayDrawText(source, imports)) await loadFonts();
  const t1 = performance.now();
  buildModule = undefined;
  returned = undefined;
  // A message per feature, which also tells the engine's watchdog that the build is alive (research/23).
  beginBuild({
    lenient: true,
    onFeature: (t, done) => post(done ? { type: "featureDone", id, feature: brief(t) } : { type: "featureStarted", id, name: t.name, featureType: t.type, line: t.line, variable: t.variable }),
  });
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
  const values = Array.isArray(returned) ? returned : returned === undefined ? [] : [returned];
  // The evaluator drops what main returned but it can't show, e.g. a string. Its shape entries are
  // what it kept, in the order of the meshes (its `$` debug shapes follow them), so a mesh's body is
  // the returned one with the entry's shape.
  const kept = builder.getShapeEntries() as { shape: unknown }[];
  const bodies = new Map(values.flatMap((v) => (v instanceof features.Body ? [[v.shape as unknown, v] as const] : [])));
  const shapes: MeshedShape[] = result.flatMap((shape, i) => {
    if (shape.format === "svg" || !shape.mesh) return [];
    const body = bodies.get(kept[i]?.shape);
    const edges = shape.edges ?? undefined;
    const pickable = body ? indices(body, shape.mesh, edges) : { body: undefined, faceIndex: undefined, edgeIndex: undefined, features: undefined, shapers: undefined };
    return [{ name: shape.name, color: shape.color, opacity: shape.opacity, faces: shape.mesh, edges, ...pickable }];
  });
  lastTrace = [...currentTrace()];
  const timings: BuildTimings = { build: t2 - t1, total: performance.now() - t0 };
  const sketches = values.flatMap((v) => (v instanceof features.Sketch ? shownSketch(v) : []));
  const dropped = values.filter((v) => !(v instanceof features.Sketch)).length - kept.length;
  post({ type: "built", id, shapes, sketches, dropped, trace: serialize(lastTrace, unusedResults(lastTrace, values)), timings, heapBytes: heapBytes(), paramValues });
}

/**
 * Runs a model on trial without meshing, keeping the last build's trace for rollback and picking.
 * Its bodies are left to the heap limit (research/08).
 */
async function check(id: number, source: string, buildParams: BuildParams | undefined, imports: Imports): Promise<void> {
  params = buildParams;
  resolveInto = resolver(imports);
  const problems = () => currentTrace().filter((t) => t.status !== "ok").length;
  const failures = () => currentTrace().flatMap((t) => (t.status === "ok" ? [] : [{ name: t.name, status: t.status, message: t.message }]));
  try {
    const keys: string[] = [];
    const code = prepare(source, resolveInto(keys));
    await kernel;
    if (mayDrawText(source, imports)) await loadFonts();
    beginBuild({ lenient: true });
    // The globals that replicad-evaluator's builder gives a model (`evaluateModule` in its builder).
    Object.assign(globalThis, { replicad, replicadShapeFns: undefined, oc: (await kernel).oc });
    const module = await run(code, "cad-model", keys);
    const main = module["default"];
    if (typeof main === "function") (main as (p: unknown) => unknown)(withParams(module["defaultParams"] ?? {}));
    post({ type: "checked", id, error: undefined, problems: problems(), failures: failures() });
  } catch (error) {
    const kind = error instanceof PrepareError ? error.kind : "runtime";
    const line = error instanceof PrepareError ? error.line : lineFromStack((error as Error)?.stack);
    post({ type: "checked", id, error: { message: String((error as Error)?.message ?? error), line, kind }, problems: problems(), failures: failures() });
  }
}

function answer(request: Exclude<WorkerRequest, { type: "build" | "check" | "exports" }>): void {
  const bodies = bodiesOf(lastTrace);
  if (request.type === "rollback") {
    const index = lastTrace.findIndex((t) => t.name === request.feature);
    const entry = lastTrace[index];
    if (!entry) throw new Error(`No feature ${request.feature} in the last build`);
    const shapes = (request.after ? entry.after : entry.before).filter((b) => b.topo.faces.length > 0).map(meshBody);
    post({ type: "rolledBack", id: request.id, shapes, sketches: liveSketches(lastTrace, request.after ? index + 1 : index) });
  } else if (request.type === "result") {
    const result = bodies.get(request.body);
    post({ type: "resultMeshed", id: request.id, shape: result && meshBody(result) });
  } else if (request.type === "difference") {
    const entry = lastTrace.find((t) => t.name === request.feature);
    const shapes = entry ? changedVolume(entry) : [];
    post({
      type: "differenceMeshed",
      id: request.id,
      shapes: shapes.map((shape, i) => {
        const meshable = shape as unknown as { mesh(o: typeof MESH): MeshedShape["faces"]; meshEdges(o: typeof MESH): NonNullable<MeshedShape["edges"]> };
        return { name: `${request.feature}:changed:${i}`, color: undefined, opacity: undefined, faces: meshable.mesh(MESH), edges: meshable.meshEdges(MESH), body: undefined, faceIndex: undefined, edgeIndex: undefined, features: undefined, shapers: undefined };
      }),
    });
  } else if (request.type === "refs") {
    const refs = request.faces.map(({ body, index }) => {
      const b = bodies.get(body);
      try {
        return b ? pickData(b, "face", index) : null;
      } catch {
        return null;
      }
    });
    post({ type: "refsMade", id: request.id, refs });
  } else if (request.type === "locate") {
    const shown = request.bodies.flatMap((name) => {
      const body = bodies.get(name);
      return body ? [body] : [];
    });
    // Others' references are data, never code: resolving one runs nothing of theirs.
    const found = request.refs.map((ref) => shown.flatMap((body) => {
      const indices = locate(body, ref as LibraryRefData);
      return indices.length ? [{ body: body.name, indices }] : [];
    }));
    post({ type: "located", id: request.id, found });
  } else {
    const body = bodies.get(request.body);
    if (!body) throw new Error(`No body ${request.body} in the last build`);
    post({ type: "picked", id: request.id, code: pickCode(body, request.kind, request.index, lastTrace), ref: pickData(body, request.kind, request.index) });
  }
}

/** What the JS module of document `specifier` exports, as far as it is JSON: its functions, bodies and the like are left out. */
async function exportsOf(id: number, specifier: string, imports: Imports): Promise<void> {
  try {
    const key = resolver(imports)([])(specifier, undefined);
    const module = await documentModules.get(key)!;
    post({ type: "exported", id, value: json({ ...module }) });
  } catch (error) {
    post({ type: "requestFailed", id, message: String((error as Error)?.message ?? error) });
  }
}

/** Builds and checks run one after another: both use the feature library's one build context. */
let queue: Promise<void> = Promise.resolve();
const enqueue = (job: () => Promise<void>) => (queue = queue.then(job, job));

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "check") {
    enqueue(() => check(request.id, request.source, request.params, request.imports ?? {}));
    return;
  }
  if (request.type === "exports") {
    // After the running build: the module may use the feature library's build context.
    enqueue(() => exportsOf(request.id, request.specifier, request.imports));
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
  enqueue(() => build(request.id, request.source, request.params, request.imports ?? {}).catch((error: unknown) =>
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
