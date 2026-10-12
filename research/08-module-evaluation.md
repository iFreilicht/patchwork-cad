# Module Evaluation per Build

How often the CAD tool ([06](06-poc-replicad-in-patchwork.md)) evaluates a model per build, what that costs, and whether memory is released between builds. Experiment: [08-module-evaluation/experiment/](08-module-evaluation/experiment/), run with `pnpm --filter module-evaluation-experiment experiment` in `nix develop` (about 20 minutes for all three browsers); results in its `results-*.json`.

## Setup

A page without Patchwork runs a worker built like the tool's kernel worker ([`worker.ts`](../src/cad/src/kernel/worker.ts)): `replicad-evaluator`'s builder with the tool's [`prepare`](../src/cad/src/kernel/prepare.ts), replicad and `replicad-opencascadejs` 1.1.0. It differs only in loading the wasm without the Cache API. Two evaluator variants:
- **as-is:** as in the tool, every `evaluateModule` call imports the model.
- **memo:** within one build, a second `evaluateModule` of the same source returns the first call's module.

The models are M1 from [03](03-topological-naming.md) with its kernel work either inside `main` (as in the tool's specs) or at the top level, with `main` returning the result. Each counts its top-level runs in a global. Chromium 147 runs with `--js-flags=--expose-gc`, so the worker can force collections; a canary `WeakRef` and `FinalizationRegistry` confirm before every count that collection and finalizers ran. Firefox 148 and WebKit 26.4 have no forced collection. OCCT's heap is `oc.wasmMemory.buffer.byteLength`, a high-water mark that grows in steps of 27–36 MB.

## Results

### Every build evaluates the model twice

`buildShapesFromCode` calls `runCode(code, params)`, which imports the module and calls `main`, and then `extractDefaultNameFromCode(code)`, which imports it again (`(await evaluateModule(code)).defaultName`) only to read `defaultName`. Each import is a new blob URL, so the module's top level runs again. Measured: 2 imports and 2 top-level runs per build as-is, 1 and 1 with memo, in all three browsers.

| median build | Chromium | Firefox | WebKit |
|---|---|---|---|
| work in `main`, as-is | 31.9 ms | 148 ms | 46 ms |
| work in `main`, memo | 30.6 ms | 147 ms | 43 ms |
| work at top level, as-is | 53.6 ms | 277 ms | 67 ms |
| work at top level, memo | 30.5 ms | 147 ms | 44 ms |

The second evaluation costs 1–3 ms when the model's work is inside `main`, but nearly doubles the build when it is at the top level, a legitimate way to write a portable model. The memo variant removes it completely.

### Modules are never released

In Chromium, all 400 (as-is) or 200 (memo) model modules of 200 builds were still reachable after forced collections, while the canary was collected. A dynamically imported module stays in the worker's module map even after its blob URL is revoked, together with everything its top level references. In Firefox and WebKit this couldn't be checked without forced collection.

The memory this costs is not visible next to the following leak: a model that keeps one M1 alive at its top level per build (memo, top level) grew exactly like one that keeps nothing (memo, in `main`).

### OCCT memory leaks in fillet, chamfer and fuse

The heap grows on every build, independently of the evaluator. M1 built 200 times by plain worker code, without evaluator or modules, grew from 100 to 199 MB, the same as through the evaluator. It grew the same with or without meshing, with an explicit `delete()` of the result, with a collection after every build, and in all three browsers. Since replicad frees OCCT objects only through `FinalizationRegistry` or `delete()` (`deletetableRegistry = new FinalizationRegistry((heldValue) => { … heldValue.delete(); })`), memory that no collection affects is never handed to replicad's wrappers or is held inside OCCT.

Stopping M1 after each of its operations (meshed, deleted, collection after every build):

| M1 up to | heap after 200 builds |
|---|---|
| extrude | 100 MB |
| cut | 100 MB |
| fillet | 127 MB |
| chamfer | 127 MB |
| fuse | 199 MB |

Over 1000 builds of the full M1 the heap grew to 811 MB with no sign of a plateau, about 0.7 MB per build, identically in all three browsers. At that rate a worker reaches wasm32's 4 GB limit after roughly 5000 builds of a model like M1, i.e. edits in one session. The as-is evaluator doubles the rate for models with top-level work, because it runs their kernel work twice (413 MB after 200 builds).

## Conclusions

- **The double evaluation is an implementation detail of `replicad-evaluator`, not a design limitation:** the first import already has `defaultName`. The memo wrapper in our `codeEvaluator` fixes it without forking.
- **Module retention is inherent to evaluating models as ES modules** through `import()`, with or without the memo. Its own memory cost is small for M1, but it keeps any top-level state of every past build alive.
- **The OCCT leak is the real memory problem,** and it is independent of the evaluator. Which objects leak, in replicad's fillet, chamfer and fuse or in OCCT itself, is not known yet. Restarting the kernel worker when the heap passes a threshold bounds both the leak and module retention, at the cost of a warm OCCT load (100–200 ms, 0.9 s in Firefox, [06](06-poc-replicad-in-patchwork.md#re-run-cost)). The sandbox runner ([05](05-sandboxing.md)) needs a worker lifecycle anyway.

## Open

- Which objects fillet, chamfer and fuse leave behind.
- The memory retained modules hold in Firefox and WebKit.
