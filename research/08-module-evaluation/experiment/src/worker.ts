/// <reference lib="webworker" />
// The CAD tool's kernel worker (src/cad/src/kernel/worker.ts), reduced to the
// builder and instrumented. Two variants of the code evaluator:
// - "as-is": what the tool does, every evaluateModule call imports the module
// - "memo": within one build, a second evaluateModule of the same source
//   returns the module of the first
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as replicad from "replicad";
import { createBuilder } from "replicad-evaluator/builder";
import { createBrowserCodeEvaluator } from "replicad-evaluator/evaluate/browser";
import { prepare } from "../../../../src/cad/src/kernel/prepare.ts";
import { M1_STEPS, type M1Step, type Variant, type WorkerReply, type WorkerRequest } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;
declare const gc: (() => void) | undefined;

interface Counters {
  __topLevelRuns?: number;
}
const counters = globalThis as Counters;

let variant: Variant = "as-is";
/** Module imports, i.e. evaluations of the model's top level by the evaluator. */
let imports = 0;
/** One weak reference per imported module namespace, to see which ones stay alive. */
const namespaces: WeakRef<object>[] = [];
let memo: { code: string; namespace: Promise<Record<string, unknown>> } | undefined;

const oc = initOpenCascade({ locateFile: () => wasmUrl });
const browserEvaluator = createBrowserCodeEvaluator();
const builder = createBuilder({
  runtime: async () => ({ replicad, oc: await oc }),
  codeEvaluator: {
    runInContext: browserEvaluator.runInContext,
    evaluateModule(code, options) {
      if (variant === "memo" && memo?.code === code) return memo.namespace as never;
      imports++;
      const namespace = browserEvaluator.evaluateModule(prepare(code), options).then((ns) => {
        namespaces.push(new WeakRef(ns));
        return ns;
      });
      if (variant === "memo") memo = { code, namespace };
      return namespace as never;
    },
  },
});

/** M1 as in models.ts, but as worker code: no evaluator, no module. Stops after `until`. */
function m1(until: M1Step = "fuse"): replicad.Shape3D {
  const { drawRectangle, drawCircle } = replicad;
  const w = 60, d = 40, h = 20, a = 30, r = 8;
  const last = M1_STEPS.indexOf(until);
  let s = drawRectangle(w, d).translate(w / 2, d / 2).sketchOnPlane("XY").extrude(h) as replicad.Shape3D;
  if (last >= 1) s = s.cut(drawCircle(r).translate(a, 0).sketchOnPlane("XY").extrude(h) as replicad.Shape3D);
  if (last >= 2) s = s.fillet(1.5, (e) => e.ofCurveType("CIRCLE").inPlane("XY", h));
  if (last >= 3) s = s.chamfer(1, (e) => e.ofCurveType("LINE").containsPoint([w - 2, 0, h]));
  if (last >= 4) s = s.fuse(drawCircle(2).translate(w - 6, h / 2).sketchOnPlane("XZ").extrude(4) as replicad.Shape3D);
  return s;
}

let canaryFinalized = false;
const canaryRegistry = new FinalizationRegistry(() => void (canaryFinalized = true));

const wasmBytes = async () => (await oc).wasmMemory.buffer.byteLength;

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  switch (request.type) {
    case "init":
      variant = request.variant;
      await builder.ready();
      return { type: "ready", wasmBytes: await wasmBytes() };
    case "build": {
      memo = undefined;
      const [importsBefore, runsBefore] = [imports, counters.__topLevelRuns ?? 0];
      const start = performance.now();
      const result = await builder.buildShapesFromCode(request.source);
      const ms = performance.now() - start;
      memo = undefined;
      const error = Array.isArray(result) ? undefined : (result as { message: string }).message;
      return {
        type: "built",
        ms,
        error,
        imports: imports - importsBefore,
        topLevelRuns: (counters.__topLevelRuns ?? 0) - runsBefore,
        wasmBytes: await wasmBytes(),
      };
    }
    case "direct": {
      await oc;
      const start = performance.now();
      const shape = m1(request.until);
      if (request.mode !== "build") {
        // The same calls as replicad-evaluator's renderMesh.
        shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
        shape.meshEdges({ tolerance: 0.1, keepMesh: true } as replicad.MeshOptions);
      }
      if (request.mode === "build+mesh+delete") shape.delete();
      return { type: "direct-built", ms: performance.now() - start, wasmBytes: await wasmBytes() };
    }
    case "probe": {
      const collected = typeof gc === "function";
      canaryFinalized = false;
      const canary = (() => {
        const object = {};
        canaryRegistry.register(object, null);
        return new WeakRef(object);
      })();
      if (collected) {
        // Twice with a pause, so that finalizers queued by the first run (replicad's
        // deletes of OCCT objects) have run before the second.
        gc();
        await new Promise((r) => setTimeout(r, 50));
        gc();
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        type: "probed",
        collected,
        canaryCollected: canary.deref() === undefined,
        canaryFinalized,
        modulesAlive: namespaces.filter((ref) => ref.deref() !== undefined).length,
        modulesTotal: namespaces.length,
        wasmBytes: await wasmBytes(),
      };
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  handle(event.data).then(
    (reply) => self.postMessage(reply),
    (error: unknown) => self.postMessage({ type: "error", message: String((error as Error)?.stack ?? error) } satisfies WorkerReply),
  );
};
