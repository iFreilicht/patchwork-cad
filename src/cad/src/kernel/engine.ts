import type { BuildTimings, FeatureTrace, InitTimings, MeshedShape, ModelError, WorkerRequest, WorkerResponse } from "./protocol.ts";

export type BuildResult =
  | { ok: true; source: string; shapes: MeshedShape[]; trace: FeatureTrace[]; timings: BuildTimings }
  | { ok: false; source: string; error: ModelError; trace: FeatureTrace[]; timings: BuildTimings };

type Request = Exclude<WorkerRequest, { type: "build" }>;
type Answer = Extract<WorkerResponse, { type: "rolledBack" | "picked" | "resultMeshed" | "checked" }>;

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
  readonly #pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();

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

  /** The bodies visible before `feature` (or after it) in the last build, meshed for picking. */
  async rollback(feature: string, after = false): Promise<MeshedShape[]> {
    const answer = await this.#request({ type: "rollback", id: this.#nextId++, feature, after });
    return answer.type === "rolledBack" ? answer.shapes : [];
  }

  /** The reference code for entity `index` of body `body` in the last build. */
  async pick(body: string, kind: "face" | "edge", index: number): Promise<string> {
    const answer = await this.#request({ type: "pick", id: this.#nextId++, body, kind, index });
    return answer.type === "picked" ? answer.code : "";
  }

  /** Body `body` of the last build, meshed, if there is one, e.g. a feature's result past the timeline marker. */
  async result(body: string): Promise<MeshedShape | undefined> {
    const answer = await this.#request({ type: "result", id: this.#nextId++, body });
    return answer.type === "resultMeshed" ? answer.shape : undefined;
  }

  /** Builds `source` on trial, without showing it: whether it throws, and how many features are broken or failed. */
  async check(source: string): Promise<{ error: ModelError | undefined; problems: number }> {
    const answer = await this.#request({ type: "check", id: this.#nextId++, source });
    return answer.type === "checked" ? { error: answer.error, problems: answer.problems } : { error: undefined, problems: 0 };
  }

  dispose(): void {
    this.#worker.terminate();
    for (const { reject } of this.#pending.values()) reject(new Error("kernel disposed"));
    this.#pending.clear();
  }

  #request(request: Request): Promise<Answer> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.id, { resolve, reject });
      this.#worker.postMessage(request);
    });
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
      else if (message.type === "rolledBack" || message.type === "picked" || message.type === "resultMeshed" || message.type === "checked" || message.type === "requestFailed") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.type === "requestFailed") pending?.reject(new Error(message.message));
        else pending?.resolve(message);
      } else this.#finished(message);
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
      for (const { reject } of this.#pending.values()) reject(new Error("kernel restarted"));
      this.#pending.clear();
      this.#worker = this.#spawn();
      this.#heapBytes = 0;
      this.stats.restarts++;
    }
    this.stats.executed++;
    this.#running = { id: this.#nextId++, source };
    // A new worker runs it as soon as OCCT has loaded.
    this.#worker.postMessage({ type: "build", id: this.#running.id, source });
  }

  #finished(message: Extract<WorkerResponse, { type: "built" | "failed" }>): void {
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
    if (message.type === "built") onResult({ ok: true, source: running.source, shapes: message.shapes, trace: message.trace, timings: message.timings });
    else onResult({ ok: false, source: running.source, error: message.error, trace: message.trace, timings: message.timings });
  }
}
