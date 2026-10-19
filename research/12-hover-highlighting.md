# Hover Highlighting

Hovering shows how a model is built: the 3D view always hovers faces and edges, the editor names them, hovering a feature in the timeline or code highlights what it made, and hovering a face marks the features that made it.

## Prior art

- **Onshape:** "Hover over a feature to see the corresponding highlighting on the model", and the other way round, "Selecting a face or part in the graphics area also cross-highlights associated features" ([Feature and Part Lists](https://cad.onshape.com/help/Content/feature_list.htm)).
- **Fusion:** "If you hover over a feature, you will see the impacted geometry highlight in a dark color" ([VDCI](https://vdci.edu/learn/cad/organize-your-fusion-360-timeline-with-groups-editing-and-grouping-objects)).
- **Past the rollback bar,** both suppress features: "all features listed beneath the rollback bar become temporarily suppressed" ([Onshape](https://cad.onshape.com/help/Content/feature_list.htm)). They have no geometry to highlight; no source says what a hover on them shows.

## Design

- **The 3D view always hovers.** Without a pick target, an edge under the pointer wins, else the face ([`Viewer.tsx`](../src/cad/src/components/Viewer.tsx)). Shapes that aren't feature-library bodies (plain replicad, [11](11-adopting-shapes.md)) hover too, by mesh group, but have no names.
- **Every highlight shows through the model:** a translucent copy of the entities' triangles and segments, drawn without depth test over the opaque model. So a hovered feature's faces also show where other faces hide them, and the model is never painted over. Hovered faces are pale (`--cad-model-hover`); selected faces and the resolved references of a feature being picked ([07](07-poc-modelling-ui.md#the-editor)) are in the accent colour. Hovered and selected edges share the accent colour and a halo, a hover thinner, and hovered faces are outlined with the hover's line ([14](14-edge-contrast.md#the-rendering)).
- **The editor names entities** in the status bar, as a pick would write them (`extrude1.side.front.piece(notch, 2, { near: […] })`, [`WysiwygEditor.tsx`](../src/cad/src/components/editor/WysiwygEditor.tsx)). A click outside of picking selects the face or edge under the pointer, and a click elsewhere in the view clears it; the status bar shows the selection's name, with a Copy button, else the hovered one's. A name costs one `pick` request to the worker, for a hover after the pointer rests for 100 ms. The viewer tool hovers without names, since it is for looking at a model, not for writing it.
- **A feature owns the faces it created or split**, read from the history names ([03](03-topological-naming.md), `owners` in [`runtime.ts`](../src/features/src/runtime.ts)): the base of a name names the feature that created the face, and each `.piece(op, k)` a feature that split it. Its edges are those along its faces. The worker sends each shown body's owners with its mesh, so hovering a feature needs no request.

| Hovered | Highlighted |
|---|---|
| sketch | its profile, as for the open sketch |
| extrude (new, join, cut) | the volume it added or removed, as a ghost: a new body all of it, a join the added material, a cut the removed material |
| fillet, chamfer | `x.face(…)`, `x.corner`, including faces of tangent chains ([07](07-poc-modelling-ui.md#the-reference-syntax)) |
| Custom Script | the features it ran; in the code pane, those of the hovered line, e.g. one rib call of a loop |

- **Each feature type chooses what its hover shows** (`hover` in its schema, [`schema.ts`](../src/features/src/schema.ts); `FeatureSchema` and `defineFeature` both require it, so a new feature can't leave it out): `faces`, the faces it owns, which suits features that change a body near its faces, or `difference`, the volume it changed. An extrusion owns every face it split, so a join or a cut lit up large faces it barely touched; its volume is what it did. The worker computes it from the feature's trace entry, which keeps the bodies it consumed (`inputs`), as what its result has and its inputs don't and the other way round (`changedVolume` in [`runtime.ts`](../src/features/src/runtime.ts), [`changed.test.ts`](../src/features/test/changed.test.ts)), and meshes it on request (`difference`). The ghost is the hover's pale fill with edges as thin as the model's and no outline; it is the volume at the feature, also past the marker or after later features changed it.
- **The code pane** highlights the feature of the statement under the pointer or at the cursor, like its timeline entry ([`CodeEditor.tsx`](../src/cad/src/components/CodeEditor.tsx), [`state.ts`](../src/cad/src/components/editor/state.ts)). Of the two, the one that moved last wins, so neither a pointer parked over the code nor a cursor left in it hides what the other points at; the cursor counts only while the pane has focus.
- **Cross-hover:** hovering a face or edge in the view tints the timeline entries of its owners and their code (the lines of a Custom Script that ran them); hovering code tints its entry. Like Onshape's cross-highlighting, on hover instead of selection.
- **Features past the marker are highlighted, too.** Our editor builds the whole model also past the marker ([07](07-poc-modelling-ui.md#the-timeline-marker)), so it can show what a rolled-back feature will do. When a hovered feature of the `faces` kind owns nothing in the shown bodies, because it is past the marker, its result is unused, or later features removed its faces, the worker meshes its result (`result`), and the view highlights the feature's faces there, in the same style. Collaborators' hovered features show the same way ([`featureHighlights.ts`](../src/cad/src/components/featureHighlights.ts)).

Tested by [`names.test.ts`](../src/features/test/names.test.ts) on M1, [`body.test.ts`](../src/features/test/body.test.ts) and [`cad-hover`](../src/harness/e2e/tests/cad-hover.spec.ts) in Chromium, Firefox and WebKit.

## Limits

- **Only creation and splits are in the names.** A face that a feature only modifies, e.g. one a fillet trims, keeps its names (`propagate` in [`topo.ts`](../src/features/src/topo.ts) gives a single Modified result the input's names), so it isn't highlighted. Fusion's "impacted geometry" may include such faces; recording them would need a per-face list of modifying features in `Topo`.
- **Splits make a feature own faces of another.** The notch owns the pieces of `extrude1.side.front`, which both features highlight.
- **A `body()` owns its bodies' faces by the bodies' names** ([11](11-adopting-shapes.md)): its `faceAt` names carry the body's name (`left`, `right`), not the entry's. The editor therefore matches an entry by its feature's name and its bodies' names, and fetches a result past the marker by body name.

## Open

- Touch has no hover ([11](11-adopting-shapes.md#touch)).
- Highlights show through every face; whether they read well in larger models is untested.
- A rebuild clears the selection, because entity indices may name other entities in the new shapes.
- Collaborators' hovers ([status](00-status.md#not-started), collaboration features).
