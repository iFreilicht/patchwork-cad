export type Variant = "as-is" | "memo";

/** Control without evaluator and modules: M1 built by worker code, optionally meshed and deleted. */
export type DirectMode = "build" | "build+mesh" | "build+mesh+delete";

/** M1's operations, in order; a bisection run stops after one of them. */
export const M1_STEPS = ["extrude", "cut", "fillet", "chamfer", "fuse"] as const;
export type M1Step = (typeof M1_STEPS)[number];

export type WorkerRequest =
  | { type: "init"; variant: Variant }
  | { type: "build"; source: string }
  | { type: "direct"; mode: DirectMode; until?: M1Step }
  | { type: "probe" };

export type WorkerReply =
  | { type: "ready"; wasmBytes: number }
  | {
      type: "built";
      ms: number;
      error: string | undefined;
      /** How often the evaluator imported the model module during the build. */
      imports: number;
      /** How often the model's top level ran, counted by the model itself. */
      topLevelRuns: number;
      wasmBytes: number;
    }
  | {
      type: "probed";
      /** Whether gc() was available (Chromium with --expose-gc) and ran before counting. */
      collected: boolean;
      /** Canary: whether gc() collected a fresh unreachable object and ran its finalizer. */
      canaryCollected: boolean;
      canaryFinalized: boolean;
      modulesAlive: number;
      modulesTotal: number;
      wasmBytes: number;
    }
  | { type: "direct-built"; ms: number; wasmBytes: number }
  | { type: "error"; message: string };
