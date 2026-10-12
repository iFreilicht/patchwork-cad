/// <reference lib="webworker" />
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as replicad from "replicad";
import { createBuilder } from "replicad-evaluator/builder";
import { createBrowserCodeEvaluator } from "replicad-evaluator/evaluate/browser";
import { prepare, PrepareError } from "./prepare.ts";
import type { BuildTimings, InitTimings, MeshedShape, ModelError, WorkerRequest, WorkerResponse } from "./protocol.ts";

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
  return { oc, timings: { compile: t1 - t0, instantiate: t2 - t1, wasmBytes: bytes, cached } };
}

const browserEvaluator = createBrowserCodeEvaluator();
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
      if (buildModule?.code !== code) buildModule = { code, module: browserEvaluator.evaluateModule(prepare(code), options) };
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

async function build(id: number, source: string): Promise<void> {
  const t0 = performance.now();
  const fail = (error: ModelError) => {
    const t = performance.now() - t0;
    post({ type: "failed", id, error, timings: { build: t, total: t } });
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
  const shapes: MeshedShape[] = result
    .filter((shape) => shape.format !== "svg" && shape.mesh)
    .map((shape) => ({ name: shape.name, color: shape.color, opacity: shape.opacity, faces: shape.mesh!, edges: shape.edges ?? undefined }));
  const timings: BuildTimings = { build: t2 - t1, total: performance.now() - t0 };
  post({ type: "built", id, shapes, timings });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== "build") return;
  build(request.id, request.source).catch((error: unknown) =>
    post({
      type: "failed",
      id: request.id,
      error: { message: String((error as Error)?.message ?? error), line: lineFromStack((error as Error)?.stack), kind: "runtime" },
      timings: { build: 0, total: 0 },
    }),
  );
};
