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
}

export interface ModelError {
  message: string;
  /** 1-based line in the model source, when it can be determined. */
  line: number | undefined;
  kind: "import" | "syntax" | "runtime" | "kernel" | "mesh";
}

export type WorkerRequest = { type: "build"; id: number; source: string };

export type WorkerResponse =
  | { type: "ready"; timings: InitTimings }
  | { type: "init-failed"; message: string }
  | { type: "built"; id: number; shapes: MeshedShape[]; timings: BuildTimings }
  | { type: "failed"; id: number; error: ModelError; timings: BuildTimings };
