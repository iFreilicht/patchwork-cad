import type { BuildTimings, InitTimings, MeshedShape, ModelError, WorkerResponse } from "./protocol.ts";

export type BuildResult =
  | { ok: true; source: string; shapes: MeshedShape[]; timings: BuildTimings }
  | { ok: false; source: string; error: ModelError; timings: BuildTimings };

export interface EngineStats {
  /** Builds requested with build(). */
  requested: number;
  /** Builds the worker actually ran; the rest were superseded while waiting. */
  executed: number;
  /** Workers replaced because their OCCT heap grew past the limit. */
  restarts: number;
}

export interface EngineCallbacks {
  onResult: (result: BuildResult) => void;
  /** OCCT has loaded, in the first worker or in a replacement. */
  onReady: (timings: InitTimings) => void;
  onInitFailed: (message: string) => void;
}

/**
 * OCCT's heap at which the worker is replaced before the next build. Its
 * memory only grows, and fillet, chamfer and fuse leak about 0.7 MB per build
 * of a small part (research/08); a fresh worker costs a warm OCCT load.
 * Tests lower it through `globalThis.patchworkCadHeapLimit`.
 */
const HEAP_LIMIT = 2 ** 30;

/**
 * One kernel worker per tool instance. Loading OCCT is the expensive part, so
 * a worker lives until its heap passes HEAP_LIMIT. Builds run one at a time;
 * while one runs, only the newest requested source waits, older ones are
 * dropped.
 */
export class Engine {
  readonly #callbacks: EngineCallbacks;
  readonly #heapLimit: number;
  readonly stats: EngineStats = { requested: 0, executed: 0, restarts: 0 };
  #worker: Worker;
  #heapBytes = 0;
  #running: { id: number; source: string } | undefined;
  #waiting: string | undefined;
  #nextId = 1;

  constructor(callbacks: EngineCallbacks) {
    this.#callbacks = callbacks;
    this.#heapLimit = (globalThis as { patchworkCadHeapLimit?: number }).patchworkCadHeapLimit ?? HEAP_LIMIT;
    this.#worker = this.#spawn();
  }

  build(source: string): void {
    this.stats.requested++;
    if (this.#running) this.#waiting = source;
    else this.#start(source);
  }

  dispose(): void {
    this.#worker.terminate();
  }

  #spawn(): Worker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    let loaded = false;
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        loaded = true;
        this.#callbacks.onReady(message.timings);
      } else if (message.type === "init-failed") this.#callbacks.onInitFailed(message.message);
      else this.#finished(message);
    });
    worker.addEventListener("error", (event) => {
      if (!loaded) this.#callbacks.onInitFailed(event.message || "kernel worker failed to start");
    });
    return worker;
  }

  #start(source: string): void {
    // Restarting before a build, not after one, keeps the worker that holds the
    // shown shapes alive until a new build replaces them.
    if (this.#heapBytes > this.#heapLimit) {
      this.#worker.terminate();
      this.#worker = this.#spawn();
      this.#heapBytes = 0;
      this.stats.restarts++;
    }
    this.stats.executed++;
    this.#running = { id: this.#nextId++, source };
    // A new worker runs it as soon as OCCT has loaded.
    this.#worker.postMessage({ type: "build", id: this.#running.id, source });
  }

  #finished(message: Extract<WorkerResponse, { id: number }>): void {
    const running = this.#running;
    if (!running || running.id !== message.id) return;
    this.#running = undefined;
    this.#heapBytes = message.heapBytes;
    if (this.#waiting !== undefined) {
      const next = this.#waiting;
      this.#waiting = undefined;
      this.#start(next);
    }
    const { onResult } = this.#callbacks;
    if (message.type === "built") onResult({ ok: true, source: running.source, shapes: message.shapes, timings: message.timings });
    else onResult({ ok: false, source: running.source, error: message.error, timings: message.timings });
  }
}
