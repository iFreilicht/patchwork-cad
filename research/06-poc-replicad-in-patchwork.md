# PoC 1: replicad in a Patchwork tool

> [!WARNING]
> **To be done.** This is an abstract; nothing has been built yet.

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

One command (`pnpm dev` in `nix develop`) builds the tool and starts the local Subduction and Patchwork site from the [test harness](05-sandboxing.md#test-harness), with storage that survives restarts and the tool already installed, and prints the URL.

## Questions to answer

- **Loading OCCT in the browser:** replicad has only run under Node so far ([03 prototype](03-topological-naming/prototype/)). How is the 10–20 MB wasm served and instantiated in a worker of a bundled Patchwork tool, from a local source only? Can pushwork carry it, or must it be a static file of the site? Cold and warm load times.
- **Getting the tool into Patchwork during development:** a static module of the local site (always installed) versus publishing with pushwork and registering it per account (already tested in the harness). Which one gives a fast edit–reload loop?
- **Reusing `replicad-evaluator`:** use it as a dependency, fork it, or take only ideas. Its bundling path resolves imports from remote URLs (`createUrlResolverPlugin` calls `fetch`), which [05's threat model](05-sandboxing.md#threat-model) forbids; imports must go through our loader ([02](02-model-storage.md#verdict-imports-in-code)).
- **Re-run cost:** how long a re-run of a small model takes, and whether re-running on every keystroke needs debouncing or cancellation.
- **Errors:** syntax errors, exceptions and kernel failures shown next to the code instead of breaking the view.

## Out of scope

- **Sandboxing:** model code runs unsandboxed. This contradicts "sandboxing is a day-one requirement" ([02](02-model-storage.md#consequences)), so PoC 1 only runs on the local stack with the user's own models and must not open shared documents or run against the public Patchwork instance. Its README says so.
- **Stable references:** [03](03-topological-naming.md#recommendation) is not used yet.
- **Timeline and feature library:** both belong to [PoC 2](07-poc-modelling-ui.md).
- **Selection:** no picking of faces or edges.

## Done when

`pnpm dev` starts everything; a new document of the datatype shows an editable replicad model and its shape; edits re-render; a second window sees them; nothing leaves the machine (checked with the harness); and the questions above have measured answers.
