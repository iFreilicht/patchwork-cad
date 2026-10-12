import type { BuildTimings, InitTimings, MeshedShape, ModelError, WorkerResponse } from "./protocol.ts";

export type BuildResult =
  | { ok: true; source: string; shapes: MeshedShape[]; timings: BuildTimings }
  | { ok: false; source: string; error: ModelError; timings: BuildTimings };

export interface EngineStats {
  /** Builds requested with build(). */
  requested: number;
  /** Builds the worker actually ran; the rest were superseded while waiting. */
  executed: number;
}

/**
 * One kernel worker per tool instance. Loading OCCT is the expensive part, so
 * the worker lives as long as the view. Builds run one at a time; while one
 * runs, only the newest requested source waits, older ones are dropped.
 */
export class Engine {
  readonly #worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  readonly #onResult: (result: BuildResult) => void;
  readonly ready: Promise<InitTimings>;
  readonly stats: EngineStats = { requested: 0, executed: 0 };
  #running: { id: number; source: string } | undefined;
  #waiting: string | undefined;
  #nextId = 1;

  constructor(onResult: (result: BuildResult) => void) {
    this.#onResult = onResult;
    this.ready = new Promise((resolve, reject) => {
      this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === "ready") resolve(message.timings);
        else if (message.type === "init-failed") reject(new Error(message.message));
        else this.#finished(message);
      });
      this.#worker.addEventListener("error", (event) => reject(new Error(event.message || "kernel worker failed to start")));
    });
  }

  build(source: string): void {
    this.stats.requested++;
    if (this.#running) this.#waiting = source;
    else this.#start(source);
  }

  dispose(): void {
    this.#worker.terminate();
  }

  #start(source: string): void {
    this.stats.executed++;
    this.#running = { id: this.#nextId++, source };
    this.#worker.postMessage({ type: "build", id: this.#running.id, source });
  }

  #finished(message: Extract<WorkerResponse, { id: number }>): void {
    const running = this.#running;
    if (!running || running.id !== message.id) return;
    this.#running = undefined;
    if (this.#waiting !== undefined) {
      const next = this.#waiting;
      this.#waiting = undefined;
      this.#start(next);
    }
    if (message.type === "built") this.#onResult({ ok: true, source: running.source, shapes: message.shapes, timings: message.timings });
    else this.#onResult({ ok: false, source: running.source, error: message.error, timings: message.timings });
  }
}
