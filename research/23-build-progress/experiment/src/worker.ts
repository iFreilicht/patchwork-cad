/// <reference lib="webworker" />
// The tool's kernel worker (src/cad/src/kernel/worker.ts) reduced to running a model's main with the
// feature library, without evaluator, with a progress hook: the trace's push, which the library calls
// when a feature starts, reports the feature before it as done.
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { Body } from "@patchwork-cad/features";
import { beginBuild, currentTrace, type TraceEntry } from "@patchwork-cad/features/runtime";
import { MESH_BUDGET, THROTTLE_MS, type FeatureDone, type Mode, type ModelName, type WorkerReply, type WorkerRequest } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

type Main = (params: Record<string, unknown>) => unknown;
const modules = import.meta.glob<{ default: Main }>(["../../../../src/features/examples/m1.js", "../../../../src/features/examples/m3.js", "./plate.js"], { eager: true });
const mainOf = (name: ModelName): Main => Object.entries(modules).find(([path]) => path.endsWith(`/${name}.js`))![1].default;

let memory: WebAssembly.Memory | undefined;
const stamp = () => performance.timeOrigin + performance.now();
const post = (message: WorkerReply, transfer: Transferable[] = []) => self.postMessage(message, transfer);

const MESH = { tolerance: 0.1, angularTolerance: 30 };
interface Meshable {
  mesh(o: typeof MESH): { vertices: number[]; triangles: number[]; normals: number[] };
  meshEdges(o: typeof MESH): { lines: number[] };
}

/** Meshes a body as the tool does, into typed arrays that are transferred, not copied. */
function mesh(body: Body): { triangles: number; ms: number; buffers: ArrayBuffer[] } {
  const t0 = performance.now();
  const shape = body.shape as unknown as Meshable;
  const faces = shape.mesh(MESH);
  const edges = shape.meshEdges(MESH);
  const buffers = [new Float32Array(faces.vertices).buffer, new Uint32Array(faces.triangles).buffer, new Float32Array(faces.normals).buffer, new Float32Array(edges.lines).buffer];
  return { triangles: faces.triangles.length / 3, ms: performance.now() - t0, buffers };
}

const done = (t: TraceEntry, index: number): FeatureDone => ({ index, name: t.name, type: t.type, status: t.status, ms: t.ms });
const shown = (bodies: Body[]) => bodies.filter((b) => b.topo.faces.length > 0);

function build(model: ModelName, params: Record<string, unknown>, mode: Mode): void {
  beginBuild({ lenient: true });
  const trace = currentTrace() as TraceEntry[];
  let reportMs = 0;
  let reportMeshMs = 0;
  let messages = 0;
  let lastMesh = performance.now();
  /** What meshing took the last time, for "budget". */
  let lastMeshMs = 0;
  const report = (index: number) => {
    const t0 = performance.now();
    const entry = trace[index]!;
    let meshed: ReturnType<typeof mesh>[] = [];
    if (mode === "mesh") meshed = shown(entry.results).map(mesh);
    else if ((mode === "throttled" && t0 - lastMesh >= THROTTLE_MS) || (mode === "budget" && t0 - lastMesh >= Math.max(THROTTLE_MS, lastMeshMs * (1 / MESH_BUDGET - 1)))) {
      meshed = shown(entry.after).map(mesh);
      lastMesh = performance.now();
      lastMeshMs = lastMesh - t0;
    }
    reportMeshMs += meshed.reduce((s, m) => s + m.ms, 0);
    post({ type: "progress", sent: stamp(), feature: done(entry, index), meshes: meshed.map(({ triangles, ms }) => ({ triangles, ms })) }, meshed.flatMap((m) => m.buffers));
    messages++;
    reportMs += performance.now() - t0;
  };
  if (mode !== "none")
    trace.push = (...entries: TraceEntry[]) => {
      if (trace.length > 0) report(trace.length - 1);
      return Array.prototype.push.apply(trace, entries);
    };
  const t0 = performance.now();
  const returned = mainOf(model)(params);
  if (mode !== "none" && trace.length > 0) report(trace.length - 1);
  const t1 = performance.now();
  const bodies = Object.values(returned as Record<string, unknown>).filter((v): v is Body => v instanceof Body);
  shown(bodies).forEach(mesh);
  const t2 = performance.now();
  post({
    type: "built",
    sent: stamp(),
    buildMs: t1 - t0,
    finalMeshMs: t2 - t1,
    reportMs,
    reportMeshMs,
    messages,
    trace: trace.map(done),
    problems: trace.filter((t) => t.status !== "ok").map((t) => `${t.name}: ${t.message}`),
    heapBytes: memory?.buffer.byteLength ?? 0,
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "init") {
      const t0 = performance.now();
      const oc = await initOpenCascade({ locateFile: () => wasmUrl });
      memory = (oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory;
      setOC(oc);
      post({ type: "ready", ms: performance.now() - t0 });
    } else build(request.model, request.params, request.mode);
  } catch (error) {
    post({ type: "error", message: String((error as Error)?.stack ?? error) });
  }
};
