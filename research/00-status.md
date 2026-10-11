# Research Status

| Document | Topic | Status |
|---|---|---|
| [01-basic-idea-and-literature.md](01-basic-idea-and-literature.md) | Project idea, fact check, risks | Done |
| [02-model-storage.md](02-model-storage.md) | The model is code; timeline as a view; feature types; imports | Done. Open: expression scope, collapsed-timeline UX, sandboxed module loading |
| [03-topological-naming.md](03-topological-naming.md) | Stable references to faces and edges, benchmarked with prototypes | Done. Open: prototype of the reference syntax |
| [04-kernel-robustness.md](04-kernel-robustness.md) | Which OCCT operations fail, and how to report failures | To do (approach only) |

## Not started

- Sandboxing model code execution ([review, risk 3](01-basic-idea-and-literature.md#problems-and-risks))
- Rebuild performance and per-feature caching (risk 4)
- Licensing obligations for the OCCT wasm build (risk 6)
- Embedding: decal, reference in a sketch, annotation (item 7)
- Sketches: stable segment ids (required by [03](03-topological-naming.md#recommendation)), constraints, e.g. with PlaneGCS
- Assemblies and joints
