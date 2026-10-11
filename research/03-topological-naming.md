# Topological Naming

Features like fillet, chamfer, shell or sketch-on-face refer to faces and edges of earlier results. Since [models are code](02-model-storage.md), each such reference must survive rebuilds after upstream edits and appear as readable text in a feature call. This document surveys the approaches and benchmarks prototypes of them.

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

The prototype is in [03-topological-naming/prototype/](03-topological-naming/prototype/), and the full generated results, including every failure, are in [results.md](03-topological-naming/results.md). To reproduce, run `nix develop -c pnpm test` and `pnpm exec tsx src/report.ts --details` in the prototype directory.

### Setup

- **Kernel:** OCCT 8.0.1 via `replicad-opencascadejs` 1.1.0, loaded headless in Node. replicad itself never reads OCCT's history (no calls to `Modified`/`Generated`), so the prototype runs the modelling operations itself with raw OCCT builders ([model.ts](03-topological-naming/prototype/src/model.ts)). After each boolean it calls `SimplifyResult`, as replicad's `fuseShapes`/`cutShape` do, so coplanar faces merge as they would in the real tool.
- **Models:** a small flat feature list per model, mirroring [the model is code](02-model-storage.md):
  - M1: Bidarra's slotted block
  - M2: a plate with a hole pattern
  - M3: an L-bracket with a merged back face and a rib
  - M4: a revolved stepped shaft
  - M5: a boss on a box, then shelled
  
  Each model has three references, covering fillet/chamfer edges, sketch-on-face and shell faces, and 6–8 edits from the [edit table](#edit-types-that-break-approaches). That gives 108 cells per strategy.
- **Ground truth:** for each reference, a hand-written oracle describes what the user *means* in geometric terms, e.g. "front face piece right of the notch, where the boss sits". It also states whether the entity is gone after an edit. Each oracle's result count is asserted for the base model and every edit ([oracles.test.ts](03-topological-naming/prototype/test/oracles.test.ts)). Models are built with the oracle's answers for all references, so each reference is scored independently. For flips, intent follows the extrude's cap, as in Onshape's documented example.
- **Scoring:** ✅ correct, or "gone" correctly reported; ⚠️ reported missing or ambiguous although the entity still exists; ❌ silently resolved to something else. When a strategy reports a problem, it may additionally offer a *suggestion* for the user to confirm, which is scored separately.

### Strategies

- **S0 index:** a position in OCCT's entity enumeration. This is the baseline.
- **S1 geometric:** a finder-style predicate chain generated from the pick: type, then orientation, then position, then a contained point, stopping at the shortest prefix that is unique (like a GUI writing replicad finder code).
- **S2 lineage:** feature-semantic origin names as in [approach 4](#4-feature-semantic-naming): `f1.side(front)`, `f1.end`, `f3.fillet(…)`. Edges are named by their two adjacent faces. Same-named pieces are told apart by a positional index (`#1`).
- **S3 hybrid:** S2 plus geometry. If the number of same-named pieces changed, it reports instead of resolving, and suggests the piece that minimum-distance centroid matching identifies.
- **S4 history:** FreeCAD-style names. Each split appends `/<op>#<k>`, where k is the position in OCCT's `Modified` list, and edges get their own history. A reference resolves to all *descendants* of the captured name, so it follows later splits when the parameter accepts several entities (fillet edges: yes; sketch plane: no). A surviving ancestor, e.g. when a split was undone, is only suggested.

### Results

| Strategy | ✅ correct | ⚠️ reported | ❌ silently wrong | suggestion right |
|---|---|---|---|---|
| S0 index | 65 | 7 | 36 | – |
| S1 geometric | 70 | 32 | 6 | – |
| S2 lineage | 96 | 9 | 3 | – |
| S3 hybrid | 96 | 12 | 0 | 5/7 |
| S4 history | 98 | 10 | 0 | 5/7 |

Resolution takes well under 1 ms per reference for all strategies (S1 is slowest at about 0.8 ms, because it evaluates the geometry of every candidate entity). Results per edit category are in [results.md](03-topological-naming/results.md).

### Failure analysis

Each strategy explains its own non-✅ cells (`explain()` in [strategies.ts](03-topological-naming/prototype/src/strategies.ts)), and rules in [report.ts](03-topological-naming/prototype/src/report.ts) map each explanation to a mechanism. A test fails if any cell stays unclassified ([bench.test.ts](03-topological-naming/prototype/test/bench.test.ts)). The mechanisms were also checked by hand. All 115 non-✅ cells are strategy limitations:

- **S0:** an upstream topology change shifts indices (33 ❌). An index that now points at another entity is wrong in 3 cases; one that's out of range is reported in 7.
- **S1:** the generated predicates pin positions (`center`, `onLine`, `containsPoint`, `inPlane`) or orientations (`facing`). Edits that move or resize things make them miss (29 ⚠️), and a minimal predicate can stop being unique (3 ⚠️). They are silently wrong when another entity takes the old place (6 ❌):
  - After "taller box", the boss's *bottom* edge sits where its top edge was.
  - After "notch to right end", `containsPoint` hits the left piece (Bidarra's Fig. 3c).
  - A flip turns the start cap into the face that now faces +Z.
  - After an upstream split, the predicate matches only one of the pieces.
- **S2:** the positional sibling index picks the wrong piece when an upstream feature adds pieces (3 ❌). It reports when a sibling vanishes (5) or a named face splits (2).
- **S3 and S4:** no silent errors. They report in three situations:
  - when pieces appear or vanish (S3: 10; S4: 5 where a split was undone, 3 where a sketch-plane reference now has several descendants)
  - when a sketch edit changes which segment bounds a face (2 each, M4: a groove splits segment `small`, or the step is removed)
  - In both sketch-edit cases the origin name truly no longer exists. Which piece keeps a split segment's name is a sketcher convention.
- **Wrong suggestions:**
  - S4's ancestor fallback suggests the *other* piece after "notch to right end", i.e. Bidarra's Fig. 3c, offered rather than applied. S3's centroid matching gets that case right.
  - S3's one-to-one matching suggests only some of the pieces after an upstream split.

Two failures during development turned out to be bugs in the prototype, and both were fixed before the results above. A convex fillet thinner than the shell thickness made M5's shell fail. And the prototype trusted OCCT's `IsDeleted` (see below).

### Kernel findings

- **OCCT history has gaps.** `BRepPrimAPI_MakeRevol` reports no `Generated` face for profile edges that touch the axis (the end disks of a revolved part). `BRepOffsetAPI_MakeThickSolid` reports the inner faces as `Generated`, not `Modified` ([debug-history.ts](03-topological-naming/prototype/investigations/debug-history.ts)). The prototype names such disks by the profile segment that lies in them.
- **OCCT history can be inconsistent.** `BRepFilletAPI_MakeFillet`/`MakeChamfer` report `IsDeleted() = true` for edges that are still present (`IsSame`) in the result: 25 times in a single M1 build, edges only ([quirks.ts](03-topological-naming/prototype/investigations/quirks.ts), [debug-notch2b.ts](03-topological-naming/prototype/investigations/debug-notch2b.ts)). Trusting it broke S4's names after fillets, so presence in the result now takes precedence.
- **`SimplifyResult` keeps history intact.** Merged coplanar faces carry both parents' names ([model.test.ts](03-topological-naming/prototype/test/model.test.ts)).
- **OCCT's shell is fragile.** `MakeThickSolidByJoin` fails on M5 once a slot splits the cap, for every variant tried ([shell-slot.ts](03-topological-naming/prototype/investigations/shell-slot.ts)). This matches the review's [risk 5](01-basic-idea-and-literature.md#problems-and-risks).

### What references look like as code

From [codes.ts](03-topological-naming/prototype/investigations/codes.ts), for M1's boss face and M3's corner edges:

| Strategy | M1 `frontRightFace` | M3 `innerCornerEdges` (2 pieces) |
|---|---|---|
| S0 | `[7]` | `[17], [21]` |
| S1 | `type("plane").facing([0, -1, 0]).inPlane(0).containsPoint([49.501, 0, 9.499])` | `type("line").axis([-1, 0, 0]).onLine([60, 8, 8]).containsPoint([46.5, 8, 8])`, … |
| S2 | `face("f1.side(front)", #1)` | `edge("base.end \| upright.side(back)", #0)`, `… #1` |
| S4 | `"f1.side(front)/notch#2"` | `"edge(upright.side(back) \| upright.start)/rib0#1"`, `…#2` |

- **S0/S1:** the text depends on dimensions, so a GUI would have to rewrite it after unrelated edits. In a collaboratively merged code document, that is churn and a source of conflicts.
- **S2–S4:** the text does not depend on dimensions and only changes when the user re-picks.
- **S4's readability:** names describe how an entity *came about*. M3's corner edge was created between the upright's start cap and back face; that start cap has since merged into the base and no longer exists as a face. This is stable, but not something a user should have to read.
- **S4's split index:** `#k` depends on OCCT's ordering of `Modified` results, which a kernel upgrade could change. FreeCAD's author names the same weakness.

### Limitations of this benchmark

- The suite is small and hand-made: 5 models and 108 cells per strategy, and the intent conventions are mine.
- S2's index and S1's minimal-prefix rule are only one way to implement each approach.
- The suite does not test sketch-level references (projections), assemblies, or concurrent edits to reference text.

## Recommendation

Use **history-based naming rooted in feature-semantic origin names (S4)** as the primary mechanism, and add S3's geometric piece matching *only* for suggestions:

1. **Origin names come from the code.** A face is named by its feature variable and the sketch segment or cap that generated it (`f1.side.front`, `f1.end`), as in Bidarra et al. and KCL. Sketch segments therefore need stable, user-visible ids, which constrains the sketch feature design.
2. **Splits extend the name** with the splitting feature and piece index. A reference resolves to all descendants. Whether several descendants are acceptable is declared by the parameter's schema (an edge list or a single plane), which fits [feature types](02-model-storage.md#feature-types).
3. **Never resolve silently when pieces vanish or appear.** Report the reference as broken in the timeline, and offer a suggestion from centroid matching rather than from the ancestor name. Also cross-check `#k` against that matching, so a change in OCCT's ordering shows up as a reported conflict and is never applied silently.
4. **Work around the kernel's history quirks:** the result's actual content beats `IsDeleted`, and there are fallbacks for faces without history (revolve disks).
5. **References in code** should be expressions over feature variables rather than strings, so that renaming a feature carries over and typos fail loudly. For example:

```ts
const f3 = fillet({ edges: [edge(f1.end, f1.side.front).piece(notch, 1)], radius: 2 });
const f5 = extrude({ on: f1.side.front.piece(notch, 2), profile: …, distance: 4 });
```

  The GUI writes these when the user clicks, and highlights them instead of expecting users to read history names.
