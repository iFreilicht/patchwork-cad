# Feature Caching

Reusing features' results across builds, so that an edit reruns only what it changes: prior art in incremental computation, build systems and CAD, what a feature's result depends on in this library and in OCCT, the design, its correctness evidence and measured speedups. Experiment: [24-feature-caching/experiment/](24-feature-caching/experiment/), run with `pnpm --filter feature-caching-experiment experiment` in `nix develop` (Node, about 15 minutes); results in its `results-node.json`.

## The problem

Every edit runs the whole model again, every feature included, although [01](01-basic-idea-and-literature.md#problems-and-risks) (risk 4) expected that "every change re-runs the timeline from the changed feature onward" and called for per-feature caching. The PoCs' parts build in 20–150 ms ([07](07-poc-modelling-ui.md#rebuild-performance)), but research/23's plate takes 2.6–3.3 s with 244 features and 5.5–7.5 s with one `combine` of 192 holes ([23](23-build-progress.md#reporting-cost); Node, [Results](#results)), however small the edit. Its progress view also shows the whole model as waiting, where the user expects only "where the edit lands" to change ([23](23-build-progress.md#the-view)).

## Prior art

### Incremental computation and build systems

- **Correctness is "from-scratch consistency".** Nominal Adapton proves "it is from-scratch consistent, meaning it always produces the same answer as simply re-running the computation" ([Hammer et al. 2015](https://arxiv.org/abs/1503.07792)). Memoization assumes purity: "the first time we call a pure function f on immutable inputs ~x, we store the result r in a memo table mapping ~x to r. Then on subsequent calls f(~y), we can return r immediately if ~x and ~y match" (ibid.). React's `useMemo` says the same for UI code: "You should only rely on `useMemo` as a performance optimization", its function "should be pure", and dependencies are compared "using the `Object.is` comparison" ([React](https://react.dev/reference/react/useMemo)).
- **What can go wrong:** "the kind and cost of equality tests", "the identification of precise dependences between the input and the output of memoized code" and "space management" ([Acar, Blelloch, Harper 2003](https://www.cs.cmu.edu/~rwh/papers/memoization/popl.pdf)). Build systems list "Untracked dependencies", "Non-determinism" and "Volatility": "volatile tasks cannot be cached" ([Mokhov, Mitchell, Peyton Jones 2018](https://www.microsoft.com/en-us/research/uploads/prod/2018/03/build-systems.pdf), §6.3). Bazel: "When an input file is modified during a build, Bazel might upload invalid results to the remote cache", and "Bazel currently does not track tools outside a workspace" ([remote caching](https://bazel.build/remote/caching)). For code in a general-purpose language, "the challenge of implementing equality on arbitrary task functions" leaves "the pessimistic assumption that any change to the build system potentially changes any build task" (Mokhov et al., §6.5).
- **Minimality and early cutoff.** "A build system is minimal if it executes tasks at most once per build and only if they transitively depend on inputs that changed since the previous build" (Mokhov et al., Definition 2.1). With early cutoff, "When it executes a task and the result is unchanged from the previous build, it is unnecessary to execute the dependent tasks" (§2.3). rustc's red-green algorithm gets it by hashing results: it "can just compare the (already loaded) previous fingerprint to the fingerprint of the new result", but "Computing fingerprints is quite costly" ([rustc dev guide](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html)).
- **Traces.** A verifying trace records "the values/hashes of dependencies used last time, and if something has changed, the key is dirty and must be rebuilt"; a constructive trace "additionally stores the resulting value", and "it makes sense to record many constructive traces per key" (Mokhov et al., §4.2). Traces keyed by terminal inputs only ("deep") "require the tasks to be deterministic", or give a "Frankenbuild" whose parts don't match (§4.2.4, §6.4). Nix's input-addressed paths are such a key: "a function not of the output itself, but of the derivation that produced it" ([Nix](https://nix.dev/manual/nix/latest/store/derivation/outputs/input-address)).
- **Names decide reuse.** "Names identify computations to be reused across differing runs of a program", and "there is a risk that names could be used ambiguously, associating the same name with distinct pointers" (Hammer et al. 2015). Structural keys instead compare by content.
- **Demand.** Adapton criticises that "if a program input changes, all dependencies will be recomputed, even if an observer no longer requires certain outputs" ([Hammer et al. 2014](http://matthewhammer.org/adapton/adapton-pldi2014.pdf)); Salsa's durability lets it "skip traversing their dependencies" when only volatile inputs changed ([Salsa](https://salsa-rs.github.io/salsa/reference/durability.html)).

### CAD

- **Dirty flags from a dependency graph** in FreeCAD, SOLIDWORKS, Fusion and Onshape. FreeCAD marks objects touched; "If an object is marked as 'touched', then this does not necessarily mean that it will be recomputed. It only means that all objects that link it (i.e. its InList) will be recomputed" ([DocumentObject.h](https://github.com/FreeCAD/FreeCAD/blob/main/src/App/DocumentObject.h)). SOLIDWORKS' Rebuild "aims to rebuild new or changed features and their associated children features in a part" ([Hawk Ridge](https://hawkridgesys.com/blog/rebuild-vs-forced-rebuild)). Onshape: "modifying a Part Studio causes the changed feature, and everything after it, to be executed again" ([FeatureScript](https://cad.onshape.com/FsDoc/debugging-in-feature-studios.html)).
- **All of them have a forced full rebuild,** because incremental rebuilds miss changes: FreeCAD's ForceRecompute macro exists because "Sometimes when a user applies changes to the model, FreeCAD does not seem to recognize/integrate them" ([wiki](https://wiki.freecad.org/Macro_ForceRecompute)); SOLIDWORKS' Ctrl+Q's "main functionality is to rebuild everything from the beginning of the FeatureTree" (Hawk Ridge); Fusion advises "Use Compute All after you edit features that are upstream in the Timeline" ([help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-COMPUTE-ALL.htm)).
- **Determinism is the precondition.** "At Onshape we believe that models must regenerate the same way every time, everywhere"; "FeatureScript discourages hidden state and shared references" ([FeatureScript](https://cad.onshape.com/FsDoc/intro.html)).
- **Structural keys** in OpenSCAD: its geometry caches are keyed by `getIdString`, "the cached ID string representation of the subtree rooted by \a node", stripped of whitespace "to enable cache hits for equivalent nodes from different scopes" ([Tree.cc](https://github.com/openscad/openscad/blob/master/src/core/Tree.cc), [GeometryEvaluator.cc](https://github.com/openscad/openscad/blob/master/src/geometry/GeometryEvaluator.cc)).
- **Code-first kernels** cache per call. [cadcache](https://github.com/d-b-w-gain/cadcache) for build123d rebuilds a part when "its arguments, bound to the signature with defaults filled in" or its code change; "Any other argument raises `TypeError` instead of being guessed at", "Installed libraries aren't hashed", and "Each call gets a fresh object loaded from the BREP".
- **OCCT shares and changes shapes.** A shape's data "can be used by other shapes (an edge can be used by more than one face of a solid)" ([modeling data](https://occt3d.com/dev/doc/overview/html/occt_user_guides__modeling_data.html)). Booleans change their arguments unless asked not to: the option "prevents the input arguments from any modification" such as "tolerance increase, addition of the P-Curves on edges, etc.", and "might slightly decrease the performance" ([Boolean operations](https://occt3d.com/dev/doc/overview/html/specification__boolean_operations.html)). Putting a shape into another freezes it: "From now the Component cannot be edited" ([TopoDS_Builder.cxx](https://github.com/Open-Cascade-SAS/OCCT/blob/master/src/ModelingData/TKBRep/TopoDS/TopoDS_Builder.cxx)).

**What follows here:** a feature's result can be reused only if everything it depends on is in its key, and if nothing changes a result after it is made. The forced rebuilds of the CAD systems show what happens otherwise; this design instead has to be from-scratch consistent by construction, and tests compare every cached build with one from scratch.

## What a feature's result depends on

A model is plain JS that runs from the top in every build ([02](02-model-storage.md#design-goal-portable-models)); features are calls of `defineFeature`'s `call` ([`feature.ts`](../src/features/src/feature.ts)), which can return an earlier build's result instead of running. The hypotheses the design started from, checked against the code and the experiment's probes ([`probe.ts`](24-feature-caching/experiment/src/probe.ts), `pnpm --filter feature-caching-experiment probe`):

| Hypothesis | Finding |
|---|---|
| 1. The worker keeps every feature's result of the last build (`lastTrace`), so a cache costs little memory. | True for successful builds; a failed build keeps none. The cache holds the same bodies, and with it OCCT's heap grows less, not more ([results](#memory)). |
| 2. A sound key: the feature's type and arguments, input bodies by identity if they were reused, the same names and call counts. | Not enough: also what the call printed ([The key](#the-key)), and bodies must not change after they are made, which OCCT doesn't guarantee ([Bodies don't change](#bodies-dont-change)). |
| 3. `body(() => …)` can't be keyed; plain replicad code isn't covered. | True; and replicad code that reads a body's shape may change it, and with it the bodies it was made from ([Bodies don't change](#bodies-dont-change)). |
| 4. Aborting and heap restarts lose the cache; a cooperative stop needs `SharedArrayBuffer`. | True ([Aborting](#aborting-and-restarts)); the conflict with research/23's auto-abort is settled there. |
| 5. No help for the first build after a load, early edits and configuration switches. | First build and early edits: true. Switching between two configurations reuses everything, as results are kept for two builds; persisting B-reps costs 0.5 s per build of the plate ([Persisting](#persisting-across-reloads)). |
| 6. The cache's misses mark where an edit lands better than `deps.ts`. | True, with limits ([Where an edit lands](#where-an-edit-lands)). |

### Bodies don't change

Without a cache, builds are deterministic: M1, M3 with three ribs, M4 and both plates gave identical traces, names, B-reps and meshes four times in one OCCT instance, also with other shapes made in between. But a reused body lives on into the next build, so anything that changes it after it was made reaches that build, and no key sees it. The probes found four such changes:

- **Booleans change their arguments.** With OCCT's default, later features of the same build changed 5 of M4's 8 bodies, and the first body of M1, M3 and both plates, by adding p-curves to their edges and raising tolerances, as OCCT's documentation says. The library's booleans are now non-destructive (`boolean` in [`oc.ts`](../src/features/src/oc.ts), also in `joinRegions` and `changedVolume`), after which no feature changed an earlier body in these models. Over research/17's sweep without its rib lists, and both plates (122 builds), this changed no face (by its names, centroid and area), edge, status or reference; it changed the order of faces and edges in 109 builds, and `faceOps` ([23](23-build-progress.md#the-view)) in 72, as a face that a boolean only copies, e.g. M3's base bottom face, now counts as changed by it.
- **Meshing writes into the shapes it meshes.** A face keeps its triangulation, and meshing changed every body of M1, M3 and M4, which a later feature in another build would see. The view now meshes a copy of each body, which gave the same mesh in every probe's body and left the body as it was (`meshable` in [`runtime.ts`](../src/features/src/runtime.ts)).
- **A prism changes the face it sweeps.** Three prisms of the same face of a sketch's circle gave three different B-reps, with 2, 4 and 6 locations; of copies of the face, 2 each time. The face belongs to the sketch, which outlives the extrusion when it is reused. An extrusion now sweeps a copy of the face, as "through" already did.
- **Freezing.** OCCT clears the "Free" flag of a shape it puts into another ([TopoDS_Builder.cxx](https://github.com/Open-Cascade-SAS/OCCT/blob/master/src/ModelingData/TKBRep/TopoDS/TopoDS_Builder.cxx)), so a reused body tells which features of earlier builds used it. Only adding to a frozen shape depends on the flag (it throws), which no feature does to its inputs; the tests compare everything else.

Model code can still change bodies: replicad's booleans are destructive (`new oc.BRepAlgoAPI_Cut(…)` in replicad 1.1.0, without `SetNonDestructive`), and JS can change objects. So:

- **A body whose `shape` is read** is not reused, nor anything it was made from, whose shapes it shares (`expose` in [`feature.ts`](../src/features/src/feature.ts)); the tool reads shapes through `shapeOf`, which doesn't count. Models that only use features are unaffected.
- **Bodies and sketches are frozen,** and a sketch keeps a frozen copy of its profile and frame, so a model can't change a reused one, or a profile it passed, in a way that a later build would see. Outside the tool, without a cache, the same code fails the same way, so a model behaves the same with and without the cache.

### The key

A call is reused if an earlier build made a call ([`cache.ts`](../src/features/src/cache.ts)):

- **at the same place:** its name and how many calls of that name came before it in the build, as names repeat (`const rib = …` in a loop); Nominal Adapton's "namespaces" solve the same ambiguity. A feature without a name is named by its line (`extrude@L12#3`), so a line inserted above reruns it.
- **of the same definition:** the library's features only (`markReusable`). A feature defined in the model is a new function in every build; one from an imported document may read any state. `body()` of a function always runs; of a body, it is reused.
- **with the same arguments,** written as a string when the call runs, so that a model changing an argument afterwards doesn't change what was recorded (Bazel's poisoned cache): numbers by `Object.is`, arrays and plain objects by their elements and keys in order, references by what they name, bodies and sketches by identity. Anything else, e.g. a function or a replicad shape, can't be compared, and the call always runs.
- **that printed the same names.** A reference's code and messages print a feature as its variable where an earlier feature has one, else as `ref.x`: a verifying trace of each name the call printed and how.

Its result is the earlier object, so its users' inputs are the same objects again: identity carries the reuse down the timeline, as an input-addressed key does. A call that failed is reused failing only if it failed with the library's `FeatureError`, which comes again with the same arguments; other errors, e.g. running out of memory, may not. A call that throws out of the build is never kept.

**Early cutoff for sketches:** a sketch that runs again, e.g. on a face of a body that changed, and is the same as before (name, frame, profile) is the earlier object, so its users can be reused. Bodies have no cutoff: comparing B-reps would cost what hashing does in rustc.

**Two generations:** a result is kept for two builds after the last build that used it, as several constructive traces per key: switching between two configurations, an undo, or a build that stopped early reuses everything.

## Design

### Options

| | Sound for dynamic code | Reuse | Cost |
|---|---|---|---|
| Dirty flags from `deps.ts`, as FreeCAD and SOLIDWORKS | No: loops, parameters, imports, Custom Scripts and closures depend on values the static graph doesn't see | Reruns the statically affected entries, also where nothing changed | Static analysis |
| **Memoizing each call by place, verified by its arguments (chosen)** | Yes, given the key above and bodies that don't change | Exactly the changed calls and their users, plus cutoff for sketches | A string per call, frozen objects, mesh copies |
| Structural keys, as OpenSCAD | Yes | Also equal calls in other places | Hashing every input body's B-rep |
| Keys from code and arguments, persisted, as cadcache | Only if code and versions are hashed | Across reloads | Writing every body ([Persisting](#persisting-across-reloads)) |
| Memoizing the whole model when nothing changed | Yes | Only edits that change nothing, e.g. a comment | Cheap, but per-call reuse leaves such a build only the evaluation ([Results](#results)) |

### The chosen design

- **The library** has `FeatureCache` and `beginBuild({ cache })`; `call` looks a call up before running it and keeps what it gave. The trace says per feature whether it was `cached`, its `cost` (what it took when it last ran) and what it `uses` (the bodies and sketches among its arguments). Model files are unchanged and run without the cache as before ([02](02-model-storage.md#design-goal-portable-models)).
- **The worker** keeps one cache for its life and passes it to every build; trial builds (`check`) reuse its results without keeping theirs ([`worker.ts`](../src/cad/src/kernel/worker.ts)). It meshes copies of bodies, and keeps each body's meshes, so a reused shown body isn't meshed again.

## Interplay

### Naming, rollback and picking

A reused body is the same object with the same names, so references, picks, rollbacks and differences of the last build work on it as before; the tests compare names, references and meshes of every body of every build. Moving code doesn't rerun features named by their variables; the plate's `combine`, named by its line, reran after a comment above `main`.

### Progress and estimates

Cached features report `featureStarted` and `featureDone` as before and finish at once. The estimate counts each feature with its `cost`, so a feature cached in one build counts with what it takes when it runs; the features not yet reached that will be reused make the estimate pessimistic, so the bar ends early, which Harrison et al. found better than stalling ([23](23-build-progress.md#estimates)).

### Where an edit lands

The features a build ran (`cached: false`) are exactly those an edit changed and those that use them, minus what cutoff saved; unlike `deps.ts`, they include changes through parameters, loops, imported documents and Custom Scripts, and they exclude configurations switched back to. A cached feature finishes within milliseconds, so the first feature that runs is known almost at once, and the previous build's `uses` predict which later features run too; a feature with changed arguments of its own is found when the build reaches it. The view can mark these and keep the rest as it is; that design is left to the editor.

### Aborting and restarts

The cache lives in the worker, so Abort and a restart past the heap limit lose it: the next build runs everything, like the first after a load. Without `SharedArrayBuffer` a running build can't be told to stop ([23](23-build-progress.md#what-the-worker-can-report)). For research/23's step 5, a superseded build should therefore finish: it fills the cache, and the waiting build then reuses what the edit didn't change, while an abort makes it run everything. Aborting a superseded build only pays if its remaining time exceeds a full build of the waiting source, which the features' `cost` estimates.

### Imports and configurations

An imported document's module is evaluated once per content ([02](02-model-storage.md#imports-in-the-prototype)), so bodies it makes are the same objects in every build and are reused by identity; a changed document is a new module, and everything that uses it runs. Data from documents is compared by value. Configurations are parameter values; switching to one shown in the last two builds reuses everything.

### Memory

The cache keeps the same bodies the worker keeps for picking, plus those of the build before; the worker keeps each shown body's copy and meshes. OCCT's heap only grows, and the worker restarts once it passes 1 GiB ([08](08-module-evaluation.md#conclusions)); it grew less with the cache, as reused features make no new shapes: after the plate's eight steps, 413 instead of 947 MB with cuts and 1,079 instead of 1,871 MB with one combine ([Results](#results)). Without the cache, the worker restarts before the combine plate's 5th step, losing nothing then, but with it only after the 8th; the cuts plate stays below 1 GiB either way.

## Results

Each step of the edit sequences ([`sequences.ts`](../src/cad/test/sequences.ts)) built as the worker builds, with and without the cache, each run of a sequence in a Node 24 process of its own, three runs, medians in ms. "Build" is evaluating the model and running `main`, "mesh" meshing the shown bodies as the worker does. Apple Silicon Mac, load average 4–6 on 8 cores and 19 GB of swap in use during the plates. Every step of every sequence was identical with and without the cache ([Correctness](#correctness)).

| step | ran | build | mesh |
|---|---|---|---|
| **M1** (8 features), first build | 8 | 184 → 187 | 8 → 8 |
| late: chamfer distance | 3 | 50 → 30 | 5 → 5 |
| late: boss radius | 2 | 41 → 15 | 4 → 4 |
| middle: fillet radius | 4 | 40 → 26 | 4 → 4 |
| a comment above `main` | 0 | 38 → 0.5 | 3.6 → 0.1 |
| early: `h` | 6 | 37 → 31 | 4 → 4 |
| configuration `w` 70, defaults, `w` 70 | 7, 6, 0 | 40 → 32, 35 → 30, 36 → 0.4 | 4 → 4, 4 → 4, 3.6 → 0.1 |
| **M3** (10–12 features), late: hole radius | 2 | 49 → 17 | 4 → 4 |
| late: chamfer distance | 3 | 44 → 22 | 3 → 4 |
| middle: rib thickness | 6 | 43 → 36 | 3 → 4 |
| configuration ribs [15, 45], defaults, ribs [15, 45] | 8, 6, 0 | 59 → 54, 40 → 34, 56 → 0.5 | 4 → 4, 3 → 3, 4 → 0.1 |
| early: `t` | 9 | 41 → 41 | 3 → 3 |
| **M4** (10 features), late: the lid's offset | 1 | 33 → 1.0 | 6 → 1.2 |
| a branch: the rounded variant's radius | 1 | 39 → 4.4 | 6 → 0.1 |
| middle: the boss's fillet | 3 | 31 → 15 | 7 → 6 |
| early: `h` | 9 | 29 → 29 | 7 → 10 |
| configuration `w` 80, defaults, `w` 80 | 10, 9, 0 | 29 → 30, 27 → 29, 26 → 0.4 | 6 → 7, 6 → 6, 6 → 0.1 |
| **Plate, cuts** (12 × 10, 244 features), first build | 244 | 3,582 → 3,595 | 193 → 191 |
| late: chamfer distance | 1 | 3,382 → 43 | 195 → 187 |
| late: fillet radius | 2 | 3,338 → 267 | 189 → 181 |
| a comment above `main` | 0 | 3,322 → 3.0 | 190 → 4.6 |
| early: hole radius | 242 | 3,338 → 3,308 | 205 → 205 |
| configuration `r` 3, `r` 3.5 | 0, 0 | 3,350 → 3.5, 3,305 → 3.1 | 192 → 4.1, 198 → 5.4 |
| early: thickness | 123 | 3,269 → 2,498 | 206 → 204 |
| **Plate, one combine** (16 × 12, 389 features), first build | 389 | 7,775 → 8,020 | 333 → 352 |
| late: chamfer distance | 1 | 7,597 → 67 | 317 → 331 |
| late: fillet radius | 2 | 7,529 → 622 | 339 → 321 |
| a comment above `main` | 3 | 7,999 → 6,246 | 351 → 326 |
| early: hole radius | 387 | 7,513 → 7,504 | 361 → 363 |
| configuration `r` 3, `r` 3.5 | 0, 0 | 7,372 → 5.4, 7,438 → 4.4 | 332 → 8.7, 373 → 7.2 |
| early: thickness | 196 | 7,898 → 6,109 | 387 → 353 |

- **A late edit of a slow model is 12–110 times faster** (plate with cuts: chamfer 3.4 s → 43 ms, fillet 3.3 s → 0.27 s), plus meshing the changed body; of the PoCs' parts, 1.6–33 times. An edit that changes nothing, or a configuration shown in the last two builds, takes the model's evaluation, 0.4–5 ms, and the kept meshes, 0.1–9 ms.
- **An early edit is as slow as before;** what doesn't depend on it is saved, e.g. the plates' hole sketches when their thickness changes (23 %).
- **Moving code reruns features named by their line:** the plate's `combine` and the two features after it reran after a comment above `main`.
- **Overhead:** a first build, which reuses nothing, took 0–3 % longer, M3's 7 %; three runs on this host don't tell that from noise. Copying a body before meshing it cost 0.4–0.6 ms for the parts and 7–10 ms for the plates, 3–17 % of meshing; a reused body's kept meshes took 4.5–7 ms instead of 190–330 ms.

### Persisting across reloads

The first build after a load reuses nothing. Writing all 123 bodies of the plate's build (cuts) as B-rep text took 327 ms and 6.3 MB; reading them back 208 ms, against 3.6 s for the build; the last body alone is 206 KB, read in 6 ms. Keeping a cache in IndexedDB would cost that per slow build, plus the names, and keys that hold across library versions; whether bodies read back give builds that are identical to builds from scratch is untested ([Open](#open)).

## Correctness

A build with the cache must give what the same build without it gives. The fingerprint ([`fingerprint.ts`](../src/features/test/fingerprint.ts)) compares, per trace entry, status, message, references with their codes and matches, warnings, the bodies before, consumed, made and after it, and its sketches by value; per body, its B-rep as OCCT writes it (with flags but "Free", [Bodies don't change](#bodies-dont-change)), its face and edge names, adjacency, `faceOps`, owners and shapers; per shown body, its mesh as the worker makes it, with groups by face and edge index.

- **research/17's sweep** ([`cache.test.ts`](../src/features/test/cache.test.ts)): its 125 builds in turn with one cache, and back to each model's defaults (128 builds), each compared with a build without the cache: identical, with 210 of 1,190 calls reused.
- **The edit sequences** ([`cache.test.ts`](../src/cad/test/cache.test.ts), [`sequences.ts`](../src/cad/test/sequences.ts)): M1, M3, M4 and the plate (6 × 4) built as the worker builds, through `prepare` and with the editor's names; every step identical, and the features each step reran are listed for M1 and M4.
- **The experiment** checks each step of its sequences the same way, at full size ([Results](#results)).
- **What a reuse depends on** (`cache.test.ts` in the library): places in loops, printed names, arguments changed after the call, frozen bodies and sketches, read shapes, failures of both kinds, cutoff, read-only builds, generations, features defined elsewhere and `body()`, and that a reused body is unchanged after later builds and the view's meshing.
- **In the tool** ([`cad-cache.spec.ts`](../src/harness/e2e/tests/cad-cache.spec.ts)): in each browser, M1's chamfer edit reruns three features, and the faces and edges shown, their centroids, a picked reference and a rollback are what the first build after a reload shows.

The failures found on the way, and their causes: the comparison first differed for M1's boss after an earlier sketch was reused through cutoff (prisms changed the sketch's face, now copied), and for a reused body's "Free" flag (OCCT's freezing, now excluded); the first reproduces in isolation (probe 5), the second showed as `0100000` against `1100000` in the flags of M1's first body, which a feature of an earlier build had put into another shape.

## Implementation

- **Library:** `FeatureCache` and `argsKey` ([`cache.ts`](../src/features/src/cache.ts)); in `call`, the place, the lookup, the record of printed names, early cutoff for sketches; frozen bodies and sketches, `shapeOf` and the lineage of read shapes; `cached`, `cost` and `uses` in the trace ([`feature.ts`](../src/features/src/feature.ts)). Non-destructive booleans ([`oc.ts`](../src/features/src/oc.ts), [`profile.ts`](../src/features/src/profile.ts)), prisms of a copy ([`features.ts`](../src/features/src/features.ts)), `meshable` with its kept meshes, and `withFeaturePrinter`, so that a pick answered while a build waits doesn't change the build's printer ([`runtime.ts`](../src/features/src/runtime.ts), [`names.ts`](../src/features/src/names.ts)).
- **Worker:** one cache for builds and, read-only, for trial builds; bodies meshed through `meshable`, for the evaluator too ([`worker.ts`](../src/cad/src/kernel/worker.ts)); `cached`, `cost` and `uses` in `FeatureTrace` ([`protocol.ts`](../src/cad/src/kernel/protocol.ts)).
- **Editor:** estimates from `cost` ([`progress.ts`](../src/cad/src/components/progress.ts)); `data-features` lists the features a build ran, for the specs ([`createModel.ts`](../src/cad/src/components/createModel.ts)). The view doesn't mark where an edit lands yet.

## Open

- **Marking where an edit lands** in the view and the timeline, with the features that ran and those the previous build's `uses` predict ([Where an edit lands](#where-an-edit-lands)).
- **Aborting** loses the cache; a cooperative stop needs a cross-origin-isolated Patchwork, and auto-aborting superseded builds (research/23's step 5) should weigh the lost cache ([Aborting and restarts](#aborting-and-restarts)).
- **Features without names** are named by their line, so moving code reruns them, as the plate's `combine` after a comment above `main`; a name from the statement they are in would survive that ([07](07-poc-modelling-ui.md#open)).
- **Inside one feature:** a `combine` of 192 tools runs every boolean again when one tool changes.
- **Persisting across reloads** ([Persisting](#persisting-across-reloads)): costs measured; whether B-reps read back give from-scratch consistent builds is untested, as reused objects already showed identity-dependent results (prisms).
- **Shapes of imported documents** are the same objects in every build, and replicad code may change them, with or without the cache; reading a body's `shape` stops reuse only for bodies of the library.
- **Opting other features in:** features defined in models or documents are never reused; a declaration that one is pure would be the author's promise.
