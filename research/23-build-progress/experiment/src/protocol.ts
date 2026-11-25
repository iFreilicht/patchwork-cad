export type ModelName = "m1" | "m3" | "plate";

/**
 * What the worker reports while a build runs:
 * - none: nothing, as the tool's worker today
 * - events: a message after every feature, with its name, status and time
 * - mesh: events, and the bodies each feature made, meshed
 * - throttled: events, and every body visible after a feature, meshed, at most every THROTTLE_MS
 * - budget: as throttled, but also waits until meshing has taken at most MESH_BUDGET of the time since the last meshing began
 */
export type Mode = "none" | "events" | "mesh" | "throttled" | "budget";
export const THROTTLE_MS = 250;
export const MESH_BUDGET = 0.1;
export const HEAP_LIMIT = 2 ** 30;

export type WorkerRequest =
  | { type: "init" }
  | { type: "build"; model: ModelName; params: Record<string, unknown>; mode: Mode };

/** Wall-clock milliseconds: performance.timeOrigin + performance.now(), comparable between page and worker. */
export type Stamp = number;

export interface FeatureDone {
  index: number;
  name: string;
  type: string;
  status: string;
  ms: number;
}

export type WorkerReply =
  | { type: "ready"; ms: number }
  | { type: "progress"; sent: Stamp; feature: FeatureDone; meshes: { triangles: number; ms: number }[] }
  | {
      type: "built";
      sent: Stamp;
      /** main() including the time spent reporting progress. */
      buildMs: number;
      /** Meshing the returned bodies, as the tool does after main(). */
      finalMeshMs: number;
      /** Time spent inside the progress hook: meshing and posting. */
      reportMs: number;
      /** Of reportMs, the part spent meshing. */
      reportMeshMs: number;
      messages: number;
      trace: FeatureDone[];
      problems: string[];
      /** OCCT's heap after the build; the page restarts the worker past HEAP_LIMIT, as the tool does (research/08). */
      heapBytes: number;
    }
  | { type: "error"; message: string };
