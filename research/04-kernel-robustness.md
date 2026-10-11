# Kernel Robustness

> [!WARNING]
> **To be done.** This document only describes the planned approach. Nothing in it has been researched or measured yet.

OCCT operations can fail, and some return invalid geometry without reporting an error. We need to know which operations are brittle under which conditions, and how to communicate kernel failures to the user. Good failure reporting is a large potential UX advantage over existing CAD tools.

What we already know:
- **Fillet:** OCCT's own docs warn that "there may be instances where the algorithm fails … There is no initial analysis of errors and they only become evident at the construction stage" ([review, risk 5](01-basic-idea-and-literature.md#problems-and-risks)).
- **Shell:** `MakeThickSolidByJoin` failed on a simple part once a slot split one of its faces ([kernel findings](03-topological-naming.md#kernel-findings)).
- **History:** fillet and chamfer report inconsistent history (same section).

## Approach

1. **Operations to test:**
   - fillet (constant and variable radius) and chamfer
   - shell / offset
   - booleans in degenerate configurations: coplanar, tangent and nearly coincident faces, and touching edges
   - sweep, loft, draft, thicken
   - patterns made of many booleans
   - healing of imported STEP files
2. **Method:** reuse the prototype setup from [03](03-topological-naming/prototype/) (OCCT 8.0.1 via `replicad-opencascadejs`, headless in Node). For each operation, sweep its parameters over ranges on small models and classify every run:
   - **exception:** the operation throws
   - **reported failure:** `IsDone() = false`
   - **invalid result:** a shape is returned, but `BRepCheck_Analyzer` rejects it. This is the worst case, because nothing signals the error.
   - **valid result**
   
   Each failure is explained, as in 03 (strategy vs. kernel vs. prototype bug).
3. **Diagnostics:** find out which diagnostics OCCT offers per operation. For example, the fillet builder reports faulty contours and vertices (`NbFaultyContours`, `FaultyContour`), the reason a contour failed (`StripeStatus`: start failure, twisted surface, walking failure), and the faulty shape (`BadShape`). Determine which of these the wasm build exposes.
4. **UX for failures:** derive how the timeline and viewport should present failures:
   - mark the failed feature
   - keep showing the last valid geometry
   - highlight the offending edges or faces
   - explain the cause in the user's terms
   - suggest fixes, e.g. the largest fillet radius that still works, found by bisection
   - validate results so that invalid geometry is never shown as valid
5. **Prior art:** study how existing tools handle this, e.g. FreeCAD's error messages and suggestions, and how Onshape and Fusion present feature errors.
