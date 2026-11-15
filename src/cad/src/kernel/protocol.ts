import type { Owned, RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { ReplicadMeshedEdges, ReplicadMeshedFaces } from "replicad-threejs-helper";
import type { Imports } from "./imports.ts";

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
  /** The body's faces and edges by the feature that created or split them (research/12). */
  features: Owned | undefined;
}

/** A polyline in world coordinates, e.g. a path of a sketch's profile. */
export interface Polyline {
  points: [number, number, number][];
  closed: boolean;
}

/** A region of a sketch: a part of its plane that its curves bound on every side. */
export interface SketchRegion {
  /** The code that names it, e.g. `sketch2.region("a", "b")`. */
  code: string;
  /** Whether a fill of the profile covers it, e.g. a letter but not its hole. */
  filled: boolean;
  /** Its triangles in world coordinates: x, y and z of each corner, three corners each. */
  triangles: number[];
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
  /** Names of the bodies it worked on, its body or target first, e.g. to tell which body a pick is on. */
  inputs: string[];
  result: string | undefined;
  /** All bodies it made: several for a destructured `body()` (research/11). */
  results: string[];
  /** The variables of a destructured `body()`. */
  names: string[] | undefined;
  /** A sketch's paths as polylines in world coordinates. */
  outline: Polyline[] | undefined;
  /** What of its input it couldn't use, e.g. an SVG's elements that aren't drawn. */
  warnings: string[] | undefined;
  /** A sketch's width and height on its plane. */
  size?: [number, number] | undefined;
  /** A sketch's regions, which an extrusion picks (research/21, "Sketch from a drawing"). */
  regions?: SketchRegion[] | undefined;
  /** The feature's body or sketch is used by no later feature and not returned by main, so it doesn't show. */
  unused: boolean;
  /** Milliseconds the feature took, and the part spent naming faces and edges. */
  ms: number;
  namingMs: number;
}

/** A sketch the view shows: one that main returned, or at a rollback one that no feature used yet. */
export interface ShownSketch {
  name: string;
  /** Its paths as polylines in world coordinates. */
  outline: Polyline[];
}

/** A reference to faces or edges as data (`RefData` of the feature library), e.g. a collaborator's pick; its names are opaque here. */
export interface RefData {
  kind: "face" | "edge";
  names: unknown[];
  near?: readonly [number, number, number];
}

/** A feature of a build that is broken or failed, by its name. */
export interface Failure {
  name: string;
  status: "broken" | "failed";
  message: string | undefined;
}

export interface ModelError {
  message: string;
  /** 1-based line in the model source, when it can be determined. */
  line: number | undefined;
  kind: "import" | "syntax" | "runtime" | "kernel" | "mesh";
}

/** Values of a model's parameters, by key, that replace those of its `defaultParams`. */
export type BuildParams = Record<string, unknown>;

/** What a build's parameters and derived parameters were, as far as they are JSON (research/17-parameters.md). */
export interface ParamValues {
  params: Record<string, unknown>;
  derived: Record<string, unknown>;
}

export type WorkerRequest =
  /** `params`: values of parameters that replace the model's defaults (research/17-parameters.md); `imports`: the documents it imports. */
  | { type: "build"; id: number; source: string; params?: BuildParams; imports?: Imports }
  /** The bodies visible before feature `feature` of the last build (or after it), for picking while it is edited and for the timeline marker. */
  | { type: "rollback"; id: number; feature: string; after?: boolean }
  /** The reference code for entity `index` of body `body` of the last build. */
  | { type: "pick"; id: number; body: string; kind: "face" | "edge"; index: number }
  /** Body `body` of the last build, meshed, e.g. a feature's result past the timeline marker. */
  | { type: "result"; id: number; body: string }
  /** The volume feature `feature` of the last build added or removed, meshed, for hovering a feature whose schema says `hover: "difference"`. */
  | { type: "difference"; id: number; feature: string }
  /** The references to faces of the last build, as data, e.g. what a close-up shows (research/20). */
  | { type: "refs"; id: number; faces: { body: string; index: number }[] }
  /** The entities of bodies `bodies` of the last build that each of `refs` names, e.g. collaborators' picks. */
  | { type: "locate"; id: number; bodies: string[]; refs: RefData[] }
  /** A trial build of `source` without meshing, e.g. before moving a Custom Script; it leaves the last build as it is. */
  | { type: "check"; id: number; source: string; params?: BuildParams; imports?: Imports }
  /** What the JS module of document `specifier` exports, as far as it is JSON, run with `imports`, the documents it imports and itself (research/21, "Dropping, pasting, inserting"). */
  | { type: "exports"; id: number; specifier: string; imports: Imports };

export type WorkerResponse =
  | { type: "ready"; timings: InitTimings }
  | { type: "init-failed"; message: string }
  /** `dropped`: how many of the values main returned can't be shown, e.g. a string. */
  | { type: "built"; id: number; shapes: MeshedShape[]; sketches: ShownSketch[]; dropped: number; trace: FeatureTrace[]; timings: BuildTimings; heapBytes: number; paramValues: ParamValues }
  | { type: "failed"; id: number; error: ModelError; trace: FeatureTrace[]; timings: BuildTimings; heapBytes: number }
  | { type: "rolledBack"; id: number; shapes: MeshedShape[]; sketches: ShownSketch[] }
  | { type: "picked"; id: number; code: string; ref: RefData }
  /** For each of the request's faces, its reference, null if it has none, e.g. its body is gone. */
  | { type: "refsMade"; id: number; refs: (RefData | null)[] }
  /** For each of the request's refs, the entities it names, by body. */
  | { type: "located"; id: number; found: { body: string; indices: number[] }[][] }
  | { type: "resultMeshed"; id: number; shape: MeshedShape | undefined }
  | { type: "differenceMeshed"; id: number; shapes: MeshedShape[] }
  /** The trial build's error, or how many of its features are broken or failed, and which. */
  | { type: "checked"; id: number; error: ModelError | undefined; problems: number; failures: Failure[] }
  | { type: "exported"; id: number; value: unknown }
  | { type: "requestFailed"; id: number; message: string };
