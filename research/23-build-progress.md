# Build Progress

What the editor can show while a slow model builds, and what it costs: research on waiting, prior art in CAD, an experiment on reporting progress from the kernel worker, and a design. Experiment: [23-build-progress/experiment/](23-build-progress/experiment/), run with `pnpm --filter build-progress-experiment experiment` in `nix develop` (about 12 minutes for all three browsers); results in its `results-*.json`.

## The problem

Today the worker reports nothing until a build is done ([`worker.ts`](../src/cad/src/kernel/worker.ts)). Meanwhile the status bar appends "building…", the view keeps the last shapes, and the timeline the last trace. A loaded worker that hasn't answered for 10 s is replaced and its build fails ([08](08-module-evaluation.md#conclusions)), so a model that takes longer can't be built at all; the experiment's plate with 20 × 14 holes takes 12 s in Chromium. The models of the PoCs build in 20–150 ms ([07](07-poc-modelling-ui.md#rebuild-performance)), where none of this matters.

## Prior art

### Research on waiting

- **Limits.** "1.0 second is about the limit for the user's flow of thought to stay uninterrupted", "10 seconds is about the limit for keeping the user's attention focused on the dialogue" ([Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/)). NN/g recommends a looped animation only "for actions that take between 2-10 seconds" and "percent-done progress indicators … for longer processes that take 10 or more seconds"; users who saw an animated progress bar "were willing to wait on average 3 times longer" ([progress indicators](https://www.nngroup.com/articles/progress-indicators/)).
- **Why progress helps.** In [Myers 1985](https://www.cs.cmu.edu/~bam/papers/percentdoneCHI85.pdf), "people prefer to have progress indicators". Among his reasons: "When people do not know how long the wait will be, it is impossible for them to schedule a different task of the appropriate duration, or even to relax effectively", and an alternative is "an actual number or an analog display of the actual time left until the task is completed, if this can be estimated". He notes that progress bars are drawn rather than given as numbers because "exact times can only rarely be determined".
- **Waits feel longer when uncertain, unexplained and unoccupied** ([Maister 1985](http://davidmaister.com/blog/201/)).
- **How a bar moves matters.** "participants perceived progress bars with pauses as taking longer to complete (peak effect). Secondly, accelerating progress was strongly favored. The latter two effects had an exaggerated perceptual impact when located towards the end of the process" ([Harrison et al. 2007](https://chrisharrison.net/projects/progressbars/ProgBarHarrison.pdf)). The bar's texture matters too: "Progress bars with animated ribbing that move backwards in a decelerating manner proved to have the strongest effect", reducing "the perceived duration among our participants by 11%" ([Harrison et al. 2010](https://www.chrisharrison.net/projects/progressbars2/ProgressBarsHarrison.pdf)).
- **Partial results beat waiting.** In exploratory data analysis, progressive visualizations, which show approximate results that improve, did as well as instantaneous ones, and blocking ones with 6 or 12 s of latency did worse ([Zgraggen et al. 2017](https://doi.org/10.1109/TVCG.2016.2607714)).

### In CAD systems

- **Fusion** shows a progress bar during "Compute All". When a 2023 update lost it, a user reported that "no progress bar is shown, so the program just appears to be frozen until the compute completes" ([Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/compute-all-progress-bar-not-displaying/td-p/11899912)).
- **Onshape** regenerates on its servers. "Show regeneration times" "opens the Regeneration times for each feature in a separate panel"; it warns when an "Individual Feature Regeneration Time is greater than 10 seconds" ([Performance panel](https://cad.onshape.com/help/Content/Home/performance_panel.htm)). Its advice: "Move longer regenerating features to the end of the Features list" and "Pause regeneration when working with configuration tables and Part Studios that take a long time to generate" ([Performance considerations](https://cad.onshape.com/help/Content/Home/performance_considerations.htm)).
- **SOLIDWORKS**: "Feature Statistics is a tool that displays the amount of time it takes to rebuild each feature in a part. Use this tool to reduce rebuild time by suppressing features that take a long time to rebuild" ([help](https://help.solidworks.com/2015/English/SolidWorks/sldworks/HIDD_FEATURE_REPORT.htm)).
- **FreeCAD** marks objects in its tree that are out of date: a white check mark on blue "indicates that the object has to be recomputed, due to changes made to the model"; objects depending on one with an error "may still show some old state" ([Tree view](https://wiki.freecad.org/Tree_view)).
- **OpenSCAD** counts progress by nodes of the CSG tree, which misleads: the "progress bar jumps relatively quickly (or at least - perceptibly) to 999/1000, then is stuck there", because "The progress bar looks at progress through walking the geometry tree" and "the bulk of the work is at the final top-level union" ([openscad#6041](https://github.com/openscad/openscad/issues/6041)).

So the CAD systems report progress by feature, show time per feature as a diagnosis after the fact, and let the user stop or pause rebuilds. None paints progress into the model.

## What the worker can report

- **Per feature, not inside one.** The feature library runs every feature through one function, `defineFeature`'s `call` ([`feature.ts`](../src/features/src/feature.ts)), which already times it for the trace; a hook there sees every feature finish. OCCT's own progress API isn't usable: replicad-opencascadejs 1.1.0 binds only an empty `Message_ProgressRange` ("Constructor of the empty range"), no `Message_ProgressIndicator` that JS could implement, so neither progress nor a user break inside a boolean or fillet is available without a custom OCCT build.
- **Aborting means terminating the worker.** A synchronous build can't receive a message. A flag in a `SharedArrayBuffer` would let the hook stop between features, but that needs a cross-origin-isolated page. Neither patchwork.inkandswitch.com nor sub.patchwork.inkandswitch.com sends COOP/COEP headers, and in Chromium both report `crossOriginIsolated` false and have no `SharedArrayBuffer`, also under their service worker.
- **Models stay as they are.** The hook is in the library and the worker; a model file is unchanged and runs without them ([02](02-model-storage.md#design-goal-portable-models)).

## Experiment

A page without Patchwork runs a worker like the tool's: the feature library with replicad-opencascadejs 1.1.0, models run as functions without the evaluator ([08](08-module-evaluation.md#evaluation-without-import) evaluates them that way too), restarted past a 1 GiB heap as the tool does. The hook is the trace's `push`, which the library calls when a feature starts, reporting the previous feature as done. Models: M1 and M3 with three ribs ([03](03-topological-naming.md)), and a [plate](23-build-progress/experiment/src/plate.js) made slow on purpose: a grid of holes, then one fillet of all their top edges and a chamfer, with the holes cut one feature at a time (12 × 10, 244 features) or extruded as bodies and cut by one `combine` (16 × 12, 389 features), which then takes most of the build. Modes of reporting after each feature:

- **none:** as the tool today.
- **events:** a message with the feature's name, status and time.
- **mesh:** also the bodies the feature made, meshed as the tool meshes, in transferred typed arrays.
- **throttled:** also every visible body, meshed, at most every 250 ms.
- **budget:** as throttled, but also only when meshing has taken at most 10 % of the time since the last meshing began.

Chromium 156, Firefox 157 and WebKit 27.2 (Playwright 1.64.1) on an Apple Silicon Mac with a load average of 5–6 on 8 cores. Under that load, whole builds varied by 10–25 % between repetitions, more than the cost of reporting; the costs below are therefore what the worker measured inside the hook, which doesn't depend on that noise.

### Reporting cost

Medians, in ms; in brackets, relative to the build without reporting. M1 and M3 build in less than 250 ms, so throttled and budget never mesh them. Firefox and WebKit time in whole milliseconds.

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| **M1** (8 features): build | 27 | 32 | 30 |
| events | 0.1 | 0 | 0 |
| meshing every feature | 6.8 (25 %) | 9 (28 %) | 8 (27 %) |
| **M3, 3 ribs** (14 features): build | 31 | 55 | 33 |
| events | 0.1 | 0 | 1 |
| meshing every feature | 9.1 (30 %) | 15 (27 %) | 9 (27 %) |
| **Plate, cuts** (244 features): build | 2,554 | 3,281 | 2,566 |
| events | 4.3 | 4 | 7 |
| meshing every feature | 4,842 (190 %) | 6,006 (183 %) | 4,519 (176 %) |
| meshing, throttled | 506 (20 %) | 826 (25 %) | 426 (17 %) |
| meshing, budget | 263 (10 %) | 338 (10 %) | 235 (9 %) |
| **Plate, one combine** (389 features): build | 5,552 | 6,922 | 5,545 |
| events | 3.5 | 2 | 6 |
| meshing every feature | 740 (13 %) | 809 (12 %) | 667 (12 %) |
| meshing, throttled | 587 (11 %) | 671 (10 %) | 510 (9 %) |
| meshing, budget | 268 (5 %) | 320 (5 %) | 269 (5 %) |

- **A message per feature costs nothing measurable:** 2–7 ms in a build of 244–389 features. With it, the page heard of the first feature 1–5 ms after posting the build (up to 32 ms in WebKit for the plate with one combine), instead of after the whole build.
- **Meshing every feature costs more than the build** when each feature changes a large body: every cut re-meshes the whole plate, 608,000 triangles over 123 meshes. Throttling to 250 ms still cost up to 25 %; the budget kept to its 10 % and sent 6–7 meshes over a 2.6–3.3 s build, the first after about 265 ms.
- **One long feature is a long silence:** with events, the longest time without news was 190–234 ms for the plate with cuts, and 4.1–5.0 s for the plate with one combine, which is that combine.
- **The page keeps drawing.** It drew 55–74 frames per second during every build in every browser, so the view and the timeline can animate while the worker builds.

### Latency

Progress messages of the plate with cuts, three builds each (732 messages), from the worker's `postMessage` to the page's handler, by `performance.timeOrigin + performance.now()` on both sides:

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| page idle: median / max | 0 / 0.6 ms | 0 / 1 ms | 1 / 67 ms |
| page blocked for 1 s: median / p95 / max | 90 / 944 / 1,002 ms | 1 / 920 / 998 ms | 132 / 946 / 1,001 ms |
| build, idle vs. blocked page | 3,255 vs. 2,562 ms | 3,245 vs. 3,210 ms | 2,621 vs. 2,486 ms |

Messages wait for a busy page, as any task does, but the build doesn't: unlike a worker's `import()` in Firefox and WebKit ([08](08-module-evaluation.md#imports-wait-for-the-page-in-firefox-and-webkit)), `postMessage` from a running build never waited for the page.

### Prediction

A sequence of edits to the plate (cuts, 12 × 10), each build estimated from the one before ([Estimates](#estimates)), against the fraction of its time actually elapsed at each feature. Error in percentage points, mean / max, Chromium; Firefox and WebKit were within 1 point of it in every row.

| edit | features | by time | by count |
|---|---|---|---|
| none | 244 | 0.1 / 0.5 | 15 / 21 |
| none | 244 | 0.1 / 0.3 | 15 / 21 |
| hole radius 3 → 3.5 | 244 | 1.1 / 2.2 | 13 / 18 |
| fillet 0.8 → 1.2 | 244 | 0.6 / 1.5 | 16 / 21 |
| 12 → 14 columns | 284 | 7.9 / 19 | 23 / 33 |
| 14 → 10 columns | 204 | 15 / 38 | 6 / 22 |
| cuts → one combine | 205 | 7.0 / 40 | 36 / 73 |
| none | 205 | 0.1 / 0.3 | 36 / 73 |

- **While a model's features stay the same, time predicts to within about 2 points;** most edits are of that kind. Counting features is 15–36 points off on average, always ahead: at a quarter of the plate's time, 44 % of its features are done, because each cut works on a body with more holes, and with one combine, 86–95 % are.
- **When an edit adds features, the estimate runs ahead and then stalls:** with 14 columns, at 25, 50 and 75 % of the time it said 32, 64 and 88 %, the late pause Harrison et al. found worst. When an edit removes features, it lags and then jumps: with 10 columns it said 15, 29 and 44 %, then the build was done. The new combine, which the previous build didn't have, took 60 % of the build, during which the estimate stood at 46–55 %.
- One build later, the estimate is accurate again.

### Restart

A new worker until OCCT is ready, warm, median of 5: 111 ms in Chromium, 364 ms in Firefox, 152 ms in WebKit. That is what aborting a build costs.

## Design

### Reporting

- **A hook in the library, a message per feature.** `beginBuild` takes a callback that `call` invokes when a feature is done, with its trace entry; the worker posts its name, status, message and time, and the engine passes it on. The message is the entry `serialize` already makes, minus what only the final trace needs.
- **The watchdog becomes per feature for free.** It restarts on every message from the worker ([`engine.ts`](../src/cad/src/kernel/engine.ts), `#watch`), so with a message per feature only a single feature, or model code between two features, that runs 10 s without finishing is cut off; a model of any length builds. Whether one long feature is stuck or slow can't be told ([08](08-module-evaluation.md#conclusions)); with an abort button the user can decide, so the automatic limit for a single feature can grow, e.g. to a minute, and stays for viewers that nobody watches.

### Estimates

- **Time, from the previous build, by feature name.** The estimate is the elapsed time over the elapsed time plus the previous build's times of the features that haven't run yet and its final meshing. It is what Myers calls "an actual number … of the actual time left": edits rarely change which features a model has, so the last build is a good predictor ([results](#prediction)).
- **Within a long feature, by its expected duration.** Between messages the bar moves on by the running feature's previous time, slowing towards a cap if it overruns instead of stopping; otherwise a 4 s `combine` is a 4 s pause.
- **Biased towards an accelerating end.** An estimate that is too long makes the bar jump to the end when the build finishes early, the movement Harrison et al. found favoured; one that is too short makes it stall near the end, the one they found worst. So the remaining time is rounded up, the bar stays below 100 % until the result arrives, and never moves back.
- **Not by count.** Features done over features is what OpenSCAD's stuck 999/1000 comes from; later features work on larger bodies and take longer, and one feature can take most of a build ([results](#prediction)).
- **Kept across sessions.** Each build's feature times are stored with the per-user state ([10](10-view-state.md)) by model, so the first build after opening a slow model has an estimate too; without one, the bar is indeterminate.

### Status bar

- **At once, a word in a fixed place.** The status bar's slot for the build always exists and changes its text from the last build time to "Building…" when a build starts, so the view is never taken for the new result while it is stale; text that changes in place doesn't flicker as a bar that appears does.
- **The bar only after a delay,** since "1.0 second is about the limit for the user's flow of thought to stay uninterrupted" ([Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/)), almost every build of a part is far below it, and a bar that flashes on every edit is noise. After the delay (0.5–1 s, to be tuned), and once shown for at least half a second: the running feature's name, the elapsed time, a bar with backward-moving ribbing (Harrison et al. 2010) and an Abort button: "Anything slower than 10 seconds needs a percent-done indicator as well as a clearly signposted way for the user to interrupt the operation" ([Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/)). From 10 s on, also the estimated remaining time in words ("about 20 s left").
- **The status bar's build time stays**, and after a slow build also says what took longest, the diagnosis the CAD systems give in a separate panel.

### Timeline and code

- **Each entry has a build state:** done in this build, waiting, or running. Waiting entries keep their last status but are dimmed, as FreeCAD's "has to be recomputed" mark; the running one has the bar's ribbing; a done one shows its new status at once. So a reference that broke in the third feature shows while the three-hundredth still builds, and the user can fix it, or abort, without waiting.
- **The running entry is a build cursor** that moves along the timeline, as the marker does ([07](07-poc-modelling-ui.md#the-timeline-marker)), in its lane ([15](15-bodies.md)). The code pane marks the running feature's line the same way.
- **Slow features are visible afterwards:** an entry's tooltip has its time, and features that take a large share of the build are marked, so that a user can put the marker before them, as Onshape advises.

### The view

Three layers, cheapest first:

1. **The last result, marked stale.** The view keeps the last shapes while building, as today, but greys out the faces whose owning features haven't run yet in this build, and restores each face once all its owners have ([12](12-hover-highlighting.md#design): every shown face already comes with the features that made it). Progress is painted onto the model at no cost in the worker. Geometry that the edit changes is shown as it was until the new result arrives, which the greying says.
2. **Sketch outlines as soon as their sketch has run.** Outlines are computed per sketch anyway (`outline` in [`worker.ts`](../src/cad/src/kernel/worker.ts)); sent with the feature's message, a new profile shows within milliseconds of the edit, before the booleans that use it.
3. **Intermediate bodies, within a budget.** Meshing every feature's result triples a build ([results](#reporting-cost)). Meshing the visible bodies only when that keeps meshing under 10 % of the time shows the model growing a few times per second in a slow build at a cost of about that much. It replaces the old result with an unfinished one, e.g. holes without their fillets, which may read as a regression; whether that helps more than layer 1 is a question for users, so it should be a setting at first.

With per-feature caching ([00](00-status.md#not-started)), only the features after the edited one run: the waiting entries and the stale faces are then exactly what the edit affects, and the estimate covers only them.

### Aborting and superseded builds

- **Abort terminates the worker** and starts a new one, which takes 110–150 ms, 360 ms in Firefox ([Restart](#restart), as in [06](06-poc-replicad-in-patchwork.md#re-run-cost)). The edit stays; the view keeps the last result, the timeline marks the features that didn't run, and nothing builds until the next edit or a Rebuild button. Under a toggle, this is Onshape's paused regeneration: edits don't build until asked.
- **Superseded builds can be aborted automatically.** The engine finishes a running build even when a newer source waits ([`engine.ts`](../src/cad/src/kernel/engine.ts)), which costs nothing for parts but whole seconds for a slow model edited while it builds. With an estimate, the engine terminates a superseded build whose remaining time exceeds a restart. The price is the worker's state of the shown build: picking and rollback wait for the new build; with per-feature caching, the cache too, which then calls for a cooperative stop between features (a `SharedArrayBuffer` flag, if Patchwork becomes cross-origin isolated).
- **Building only up to the marker.** The hook can also stop a build after a given feature, decided before it starts. For a slow model with the marker before its slow features, they would then not run at all. The editor shows results past the marker (`result` in [`protocol.ts`](../src/cad/src/kernel/protocol.ts)), so this only pays for models where it matters, e.g. as an option of the marker.

## Suggested order

1. The hook and the progress message, forwarded by the engine. This alone removes the 10 s limit on builds ([Reporting](#reporting)).
2. The status bar: "Building…" at once; after a delay the running feature, elapsed time, Abort; the estimate from the previous build, stored per user.
3. Build states in the timeline and the code pane, with statuses as features finish.
4. The stale view and early sketch outlines.
5. Aborting superseded builds; Rebuild and paused rebuilding.
6. Settings to try with users: intermediate bodies within a budget, building up to the marker.

## Open

- Whether intermediate bodies or the stale last result communicate progress better; only users can tell.
- Progress inside one OCCT operation, and stopping one, which need a `Message_ProgressIndicator` that JS can implement in a custom OCCT build.
- A cooperative stop between features, which needs a cross-origin-isolated Patchwork; it matters once per-feature caching makes a restart costlier.
- Matching features of two builds by name fails for unnamed features after their line moved (`extrude@L12#3`, [07](07-poc-modelling-ui.md#open)); position and type can stand in.
