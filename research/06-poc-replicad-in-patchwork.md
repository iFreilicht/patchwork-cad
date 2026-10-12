# PoC 1: replicad in a Patchwork tool

The first of two proofs of concept. It proves the technical path from a model document to a rendered shape inside Patchwork, with as little UI as possible. [PoC 2](07-poc-modelling-ui.md) builds the modelling UI on top of it.

## Scope

A Patchwork tool with a datatype whose document holds the model as code ([02](02-model-storage.md#decision-the-model-is-code)), a plain code editor on that text, and a 3D view of the result. Every edit re-runs the model in a Web Worker with replicad and OCCT and re-renders the mesh. Two browser windows on the same document see each other's edits. The model calls replicad directly; there is no feature library yet.

## Prior art

- **[replicad studio](https://github.com/sgenoud/replicad/tree/main/packages/studio)** (MIT) is the main reference: a browser editor for replicad code with a 3D view.
  - It bundles OCCT's wasm locally (`initOCSingle.js`: `import opencascadeWasm from "replicad-opencascadejs/wasm?url"`) and runs the kernel in a comlink worker (`builder.worker.js`).
  - Its evaluation logic is a separate package, [`replicad-evaluator`](https://github.com/sgenoud/replicad/tree/main/packages/replicad-evaluator), "Portable code evaluation and shape building for replicad". It handles plain and module code, TypeScript (via sucrase), default parameters, kernel error messages and STEP/STL export.
  - Its meshes keep face and edge identity (`replicad-threejs-helper`, `faceInfo`/`edgeInfo`, highlighting), which [PoC 2](07-poc-modelling-ui.md) needs for selection.
  - Its UI is React with react-three-fiber, Monaco and mobx, unlike Patchwork's Solid and CodeMirror ([`writing-patchwork-tools`](../.claude/skills/writing-patchwork-tools/SKILL.md)).
- **The [OpenSCAD tool](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/openscad/)** is only a reference for the Patchwork side: datatype, a code editor bound to a doc field, a worker inside a Patchwork tool. Its kernel handling is too rudimentary to copy: it fetches its wasm from a CDN and renders an STL without face or edge identity.

## Implementation

[src/cad/](../src/cad/) is the tool: a datatype and tool `cad-model` with the document `{ title, source }`, a Solid view with CodeMirror (bound to `source` by `@automerge/automerge-codemirror`) next to a three.js view, and one kernel worker per open view. The worker runs `replicad-evaluator`'s builder on replicad 1.1.0 and `replicad-opencascadejs` 1.1.0. `replicad-threejs-helper` turns its meshes into geometry, keeping the face and edge groups. Its [README](../src/cad/README.md) carries the unsandboxed warning.

A model is a plain ES module, `import { … } from "replicad"; export default function main(params) { return shape }`. The seed model also runs unchanged under Node with only replicad and OCCT.

One command (`pnpm dev` in `nix develop`) builds the tool and starts the local Subduction and Patchwork site from the [test harness](05-sandboxing.md#test-harness), with storage that survives restarts and the tool already installed, and prints the URL ([harness README](../src/harness/README.md)). A document created there reopens after a restart in a fresh browser profile, so it was loaded from Subduction's storage.

The e2e specs `cad-basic` (render, edit, every error kind) and `cad-sync` (two profiles edit one model) pass in Chromium, Firefox and WebKit. Each fails on any request that tries to leave the machine.

## Results

Measured with `cad-measure.spec.ts` and `cad-pushwork.spec.ts` (`CAD_MEASURE=1`, one worker) on an Apple Silicon Mac over loopback, against the harness's site server, which doesn't compress. Medians of 5 loads or 10 builds; Playwright 1.59.1.

### Loading OCCT

The wasm is a hashed asset of the tool (`import wasmUrl from "replicad-opencascadejs/wasm?url"`): 22.98 MB, 7.3 MB gzipped. The worker passes it to `WebAssembly.compileStreaming` and hands the compiled module to OCCT's Emscripten loader through `instantiateWasm`. It also stores the response in the Cache API, keyed by the hashed URL, so a stored copy never goes stale.

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| cold: fetch and compile | 116–164 ms | 806–958 ms | 238–306 ms |
| warm, from the Cache API: compile | 36–42 ms | 758–793 ms | 119 ms |
| instantiate and OCCT init | 60–65 ms | 140–155 ms | 81–97 ms |
| doc opened in a fresh profile until shape shown (includes Patchwork's boot) | 1.4–1.5 s | 2.9–3.0 s | 1.4–2.4 s |
| reload until shape shown | 1.0 s | 2.1 s | 0.95 s |

A cold load fetches the wasm exactly once; warm loads don't fetch it. Without the Cache API, Chromium's warm compile took 77–91 ms from the HTTP cache. Firefox's warm compile is barely faster than its cold one, so the cache saves Firefox the download but apparently not the compilation.

Each Playwright context kind lacks one cache, which hides warm loads unless both kinds are measured ([harness caveats](../src/harness/README.md#caveats)):
- Chromium's default contexts keep no 23 MB response in the HTTP cache.
- WebKit keeps it in no HTTP cache at all (5 server hits for 5 `fetch`es, versus 1 for the 1.5 MB tool bundle).
- In WebKit's persistent contexts the Cache API stores nothing.

The WebKit warm figure therefore comes from default contexts only. Real Safari has not been checked.

**pushwork can carry the wasm.** Published as a normal pushwork module, the tool loads OCCT through the service-worker URL. The first load spends 1.4 s (Chromium), 2.2 s (Firefox) or 2.3 s (WebKit) fetching and compiling, against 0.12–0.96 s from the site server; with the Cache API, later loads compile in 32, 655 or 159 ms.

### Getting the tool into Patchwork during development

The static module wins. The harness's site server mounts the tool's `package.json` and `dist/` live at `/packages/cad/` and appends it to `/modules.json`, so it is installed for every account without registration. `vite build --watch` rebuilds in under a second, and a reload (about 1 s) shows the new build, because only the hashed assets are cached. Publishing with pushwork took 5.6 s per change, plus registering the module once per account.

### Reusing `replicad-evaluator`

Use it as a dependency (1.1.0), but only its browser-safe entries:
- **What's safe:** `replicad-evaluator/builder` (`createBuilder({ runtime, codeEvaluator })`: `main`/`defaultParams`, meshing, kernel error messages, `faceInfo`/`edgeInfo`) and `replicad-evaluator/evaluate/browser`, which imports the code from a blob URL and never fetches.
- **What's excluded:** the main entry imports `node:fs`, `rollup` and the fetching `createUrlResolverPlugin`.
- **Our layer, [`prepare.ts`](../src/cad/src/kernel/prepare.ts):** it parses the source with acorn, rejects every static import other than `replicad` and `replicad/shape-functions` (the browser would fetch any other from the blob module), and rewrites the replicad imports to globals over the same number of lines. The evaluator's own rewrite joins multi-line imports into one line (`rewriteNamedImports`: `.join(", ")`), which would shift the line numbers in error messages.
- **The builder evaluates a module twice per build:** `buildShapesFromCode` runs `runCode(code, params)` and then `extractDefaultNameFromCode(code)`, which evaluates the module again. Top-level work in a model therefore runs twice.

### Re-run cost

| median build, edit to mesh | Chromium | Firefox | WebKit |
|---|---|---|---|
| seed model (rounded plate, bore, fillet) | 28 ms | 122 ms | 44 ms |
| M1 from [03](03-topological-naming.md) (cut, fillet, chamfer, fuse) | 35 ms | 169 ms | 51 ms |

Why OCCT runs about four times slower in Firefox has not been investigated.

Builds run one at a time, and while one runs only the newest source waits ([`engine.ts`](../src/cad/src/kernel/engine.ts)). Typing a 34-character comment into M1 at 40 ms per key ran all 34 builds in Chromium and WebKit and was done within 10 ms of the last key; Firefox ran 11 and settled 370 ms after it. At 10 ms per key, 17 (Chromium), 6 (Firefox) and 18 (WebKit) builds ran, and the view settled 120–220 ms after the last key. Models of this size need neither debouncing nor cancellation: the view is never more than about one build behind. Cancelling a running build means terminating the worker, and a new worker costs a warm OCCT load (100–200 ms, 0.9 s in Firefox), which matters for 05's watchdog rather than for typing.

### Errors

Every error is shown in the status bar with its kind and, where known, a highlighted line, and the last good shape stays in the view:

| kind | example | source of the message and line |
|---|---|---|
| syntax | `sketchOnPlane(.extrude(30)` | acorn: `Unexpected token (3:38)` |
| import | `import { x } from "https://…"` | `prepare.ts`, line of the import |
| runtime | `throw new Error("boom")` | the error, line from the stack frame of the blob module |
| kernel | `fillet(20)` on a 10 × 10 × 5 box | `replicad-evaluator` via `oc.getExceptionMessage`: `StdFail_NotDone: BRep_API: command not done`, no line |
| mesh | a shape that fails to mesh (not triggered by the specs) | `replicad-evaluator`'s per-shape `message` |

Kernel errors have no source line, because the exception comes from wasm. The line of the failing call could come from a stack captured in replicad's API layer; that is [04](04-kernel-robustness.md)'s topic.

## Out of scope

- **Sandboxing:** model code runs unsandboxed. This contradicts "sandboxing is a day-one requirement" ([02](02-model-storage.md#consequences)), so PoC 1 only runs on the local stack with the user's own models and must not open shared documents or run against the public Patchwork instance. Its README says so. The import check above only keeps honest models local; dynamic `import()` and `fetch` still work.
- **Stable references:** [03](03-topological-naming.md#recommendation) is not used yet.
- **Timeline and feature library:** both belong to [PoC 2](07-poc-modelling-ui.md).
- **Selection:** no picking of faces or edges. The meshes keep their face and edge groups for it.

## Open

- Load times over a real network, with compression.
- Warm loads in real Safari, whose caches may behave differently from Playwright's WebKit.
- The harness's egress check doesn't see loopback traffic ([VM plan](../src/harness/vm/PLAN.md)).
