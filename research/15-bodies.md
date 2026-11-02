# Bodies

The editor answers three questions with one mechanism, `main`'s return ([07](07-poc-modelling-ui.md#the-editor)), although they have different owners:

| | Question | Owner | Stored in |
|---|---|---|---|
| [Visibility](#visibility) | What does this user see? | Each user | View state ([10](10-view-state.md#storage)) |
| [Output](#output) | What does the model give its callers? | The model's author | The code: `return` |
| [Availability](#availability) | What can the next feature work on? | Nobody | Nowhere: derived from the code |

All three are about [bodies](#bodies-and-lineages), which the code doesn't name: it only has versions. The UI for them is a [timeline with lanes](#the-timeline-with-lanes) and a [browser](#the-browser).

## Prior art

- **Fusion** keeps visibility out of the timeline, in the Browser, a tree of components, bodies and sketches: "click the eyeball next to the Sketch or Sketches folder in the Browser Tree" (Autodesk, via search; the article answers 403 to fetches). A folder's eye doesn't reset its children: "I don't believe it forces the children to be either on or off, when clicking the lightbulb" ([Autodesk forum](https://forums.autodesk.com/t5/fusion360-design-validate-document/fusion360-browser-version-does-not-allow-to-show-hide-bodies/td-p/7242570)). A consumed sketch hides itself ("Auto hide sketch on feature creation", a preference), because "in probably 80-90% of the use cases, each sketch is single-use" ([Autodesk forum](https://forums.autodesk.com/t5/fusion-360-design-validate/after-extrude-the-sketch-is-hidden-why-how-to-disable-this/td-p/7140598), via search). Combine consumes its tool bodies: you pick "the Target Body first, then the Tool Bodies", and only the option Keep Tools "retains the tool bodies after the combine" ([Combine reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-COMBINE.htm), via search).
- **Onshape** splits it the same way. In the Feature list, hiding is for sketches and other non-solid features: "hover next to a feature's name and click the eye icon" ([Feature and Part Lists](https://cad.onshape.com/help/Content/PartStudio/features_and_parts_lists.htm)). Solids are hidden in the Parts list at the bottom of it, because there is no one-to-one correspondence between features and parts: many features, like extrude, can produce several parts (Onshape staff, [forum](https://forum.onshape.com/discussion/9818/hidden-3d-features), via search). The Parts list has "Hide", "Hide other" and "Hide all"; "Hovering over a hidden entity in the list shows its outline in the graphics area"; a list title's eye hides all its entities; the search filter `:hidden` lists "hidden features and bodies" (same page). In the graphics area, "use the Y key to Hide. Use Shift+Y to Show", and "Show all" brings everything back ([Hide/Show](https://cad.onshape.com/help/Content/View/hide_show.htm)). Hiding is shared by everyone in the workspace, "Hide/Show is per workspace and affects all windows/users", while Isolate and Make Transparent are per user (forum posts, via search; their pages require a login).
- **SolidWorks** shows the Solid Bodies folder only for parts with several bodies, so a hidden single body leaves nothing in the tree that reminds the user of it ([Javelin](https://www.javelin-tech.com/blog/2016/08/solidworks-model-missing/)). Hidden items are greyed out in the tree.
- **Shapr3D** lists every sketch, body and plane in the Items Manager, each with "a Visibility icon that can be toggled", with bulk commands "Show Hidden Items" and "Invert All Item Visibility" ([Items Manager](https://support.shapr3d.com/hc/en-us/articles/7873936188956-Items-Manager), via search). Sketches hide themselves after an extrusion, too.
- **Plasticity** has an Outliner of objects with hide toggles and a per-session Isolate: "displaying it exclusively on the screen, while temporarily hiding all other objects", nestable ([Focus and Isolate](https://doc.plasticity.xyz/plasticity-essentials/focus-and-isolate-objects)).
- **FreeCAD** toggles visibility with the space bar or the context menu; "A hidden object shows up grayed out in the tree" ([Tree view](https://wiki.freecadweb.org/Tree_view)). A clickable eye in the tree is requested in [#12341](https://github.com/FreeCAD/FreeCAD/issues/12341).
- **Code CAD:** OpenSCAD marks visibility in the code with modifiers: `*` disables a subtree, `!` shows only it, `%` draws it transparent without using it ([cheat sheet](https://openscad.org/cheatsheet/)). OCP CAD Viewer for CadQuery and build123d shows what `show()` was given as a tree with checkboxes, which only change the viewer ([vscode-ocp-cad-viewer](https://github.com/bernhard-42/vscode-ocp-cad-viewer)).
- **Grasshopper** is a node graph without an order: "Programs are created by dragging components onto a canvas. The outputs of those components are then connected to the inputs of subsequent components" ([Wikipedia](https://en.wikipedia.org/wiki/Grasshopper_3D)). Large definitions tangle: a wire is "like a string that attaches one node to another (we jokingly call this the spaghetti" ([Packhunt](https://www.packhunt.io/blog/terms-and-functions-in-grasshopper), via search), untangled with clusters, proxy parameters and hidden wires ([McNeel forum](https://discourse.mcneel.com/t/managing-large-projects/55455?page=2), via search).
- **git** draws a graph next to a linear list: `--graph` draws "a text-based graphical representation of the commit history on the left hand side of the output" ([git-log](https://git-scm.com/docs/git-log)).

## Bodies and lineages

A feature's result is a version of a body: in `plate → bore → fillet1` the three are versions of one body. A body is therefore a lineage of versions, derived from the version uses (`body:`, `target:`) in the deps graph ([07](07-poc-modelling-ui.md#reordering)):

- **A version that one later version uses continues its lineage.** The last version of a lineage is its head.
- **A version that several later versions use forks:** each further use starts a lineage of its own.
- **A boolean merges lineages:** its target's lineage continues, its tools' lineages end there, as Fusion's Combine consumes tool bodies. There is no "Keep Tools": nothing is ever destroyed, so a later feature can use a tool's version again, which forks it.
- **A sketch is a lineage of one version.** A feature that uses it consumes it, as a tool; a second use forks it.
- **A lineage is named by its first feature** (`plate`), so its name stays when features are added. Renaming a body renames that variable.

## Visibility

What a user sees is view state, like the timeline marker ([07](07-poc-modelling-ui.md#the-timeline-marker)): hiding a body to look inside the model changes neither the model nor what a collaborator sees, unlike Onshape's shared hiding.

- **The outputs show by default.** Each user hides outputs or shows private bodies and versions on top of that, with the eyes in the [browser](#the-browser).
- **Presence wins over hiding:** a body that a collaborator hovers or selects ([13](13-collaboration.md#presence-1)) shows as a ghost, even where this user hid it.
- **Peeking already works:** hovering an entry whose result isn't shown draws that result ([12](12-hover-highlighting.md#design)), as Onshape outlines a hovered hidden part.
- **Isolate**, per user, comes later.

## Output

A model is a function, and `return` is its public interface: a caller (`body(() => model.default(…))`, [11](11-adopting-shapes.md#body)) gets what it lists. Every other version is private.

- **Heads are returned by default.** A new feature's result takes its input's place in the return ([07](07-poc-modelling-ui.md#the-editor)). A head that nothing uses or returns is useless to a caller, so the timeline greys it out; a user may still keep it around and show it locally.
- **Any version can be returned,** also a consumed one, e.g. a tool body before the cut.
- **Toggled in the browser and the context menus** of timeline entries and bodies in the 3D view, and in the dialog of the [return entry](#the-timeline-with-lanes).
- **The output toggle is not an eye,** since it changes the model for every caller, and not an arrow, which reads as a modelling command (extrude, revolve). Ideas to compare in a prototype: a port at the end of a lane, filled when returned and hollow when private, the same glyph in the timeline and the browser; a code-like `⟩`; a text badge "out".

## Availability

Code can use any earlier variable, so the UI ranks versions instead of restricting them. The heads at the marker are available and listed; consumed versions are history, reachable in two ways:

- by rolling the marker back to where the version is a head, and
- by picking its timeline entry while a body, target, tool or sketch field is active.

The field's dropdown of variables goes away: a field is filled by picking, in the 3D view, the browser or the timeline.

### Inserting into a chain or branching

A new feature goes in at the marker. When the version it works on is used by a feature after the marker, the feature can either join the chain or branch off it. With the marker between `bore` and `fillet1`:

```js
const plate = extrude({ … });
const bore = extrude({ operation: "cut", target: plate, … });
const fillet1 = fillet({ body: bore, … });
return [fillet1];
```

A chamfer on `bore` that joins the chain makes one body, chamfered and filleted; `fillet1` is rewired to it (`insertFeatureAt`, as Fusion does). That is the default, for a step that was forgotten or belongs earlier:

```js
const chamfer1 = chamfer({ body: bore, … });
const fillet1 = fillet({ body: chamfer1, … });
return [fillet1];
```

A branch leaves `fillet1` as it is and makes a second body that shares `plate → bore`, e.g. a variant, a lid made from the same base as its box, or a clearance body used as a cut's tool:

```js
const chamfer1 = chamfer({ body: bore, … });
const fillet1 = fillet({ body: bore, … });
return [fillet1, chamfer1];
```

Where the version's continuation is decides which of these the dialog offers:

| Picked version | Result |
|---|---|
| A head | It continues; nothing to choose |
| Continued after the marker | Join (default) or branch, a toggle in the dialog |
| Continued before the marker | Branch: joining would put the feature before its continuation, not at the marker |

Picking a consumed timeline entry is therefore always a branch. Sketches never ask, as no feature continues a sketch.

## The timeline with lanes

The timeline stays a view of the code: its x-axis is the order of statements, one entry per position, as now. Beneath the entries, each lineage is a lane, as in `git log --graph`; forks split lanes, merges join them.

- **Lanes are thin.** Each position has one entry only, so lanes needn't be as tall as an entry, and a lane's row is reused once its lineage ends. The height is that of the most lineages alive at once.
- **The layout shows the code's order:** whether it groups the features of a body or interleaves unrelated ones.
- **One marker spans all lanes.** It is still a position in the code, so rolling back and inserting stay as they are; moved before a merge, the merged lanes come apart. Markers per lineage would roll back something other than a prefix of the code, which is looking at old versions (peeking does that), and would leave no single place for a new feature.
- **The return is the last entry,** where lanes end. A lane that reaches it is an output; one that ends at a merge was consumed; one that ends elsewhere is private. A returned version inside a lane has a thin line to it. Its dialog lists the outputs with their toggles. The marker can't pass it.
- **Node positions aren't stored.** A Grasshopper-like graph needs them: in the model they aren't portable ([02](02-model-storage.md#design-goal-portable-models)), in view state each user's layout differs. It also has no order for the marker, and large graphs tangle. A free graph could be a separate tool on the same model later.

## The browser

A pane next to the timeline, listing what exists at the marker: the bodies (heads), unused sketches and later construction geometry, in folders. Each row has the body's name, an eye and the output toggle; returned versions inside a body are listed under it. Hovering a row highlights the body in the 3D view and its lane in the timeline; clicking selects it, or picks it while a field is active. Keeping the toggles in the browser keeps the timeline compact.

## Prerequisites

A boolean feature, `combine({ target, tools: […], operation: "join" | "cut" | "intersect" })`, which consumes its tools. The test model needs a merge (a boss modelled separately and joined), a cut whose tool forks from its target (`a → b`, `c = shell(a)`, `combine({ target: b, tools: [c], operation: "cut" })`) and a private fork.

## Open

- Which use of a forked version continues its lineage and keeps its name. Code order fails: a branch inserted at a rolled-back marker comes before the chain's own continuation.
- Named outputs (`return { bracket, mountingPlate }`), together with `body()`'s arrays ([11](11-adopting-shapes.md#body)), and names of bodies independent of features.
- Drawing lanes in all cases: forks that merge again, merges of several tools.
- The output glyph.
