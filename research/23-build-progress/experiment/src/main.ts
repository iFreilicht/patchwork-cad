import { HEAP_LIMIT, type Mode, type ModelName, type WorkerReply, type WorkerRequest } from "./protocol.ts";

/** Drives one kernel worker at a time; Playwright calls this through window.experiment. */
let worker: Worker | undefined;
/** OCCT's heap after the last build. */
let heapBytes = 0;
let restarts = 0;

const stamp = () => performance.timeOrigin + performance.now();

type Progress = Extract<WorkerReply, { type: "progress" }> & { received: number };
type Built = Extract<WorkerReply, { type: "built" }>;

export interface PageBuild {
  built: Built;
  /** Progress messages, with when the page got them. */
  progress: Progress[];
  /** Milliseconds from posting the build to receiving its result. */
  pageMs: number;
  /** Animation frames the page drew while the build ran. */
  frames: number;
  /** When the build was posted, by the page's clock. */
  posted: number;
}

/** Blocks the page's main thread for `ms`, as a long task of a busy page. */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

const experiment = {
  restarts: () => restarts,
  /** A new worker, as the tool's engine makes when it restarts; resolves with the milliseconds until OCCT is ready. */
  start(): Promise<number> {
    worker?.terminate();
    const t0 = performance.now();
    const current = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker = current;
    return new Promise((resolve, reject) => {
      current.onmessage = (event: MessageEvent<WorkerReply>) => (event.data.type === "ready" ? resolve(performance.now() - t0) : reject(new Error(JSON.stringify(event.data))));
      current.onerror = (event) => reject(new Error(event.message));
      current.postMessage({ type: "init" } satisfies WorkerRequest);
    });
  },
  /** Builds a model; with `blockMs`, the page's main thread is blocked that long, 50 ms after the build was posted. */
  async build(model: ModelName, params: Record<string, unknown>, mode: Mode, blockMs = 0): Promise<PageBuild> {
    // Before the build, not timed: OCCT leaks in fillets and booleans (research/08).
    if (heapBytes > HEAP_LIMIT) {
      await experiment.start();
      heapBytes = 0;
      restarts++;
    }
    const current = worker;
    if (!current) return Promise.reject(new Error("call start() first"));
    const progress: Progress[] = [];
    let frames = 0;
    let running = true;
    const frame = () => {
      if (!running) return;
      frames++;
      requestAnimationFrame(frame);
    };
    return new Promise((resolve, reject) => {
      const posted = stamp();
      current.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply.type === "progress") progress.push({ ...reply, received: stamp() });
        else if (reply.type === "built") {
          running = false;
          heapBytes = reply.heapBytes;
          resolve({ built: reply, progress, pageMs: stamp() - posted, frames, posted });
        } else reject(new Error(JSON.stringify(reply)));
      };
      current.onerror = (event) => reject(new Error(event.message));
      current.postMessage({ type: "build", model, params, mode } satisfies WorkerRequest);
      requestAnimationFrame(frame);
      if (blockMs) setTimeout(() => block(blockMs), 50);
    });
  },
};

declare global {
  interface Window {
    experiment: typeof experiment;
  }
}
window.experiment = experiment;
document.title = "ready";
