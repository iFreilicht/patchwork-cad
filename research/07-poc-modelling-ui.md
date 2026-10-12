# PoC 2: modelling UI

> [!WARNING]
> **To be done.** This is an abstract; nothing has been built yet. It depends on [PoC 1](06-poc-replicad-in-patchwork.md).

The second proof of concept: the Fusion-360-like experience on top of PoC 1. It tests whether "the model is code, the timeline is a view" ([02](02-model-storage.md#the-timeline-is-a-view)) holds up in use.

## Scope

- **A feature library subset** defined with `defineFeature` ([feature types](02-model-storage.md#feature-types)): a sketch with simple segments, extrude, fillet, and one boolean. Enough for the parts in the [naming benchmark](03-topological-naming.md#setup).
- **The timeline editor:** parse the code text, show recognized feature calls as timeline entries and everything else as Custom Script entries. Editing a feature's parameters in a form splices only the changed argument's source span back into the text, and code and timeline edits merge live between two users.
- **Selection and references:** pick a face or edge in the 3D view to fill a reference parameter, written as a JS expression following [03's recommendation](03-topological-naming.md#recommendation) (S5), with broken references reported in the timeline.

## Questions to answer

- **Text vs. AST editing:** [02](02-model-storage.md#decision-the-model-is-code) defers this to implementation. Which one keeps concurrent edits and formatting intact in practice?
- **Feature identity across re-parses:** variable name or an automerge cursor ([02, consequences](02-model-storage.md#consequences)), so that open forms and selections survive concurrent edits.
- **The reference syntax:** 03's open item, a prototype of reference expressions that users never have to type.
- **Collapsed timelines:** how the UI presents large Custom Script regions and references into them.
- **Rebuild performance:** whether a full re-run per edit is fast enough for the subset, or per-feature caching is needed ([review, risk 4](01-basic-idea-and-literature.md#problems-and-risks)).

## Out of scope

Sandboxing (still unsandboxed and local, as in PoC 1, unless [05](05-sandboxing.md) is done by then), sketch constraints, assemblies, imports of other models, and the full feature set.

## Done when

Two users can build one of the benchmark parts together, partly through forms and partly in code, with a working timeline and references that survive an upstream edit, and the questions above have answers backed by the PoC.
