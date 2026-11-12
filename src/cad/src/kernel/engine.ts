import type { Imports } from "./imports.ts";
import type { BuildParams, BuildTimings, Failure, ParamValues, FeatureTrace, InitTimings, MeshedShape, ModelError, RefData, ShownSketch, WorkerRequest, WorkerResponse } from "./protocol.ts";

/** A build's outcome; `imports` are the documents it was given, the same object, e.g. to tell which version of them it built with. */
export type BuildResult =
  | { ok: true; source: string; params: BuildParams | undefined; imports: Imports; paramValues: ParamValues; shapes: MeshedShape[]; sketches: ShownSketch[]; dropped: number; trace: FeatureTrace[]; timings: BuildTimings }
  | { ok: false; source: string; params: BuildParams | undefined; imports: Imports; error: ModelError; trace: FeatureTrace[]; timings: BuildTimings };

type Request = Exclude<WorkerRequest, { type: "build" }>;
type Answer = Extract<WorkerResponse, { type: "rolledBack" | "picked" | "resultMeshed" | "differenceMeshed" | "checked" | "located" | "refsMade" }>;

export interface EngineStats {
  /** Builds requested with build(). */
  requested: number;
  /** Builds the worker actually ran; the rest were superseded while waiting. */
  executed: number;
  /** Workers replaced because their OCCT heap grew past the limit or they stopped answering. */
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
 * How long a loaded worker that has work may go without answering before it is replaced. Neither a
 * hung OCCT call (an extrusion by 0 used to hang a later boolean) nor an endless loop in model code
 * can be interrupted inside the worker. Tests lower it through `globalThis.patchworkCadTimeout`.
 */
const TIMEOUT_MS = 10_000;

/**
 * One kernel worker per tool instance. Loading OCCT is the expensive part, so
 * a worker lives until its heap passes HEAP_LIMIT or it stops answering for
 * TIMEOUT_MS. Builds run one at a time; while one runs, only the newest
 * requested source waits, older ones are dropped.
 */
export class Engine {
  readonly #callbacks: EngineCallbacks;
  readonly #heapLimit: number;
  readonly #timeoutMs: number;
  readonly stats: EngineStats = { requested: 0, executed: 0, restarts: 0 };
  #worker: Worker;
  #heapBytes = 0;
  /** Whether the worker has loaded OCCT; the watchdog doesn't count the load. */
  #loaded = false;
  #watchdog: ReturnType<typeof setTimeout> | undefined;
  #running: { id: number; source: string; params: BuildParams | undefined; imports: Imports; started: number } | undefined;
  #waiting: { source: string; params: BuildParams | undefined; imports: Imports } | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();

  constructor(callbacks: EngineCallbacks) {
    this.#callbacks = callbacks;
    this.#heapLimit = (globalThis as { patchworkCadHeapLimit?: number }).patchworkCadHeapLimit ?? HEAP_LIMIT;
    this.#timeoutMs = (globalThis as { patchworkCadTimeout?: number }).patchworkCadTimeout ?? TIMEOUT_MS;
    this.#worker = this.#spawn();
  }

  /** Builds `source`, with `params` over its `defaultParams` (research/17-parameters.md) and the documents it imports. */
  build(source: string, params?: BuildParams, imports: Imports = {}): void {
    this.stats.requested++;
    if (this.#running) this.#waiting = { source, params, imports };
    else this.#start(source, params, imports);
  }

  /** The bodies visible before `feature` (or after it) in the last build, meshed for picking, and the sketches no feature used yet. */
  async rollback(feature: string, after = false): Promise<{ shapes: MeshedShape[]; sketches: ShownSketch[] }> {
    const answer = await this.#request({ type: "rollback", id: this.#nextId++, feature, after });
    return answer.type === "rolledBack" ? answer : { shapes: [], sketches: [] };
  }

  /** The reference for entity `index` of body `body` in the last build: its code, and as data. */
  async pick(body: string, kind: "face" | "edge", index: number): Promise<{ code: string; ref: RefData | undefined }> {
    const answer = await this.#request({ type: "pick", id: this.#nextId++, body, kind, index });
    return answer.type === "picked" ? { code: answer.code, ref: answer.ref } : { code: "", ref: undefined };
  }

  /** The references to `faces` of the last build, as data, null for a face that has none. */
  async refs(faces: { body: string; index: number }[]): Promise<(RefData | null)[]> {
    const answer = await this.#request({ type: "refs", id: this.#nextId++, faces });
    return answer.type === "refsMade" ? answer.refs : faces.map(() => null);
  }

  /** For each of `refs`, the entities it names in bodies `bodies` of the last build. */
  async locate(bodies: string[], refs: RefData[]): Promise<{ body: string; indices: number[] }[][]> {
    const answer = await this.#request({ type: "locate", id: this.#nextId++, bodies, refs });
    return answer.type === "located" ? answer.found : refs.map(() => []);
  }

  /** Body `body` of the last build, meshed, if there is one, e.g. a feature's result past the timeline marker. */
  async result(body: string): Promise<MeshedShape | undefined> {
    const answer = await this.#request({ type: "result", id: this.#nextId++, body });
    return answer.type === "resultMeshed" ? answer.shape : undefined;
  }

  /** The volume feature `feature` of the last build added to or removed from its input bodies, meshed (see `changedVolume`). */
  async difference(feature: string): Promise<MeshedShape[]> {
    const answer = await this.#request({ type: "difference", id: this.#nextId++, feature });
    return answer.type === "differenceMeshed" ? answer.shapes : [];
  }

  /** Builds `source` on trial, without showing it: whether it throws, and how many features are broken or failed, and which. */
  async check(source: string, params?: BuildParams, imports: Imports = {}): Promise<{ error: ModelError | undefined; problems: number; failures: Failure[] }> {
    const answer = await this.#request({ type: "check", id: this.#nextId++, source, imports, ...(params ? { params } : {}) });
    return answer.type === "checked" ? { error: answer.error, problems: answer.problems, failures: answer.failures } : { error: undefined, problems: 0, failures: [] };
  }

  dispose(): void {
    clearTimeout(this.#watchdog);
    this.#worker.terminate();
    for (const { reject } of this.#pending.values()) reject(new Error("kernel disposed"));
    this.#pending.clear();
  }

  #request(request: Request): Promise<Answer> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.id, { resolve, reject });
      this.#worker.postMessage(request);
      this.#watch();
    });
  }

