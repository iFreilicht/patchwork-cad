# Topological Naming

Features like fillet, chamfer, shell or sketch-on-face refer to faces and edges of earlier results. Since [models are code](02-model-storage.md), each such reference must survive rebuilds after upstream edits and appear as readable text in a feature call. This document surveys the approaches and benchmarks prototypes of them. The plan was agreed on 2026-10-11.

## The problem

[Bidarra et al. (2005)](https://graphics.tudelft.nl/~rafa/myPapers/jrnl-bidarra.CAD05.pdf): "topologic entities may be split, as the block face in Figure 2.a, merged or deleted, as the blended edge in Figure 2.b, because of modeling operations. As a result, parametric definitions referring to such entities can become ambiguous or invalid". They split it into two questions:

> A. Given a b-rep, how to name a topologic entity that one needs to refer to in a parametric definition ?
> B. When re-evaluating a b-rep after a modification in the parametric definition, how to map the named entities of the pre-edit b-rep to those of the post-edit b-rep ?

For us, A is "what does the GUI write into the code when the user clicks an edge" and B is "how is that text resolved after a rebuild".

The literature starts with Kripac ([CAD 29(2), 1997](https://doi.org/10.1016/S0010-4485(96)00040-1)) and Capoyleas, Chen & Hoffmann ([CAD 28(1), 1996](https://doi.org/10.1016/0010-4485(95)00014-3)), and is surveyed by Marcheix & Pierra (SM'02, 2002). Bidarra et al. summarise its state: "All these schemes use auxiliary data structures to keep track of how faces and edges evolve, but do not really solve the problem". No scheme is complete, so the goal is to fail visibly rather than silently.

## Approaches

### 1. Index-based

The reference is the entity's position in the shape's enumeration (`Edge5`). It is what FreeCAD did before 1.0, and the [FreeCAD wiki](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Topological_naming_problem.md) defines the problem through it: "a shape changing its internal name after a modelling operation". Any upstream edit that changes the entity count or order breaks it silently. It serves as our baseline.

### 2. Geometric queries

The reference is a predicate over geometry, re-evaluated on every rebuild. replicad's [finders](https://replicad.xyz/docs/tutorial-overview/finders) work this way (`inPlane`, `containsPoint`, `ofCurveType`, …), and so do CadQuery's [selectors](https://cadquery.readthedocs.io/en/latest/selectors.html) (`>Z`, `|Z`). Such predicates are readable and need no history. But they encode *where* an entity is, not *what* it is: moving or resizing a feature can make the predicate match a different entity, or none. CadQuery warns: "If a face is not planar, selectors are evaluated at the center of mass of the face. This can lead to results that are quite unexpected." The open question for a GUI is how to generate a predicate from a click that is specific enough and still survives edits.

### 3. History-based (lineage) naming

The reference describes how an entity came about, and the name is propagated through each operation's modification history. This is the approach of Kripac's scheme, FreeCAD 1.0 and OCCT's OCAF.

- **FreeCAD 1.0** uses [Realthunder's algorithm](https://github.com/realthunder/FreeCAD_assembly3/wiki/Topological-Naming-Algorithm). Names like `Face6;:M2;FUS;:T1:5:F` encode the source element, the kind of change (`M` modified, `G` generated) and the operation. Unnamed elements fall back to names derived from neighbouring elements. Splits get "a modification index", but "The order of this index relies on what OCCT reports to us". Recovering a lost reference is a heuristic: "This guessing is not always reliable, and requires user attention, which is why it is not automated inside fillet feature." The cost: recompute time rose from 40s to 52s on its test model.
- **OCCT** provides the history data: every `BRepBuilderAPI_MakeShape` has `Generated(S)`, `Modified(S)` and `IsDeleted(S)`. These bindings exist in replicad's wasm build (`replicad_single.d.ts`). OCAF's `TNaming` builds a naming layer on top of them, which tracks evolution as `PRIMITIVE`, `GENERATED`, `MODIFY` and `DELETE` ([OCAF guide](https://occt3d.com/dev/doc/overview/html/occt_user_guides__ocaf.html)), but `TNaming` is **not** included in replicad's build.
- **Onshape** combines history with queries. [`qCreatedBy`](https://cad.onshape.com/FsDoc/library.html) returns entities "added to the context as part of that operation". Its split and merge rules are explicit: "If an entity is split …, the resulting entities are "created by" both the original entity's creator and the split part operation. If two entities are merged …, that entity is "created by" the creators of each merged entity, as well as the merging operation itself." `startTracking` follows lineage from a sketch segment. Its documented example: `startTracking(context, id + "sketch1", "line0")` evaluates to "a face and two edges (top and bottom) corresponding to line0". `makeRobustQueriesBatched` can optionally follow "through splits and merges".

### 4. Feature-semantic naming

References point only at entities that exist in the parametric definition, never at b-rep entities. Bidarra et al. propose "the use of the names of persistent feature faces, instead of the names of boundary faces". Each feature type defines named faces (a hole has `top`, `bottom`, `side`), referenced as `<feature instance name>.<feature element name>`, which "unequivocally determines one and only one entity". This requires that every b-rep face carry its owner feature face, and that coplanar faces with different owners are never merged. Edges are identified as intersections of two feature faces. When that intersection is ambiguous, "the choice should always be made by the user and not by the system".

**Zoo's KCL** follows the same idea in a programming language. A tagged sketch segment becomes a tagged face after extrusion. Edges that were not created directly are reached with helpers like `getOppositeEdge(tag)` ([KCL book](https://zoo.dev/docs/kcl-book/fillets.html)), and caps are named `START`/`END`. The limits show at booleans: `getCommonEdge` "requires the faces to be in the same original sketch", so the junction of two unioned bodies cannot be referenced this way ([issue #13854](https://github.com/KittyCAD/modeling-app/issues/13854)).

This approach fits a flat, call-based feature API well. Each feature's schema could declare named faces next to its parameters (see [feature types](02-model-storage.md#feature-types)), and references read like `f2.faces.top` or `edge(f2.side(s1.l3), f3.top)`.

## Edit types that break approaches

Collected from the sources above. These are the stress tests for the benchmark.

| Edit | Known to break |
|---|---|
| Change of a dimension that reorders or adds entities | index |
| Face split by a later feature (e.g. a slot across a face; Bidarra Fig. 2/3) | index, lineage (which child?), feature-semantic edges (needs half-space disambiguation) |
| Merge of coplanar faces in a union | lineage (several parents), KCL (`getCommonEdge`) |
| Flip of the extrude direction (Onshape's documented example) | geometric (position changes) |
| Moving or resizing a feature so a predicate matches something else | geometric |
| Inserting or deleting an upstream feature | index, lineage when ids are positional |
| Adding or removing a sketch segment | index; lineage and feature-semantic if segments are identified by position |
| A referenced entity truly disappears (e.g. Bidarra's slot moving off the face) | all: must be *reported*, not silently replaced (Bidarra Fig. 3c shows systems silently picking "the other edge") |

## Benchmark

*Pending (Phase 2).*

## Recommendation

*Pending (Phase 3).*
