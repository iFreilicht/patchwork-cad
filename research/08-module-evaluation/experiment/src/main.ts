import type { DirectMode, M1Step, Variant, WorkerReply, WorkerRequest } from "./protocol.ts";

/** Drives one kernel worker at a time; Playwright calls this through window.experiment. */
let worker: Worker | undefined;

function call(request: WorkerRequest): Promise<WorkerReply> {
  const current = worker;
  if (!current) return Promise.reject(new Error("call start() first"));
  return new Promise((resolve, reject) => {
    current.onmessage = (event: MessageEvent<WorkerReply>) =>
      event.data.type === "error" ? reject(new Error(event.data.message)) : resolve(event.data);
    current.onerror = (event) => reject(new Error(event.message));
    current.postMessage(request);
  });
}

const experiment = {
  start(variant: Variant) {
    worker?.terminate();
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return call({ type: "init", variant });
  },
  build: (source: string) => call({ type: "build", source }),
  direct: (mode: DirectMode, until?: M1Step) => call(until ? { type: "direct", mode, until } : { type: "direct", mode }),
  probe: () => call({ type: "probe" }),
};

declare global {
  interface Window {
    experiment: typeof experiment;
  }
}
window.experiment = experiment;
document.title = "ready";