  #spawn(): Worker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.#loaded = false;
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        this.#loaded = true;
        this.#callbacks.onReady(message.timings);
      } else if (message.type === "init-failed") this.#callbacks.onInitFailed(message.message);
      else if (message.type === "rolledBack" || message.type === "picked" || message.type === "resultMeshed" || message.type === "differenceMeshed" || message.type === "checked" || message.type === "located" || message.type === "refsMade" || message.type === "requestFailed") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.type === "requestFailed") pending?.reject(new Error(message.message));
        else pending?.resolve(message);
      } else this.#finished(message);
      this.#watch();
    });
    worker.addEventListener("error", (event) => {
      if (!this.#loaded) this.#callbacks.onInitFailed(event.message || "kernel worker failed to start");
    });
    return worker;
  }

  /** Restarts the watchdog while the loaded worker has work, i.e. after it got some or answered. */
  #watch(): void {
    clearTimeout(this.#watchdog);
    const busy = this.#running !== undefined || this.#pending.size > 0;
    this.#watchdog = this.#loaded && busy ? setTimeout(() => this.#stuck(), this.#timeoutMs) : undefined;
  }

  #restart(): void {
    clearTimeout(this.#watchdog);
    this.#worker.terminate();
    for (const { reject } of this.#pending.values()) reject(new Error("kernel restarted"));
    this.#pending.clear();
    this.#worker = this.#spawn();
    this.#heapBytes = 0;
    this.stats.restarts++;
  }

  /** The worker hasn't answered for TIMEOUT_MS: the running build fails, and the next one starts in a new worker. */
  #stuck(): void {
    const running = this.#running;
    this.#running = undefined;
    this.#restart();
    if (this.#waiting !== undefined) {
      const next = this.#waiting;
      this.#waiting = undefined;
      this.#start(next.source, next.params, next.imports);
    }
    if (!running) return;
    const ms = performance.now() - running.started;
    const error: ModelError = { kind: "kernel", line: undefined, message: `the build didn't finish within ${this.#timeoutMs / 1000} s, so the kernel was restarted` };
    this.#callbacks.onResult({ ok: false, source: running.source, params: running.params, imports: running.imports, error, trace: [], timings: { build: ms, total: ms } });
  }

  #start(source: string, params: BuildParams | undefined, imports: Imports): void {
    // Restarting before a build, not after one, keeps the worker that holds the
    // shown shapes alive until a new build replaces them.
    if (this.#heapBytes > this.#heapLimit) this.#restart();
    this.stats.executed++;
    this.#running = { id: this.#nextId++, source, params, imports, started: performance.now() };
    // A new worker runs it as soon as OCCT has loaded.
    this.#worker.postMessage({ type: "build", id: this.#running.id, source, imports, ...(params ? { params } : {}) });
    this.#watch();
  }

  #finished(message: Extract<WorkerResponse, { type: "built" | "failed" }>): void {
    const running = this.#running;
    if (!running || running.id !== message.id) return;
    this.#running = undefined;
    this.#heapBytes = message.heapBytes;
    if (this.#waiting !== undefined) {
      const next = this.#waiting;
      this.#waiting = undefined;
      this.#start(next.source, next.params, next.imports);
    }
    const { onResult } = this.#callbacks;
    if (message.type === "built") onResult({ ok: true, source: running.source, params: running.params, imports: running.imports, paramValues: message.paramValues, shapes: message.shapes, sketches: message.sketches, dropped: message.dropped, trace: message.trace, timings: message.timings });
    else onResult({ ok: false, source: running.source, params: running.params, imports: running.imports, error: message.error, trace: message.trace, timings: message.timings });
  }
}
