import { Engine, type BuildResult } from "../kernel/engine.ts";
import type { Imports } from "../kernel/imports.ts";

/** How long the kernel worker stays loaded after the last build: OCCT takes a while to load and holds hundreds of MB. */
const IDLE_MS = 60_000;

let engine: Engine | undefined;
let waiting: { resolve: (result: BuildResult) => void; reject: (error: Error) => void } | undefined;
let queue: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;

const release = () => {
  engine?.dispose();
  engine = undefined;
};

const kernel = () =>
  (engine ??= new Engine({
    onResult: (result) => {
      const w = waiting;
      waiting = undefined;
      w?.resolve(result);
    },
    onReady: () => {},
    onInitFailed: (message) => {
      const w = waiting;
      waiting = undefined;
      release();
      w?.reject(new Error(`the CAD kernel didn't load: ${message}`));
    },
  }));

/**
 * Builds a model in the one kernel worker that every model in a scene shares, one build at a time:
 * the Engine keeps only the newest of overlapping builds, and each model here needs its own answer.
 */
export function buildModel(source: string, imports: Imports): Promise<BuildResult> {
  const run = queue.then(
    () =>
      new Promise<BuildResult>((resolve, reject) => {
        clearTimeout(idle);
        waiting = { resolve, reject };
        kernel().build(source, undefined, imports);
      }),
  );
  queue = run
    .catch(() => {})
    .then(() => {
      clearTimeout(idle);
      idle = setTimeout(release, IDLE_MS);
    });
  return run;
}
