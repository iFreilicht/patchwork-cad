import type { RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { ReplicadMeshedEdges, ReplicadMeshedFaces } from "replicad-threejs-helper";

/** Milliseconds per phase, measured inside the worker with performance.now(). */
export interface InitTimings {
  /** Fetching and compiling OCCT's wasm (WebAssembly.compileStreaming). */
  compile: number;
  /** Instantiating it and running OCCT's static initialisation. */
  instantiate: number;
  wasmBytes: number;
  /** Whether the wasm came from the Cache API. */
  cached: boolean;
}

export interface BuildTimings {
  /** Evaluating the model code and running main(), including all kernel calls. */
  build: number;
  total: number;
}

export interface MeshedShape {
  name: string;
  color: string | undefined;
  opacity: number | undefined;
  faces: ReplicadMeshedFaces;
  edges: ReplicadMeshedEdges | undefined;
  /** The feature-library body this shape shows, if it is one; its faces and edges can be picked. */
  body: string | undefined;
  /** For each of `faces.faceGroups`, the face's index in the body (-1 if unknown). */
  faceIndex: number[] | undefined;
  /** For each of `edges.edgeGroups`, the edge's index in the body. */
  edgeIndex: number[] | undefined;
}

/** One executed feature call, from the feature library's trace. */
export interface FeatureTrace {
  name: string;
  type: string;
  line: number | undefined;
  variable: boolean;
  status: "ok" | "broken" | "failed";
  message: string | undefined;
  refs: RefDiagnostic[];
  /** Names of the bodies visible before the feature ran. */
  before: string[];
  result: string | undefined;
  /** All bodies it made: several for a destructured `body()` (research/11). */
  results: string[];
  /** The variables of a destructured `body()`. */
  names: string[] | undefined;
  /** A sketch's profile as a closed polyline in world coordinates. */
  outline: [number, number, number][] | undefined;
  /** The feature's body is used by no later feature and not returned by main, so it doesn't show. */
  unused: boolean;
  /** Milliseconds the feature took, and the part spent naming faces and edges. */
  ms: number;
  namingMs: number;
}

export interface ModelError {
  message: string;
  /** 1-based line in the model source, when it can be determined. */
  line: number | undefined;
  kind: "import" | "syntax" | "runtime" | "kernel" | "mesh";
}

export type WorkerRequest =
  | { type: "build"; id: number; source: string }
  /** The bodies visible before feature `feature` of the last build (or after it), for picking while it is edited and for the timeline marker. */
  | { type: "rollback"; id: number; feature: string; after?: boolean }
  /** The reference code for entity `index` of body `body` of the last build. */
  | { type: "pick"; id: number; body: string; kind: "face" | "edge"; index: number }
  /** A trial build of `source` without meshing, e.g. before moving a Custom Script; it leaves the last build as it is. */
  | { type: "check"; id: number; source: string };

export type WorkerResponse =
  | { type: "ready"; timings: InitTimings }
  | { type: "init-failed"; message: string }
  | { type: "built"; id: number; shapes: MeshedShape[]; trace: FeatureTrace[]; timings: BuildTimings; heapBytes: number }
  | { type: "failed"; id: number; error: ModelError; trace: FeatureTrace[]; timings: BuildTimings; heapBytes: number }
  | { type: "rolledBack"; id: number; shapes: MeshedShape[] }
  | { type: "picked"; id: number; code: string }
  /** The trial build's error, or how many of its features are broken or failed. */
  | { type: "checked"; id: number; error: ModelError | undefined; problems: number }
  | { type: "requestFailed"; id: number; message: string };
