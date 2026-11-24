import { Engine, type BuildResult } from "../kernel/engine.ts";
import type { Imports } from "../kernel/imports.ts";
import type { BuildParams, RefData } from "../kernel/protocol.ts";

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

/** Where references are in a build: for each, the faces or edges of the bodies that have them. */
export type Located = { body: string; indices: number[] }[][];

/**
 * Builds a model in the one kernel worker that every model in a scene shares, one build at a time:
 * the Engine keeps only the newest of overlapping builds, and each model here needs its own answer.
 * `refs` are located in the build before the next one starts, e.g. the faces canvases lie on.
 */
export function buildModel(source: string, imports: Imports, params?: BuildParams, refs: RefData[] = []): Promise<{ result: BuildResult; located: Located }> {
  const run = queue.then(
    () =>
      new Promise<{ result: BuildResult; located: Located }>((resolve, reject) => {
        clearTimeout(idle);
        waiting = {
          resolve: (result) => {
            const bodies = result.ok ? [...new Set(result.shapes.flatMap((s) => (s.body ? [s.body] : [])))] : [];
            if (!refs.length || !bodies.length || !engine) return resolve({ result, located: refs.map(() => []) });
            engine.locate(bodies, refs).then(
              (located) => resolve({ result, located }),
              () => resolve({ result, located: refs.map(() => []) }),
            );
          },
          reject,
        };
        kernel().build(source, params, imports);
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
