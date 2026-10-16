# Research Status

| Document | Topic | Status |
|---|---|---|
| [01-basic-idea-and-literature.md](01-basic-idea-and-literature.md) | Project idea, fact check, risks | Done |
| [02-model-storage.md](02-model-storage.md) | The model is code; timeline as a view; feature types; imports | Done. Open: expression scope, sandboxed module loading |
| [03-topological-naming.md](03-topological-naming.md) | Stable references to faces and edges, benchmarked with prototypes | Done; reference syntax prototyped in [07](07-poc-modelling-ui.md#the-reference-syntax) |
| [04-kernel-robustness.md](04-kernel-robustness.md) | Which OCCT operations fail, and how to report failures | To do (approach only) |
| [05-sandboxing.md](05-sandboxing.md) | Threat model and sandbox runner for model code; local test harness | In progress: [test harness](05-sandboxing.md#test-harness) done; sandbox runner to do |
| [06-poc-replicad-in-patchwork.md](06-poc-replicad-in-patchwork.md) | PoC 1: replicad and OCCT in a Patchwork tool, code editor and 3D view | Done ([src/cad](../src/cad/), `pnpm dev`). Open: real-network and Safari load times, Firefox's slower OCCT |
| [07-poc-modelling-ui.md](07-poc-modelling-ui.md) | PoC 2: feature library subset, timeline editor, selection and references | Done ([src/features](../src/features/), tool `cad-model`; [ViewCube](07-poc-modelling-ui.md#the-viewcube), [timeline marker](07-poc-modelling-ui.md#the-timeline-marker), [reordering](07-poc-modelling-ui.md#reordering)). Open: other mental models of bodies, committing the marker, same-argument conflicts, names of features in loops |
| [08-module-evaluation.md](08-module-evaluation.md) | Model evaluations per build, their cost, module retention, OCCT memory | Done. Open: which objects fillet/chamfer/fuse leak |
| [10-view-state.md](10-view-state.md) | Per-user UI state in the account's tool storage; instance identity; view documents | Done. Open: orphan views of cancelled drags, the UX of listing and editing views |
| [11-adopting-shapes.md](11-adopting-shapes.md) | `body()`: replicad shapes as bodies of the feature library; context menus in the timeline | Done. Open: history of adopted library bodies, scalar calculations; touch deferred |
| [12-hover-highlighting.md](12-hover-highlighting.md) | Hovering and selecting faces, edges and features; see-through highlights, also past the marker; cross-hover between view, timeline and code | Done. Open: faces a feature only modifies, highlights in large models |
| [13-collaboration.md](13-collaboration.md) | Presence (cursors, selections, markers in each collaborator's colour) and comments on code, faces, edges and features; deleted targets | Presence done (editor and viewer). Open: presence provider upstream, follow mode; comments to do |

## Not started

- Always display unused sketches (maybe by also returning them from the model function like "unused" features? Just a thought)
- Add a "Move" feature that creates a copy of a body at a different location. Translating by a set number of mm in X, Y or Z axis is enough for now.
- Allow disabling tangent selection of edges when creating fillet or chamfer
- Allow toggling visibility of sketches
- A build timer and an abort button in the status bar, in place of the fixed 10 s kernel timeout ([08](08-module-evaluation.md#conclusions)), for very complex models
- Per-feature caching ([review, risk 4](01-basic-idea-and-literature.md#problems-and-risks)); not needed for PoC 2's parts ([07](07-poc-modelling-ui.md#rebuild-performance))
- Licensing obligations for the OCCT wasm build (risk 6)
- Embedding: decal, reference in a sketch, annotation (item 7)
- Sketches: constraints, e.g. with PlaneGCS (stable segment ids: [07](07-poc-modelling-ui.md#the-feature-library))
- Assemblies and joints
