# Bodies

Three questions about a model's results have different owners, and the editor answers each in its own place:

| | Question | Owner | Stored in |
|---|---|---|---|
| [Visibility](#visibility) | What does this user see? | Each user | View state ([10](10-view-state.md#storage)) |
| [Output](#output) | What does the model give its callers? | The model's author | The code: `return` |
| [Availability](#availability) | What can the next feature work on? | Nobody | Nowhere: derived from the code |

All three are about [bodies](#bodies-and-lineages), which the code doesn't name: it only has versions. The UI for them is a [timeline with lanes](#the-timeline-with-lanes) and a [browser](#the-browser). Implementation: [`lanes.ts`](../src/cad/src/model/lanes.ts), `chainMode`, `setChainMode`, `retool` and `removeFromReturn` in [`splice.ts`](../src/cad/src/model/splice.ts), [`bodies.ts`](../src/cad/src/components/editor/bodies.ts), [`Browser.tsx`](../src/cad/src/components/editor/Browser.tsx), [`TimelineLanes.tsx`](../src/cad/src/components/editor/TimelineLanes.tsx), `combine` in [`features.ts`](../src/features/src/features.ts); tests: [`lanes.test.ts`](../src/cad/test/lanes.test.ts), [`bodies.test.ts`](../src/cad/test/bodies.test.ts), [`combine.test.ts`](../src/features/test/combine.test.ts), [`cad-bodies.spec.ts`](../src/harness/e2e/tests/cad-bodies.spec.ts), on [M4](../src/features/examples/m4.js): a boss joined onto a plate, a corner cut out by a copy of the plate, a private fork and a lid.

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

A feature's result is a version of a body: in `plate → bore → fillet1` the three are versions of one body. A body is therefore a lineage of versions, derived from the dependency graph ([07](07-poc-modelling-ui.md#reordering)), whose version uses are `body:` and `target:` (consume), a move's or a sketch's `body:` (read) and a combine's `tools:` (tool):

- **A version that one later feature continues** (`body:` of a fillet, `target:` of a join, a combine or a cut) is followed by that feature's result in its lineage. The last version of a lineage is its head.
- **A sketch becomes the body a new extrusion makes:** sketch and extrusion are one lane. An extrusion with a target merges its sketch into the target's lineage instead.
- **A version that several features continue forks:** the continuation with the longest chain after it keeps the lineage, the earlier one on a tie; each other one starts a lineage of its own.
- **A move copies:** its result starts a lineage of its own, whose faces are named through it ([07](07-poc-modelling-ui.md#the-reference-syntax)), and the copied version goes on.
- **A combine merges lineages:** its target's lineage continues, its tools' lineages end there, as Fusion's Combine consumes tool bodies. There is no "Keep Tools": nothing is ever destroyed, so a later feature can use a tool's version again, which forks it.
- **Custom Script code that uses a version** carries it on into the first version the code declares, as M3's `let body = upright` does, or else ends its lineage. A feature's continuation wins over one in code, which may only refer to the version.
- **A lineage is named by its first body version** (`plate`, not `sketch1`), so its name stays when features are added; a lineage without one, a sketch's, by the sketch. Renaming a body renames that variable.
- **A returned version that a later feature continues is a body of its own:** `return [plate, chamfer1]` with `chamfer1` continuing `plate` returns two bodies, as the code keeps `plate` as it was. It goes to the return on a lane of its own, is named, hovered and hidden by itself, and the lineage it leaves takes the name of its first body version that isn't returned by itself (`extrude1`).

## Visibility

What a user sees is view state, like the timeline marker ([07](07-poc-modelling-ui.md#the-timeline-marker)): hiding a body to look inside the model changes neither the model nor what a collaborator sees, unlike Onshape's shared hiding.

- **The view shows what exists at the marker,** which is what the browser lists: before the return, every body and sketch that no feature has used, and every returned version from where it is made (the workshop's view); past it, at the end, what main returns (a caller's view, and the viewer tool's). While a field is picked, what the open feature works on exists, too, also a version that an earlier feature consumed, which it branches from. The build drops a body from what it shows once a feature consumes it, though its variable keeps it as it was; such a body comes from the last build, meshed on demand. So a private leaf, one that nothing uses or returns, shows as soon as the marker is before the return, and no other default is needed.
- **Each user hides bodies** with the eyes in the [browser](#the-browser). Hidden bodies are stored with the marker in the account's tool storage ([10](10-view-state.md#storage)) as `visibility: { "body:plate": false, "version:joined": false }`: a lineage by its name, a version that is a body of its own by the version's. A lineage's name follows the code's structure, so a change that renames it, e.g. returning its first version by itself, shows it again. Renaming a variable in the timeline moves its keys.
- **Presence wins over hiding:** what a collaborator hovers or selects in a body this user hid shows as a ghost (`createPeerHighlights` resolves it against the hidden bodies, too).
- **Peeking already works:** hovering an entry whose result isn't shown draws that result ([12](12-hover-highlighting.md#design)), and hovering a hidden body in the browser draws it as a ghost, meshed by the worker on demand (`result`), once per build.
- **Isolate**, per user, comes later.

## Output

A model is a function, and `return` is its public interface: a caller (`body(() => model.default(…))`, [11](11-adopting-shapes.md#body)) gets what it lists. Every other version is private.

- **Heads are returned by default.** A new feature's result takes its input's place in the return ([07](07-poc-modelling-ui.md#the-editor)), a combine's tools leave it, and deleting a combine brings its tools back. A head that nothing uses or returns is useless to a caller, so the timeline greys it out; it still shows before the return.
- **Any version can be returned,** also a consumed one, e.g. a tool body before the cut.
- **The [return entry](#the-timeline-with-lanes)'s dialog edits it,** and nothing else does: visibility is the browser's, output the return's. It has a chip per returned name, in the return's order, removed with ×, and a "Select" button that picks any body or sketch, in the view, the browser or the timeline, also consumed versions; picking a returned one takes it out. It edits the return only while that is a name or a list of names (`returnEditable`); otherwise the dialog shows the return's code as its only chip, and "Select" is disabled.
- **Which versions are returned shows in the lanes:** a lane that goes to the return ends in a port, a half disc on its flat side, filled when returned, hollow for a private leaf. It is neither an eye nor an arrow, which reads as a modelling command (extrude, revolve). The browser doesn't repeat it.

## Availability

Code can use any earlier variable, so the UI ranks versions instead of restricting them. The leaves at the marker are listed in the browser; consumed versions are history, reachable in two ways:

- by rolling the marker back to where the version is a head, and
- by picking its timeline entry while a body, target, tools or sketch field is active.

Body and sketch fields have no dropdown. A field shows its value as a chip and a "Select body" button; while it is active, the view rolls back to before the open feature, as for picking faces, and so does the browser. A click on a body in the view, on a row in the browser or on a timeline entry before the open feature fills it; entries that can't fill it fade, private ones that can don't, and only what the field holds has the accent border. Hovering any of them shows only what a click would pick: the whole body, as a ghost where it doesn't show, and its lane; not the face or edge under the pointer, nor what the hovered feature changed, nor dependencies, nor anything collaborators would see. A tools field toggles bodies; a body can't be a combine's target and tool at once. A new combine targets the body a fillet would, and starts picking its tools. An extrusion that starts to join or cut targets the body its sketch lies on, as in Fusion, or else starts picking the target.

A fillet's, a chamfer's or a sketch's body is no field: its edges or its plane decide it (`from` in the [schema](../src/features/src/schema.ts)). The body field only chose which version the feature works on, since an edge's name lives on through a lineage's versions; the pick, made in the view rolled back to before the feature, the timeline position and [Join or Branch](#inserting-into-a-chain-or-branching) already decide that, and another body's edges don't resolve. So:

- **The picks decide the body,** one per feature. A first pick on another body than the one it was inserted on moves the feature there as if it had been inserted there (`rebody`): its old body gets back its place in the result and in the chain it joined, and it joins the new body's chain. The dialog only says which, `Chamfer chamfer1 on extrude1`; hovering that hovers its lineage. A fillet across bodies would need `body: [a, b]` or a feature per body, and isn't offered.
- **Once a fillet or chamfer has edges, only its body's can be picked** (`boundBody`): the other bodies turn see-through and neither hover nor take clicks. Removing its last edge frees it again; a new one, with no edges yet, keeps the last body in the code until its first pick. A sketch's plane is one face, so each pick decides its body anew; a sketch on an origin plane has none.
- **Binding goes by the body the feature got in the last build** (`inputs` in its trace), not by the code: a variable that Custom Script code reassigns, like M3's `body`, names another body than the picks do. A body that is an expression shows as its code.

### Inserting into a chain or branching

A new feature goes in at the marker and joins the chain it works on: with the marker between `bore` and `fillet1`, a chamfer on `bore` makes one body, chamfered and filleted, because `fillet1` is rewired to it (`insertFeatureAt`, as Fusion does). That is the default, for a step that was forgotten or belongs earlier:

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

The dialog of a feature with an input body has a "Chain" control, Join or Branch, whenever a feature after it continues its input or its result (`chainMode`). Branching rewires the later features that work on its result to its input, and returns its result; joining does the opposite (`setChainMode`). A move's copy and a sketch have no chain to join. Picking a consumed version as a field's value is always a branch.

## The timeline with lanes

The timeline stays a view of the code: its x-axis is the order of statements, one entry per position. Beneath the entries, each lineage is a lane, as in `git log --graph`: a dot per version (hollow for a sketch), links where lanes fork (solid), copy (dashed), merge and go to the return (dotted).

- **Lanes are thin:** 7 px apart. Each position has one entry only, so lanes needn't be as tall as an entry, and a lane's row is reused once its lineage has ended, also in the next column: a lane ends in a merge's bend or a port, so the next one in its row doesn't read as its continuation. The height is that of the most lineages alive at once.
- **The layout shows the code's order:** whether it groups the features of a body or interleaves unrelated ones.
- **One marker spans all lanes,** whose line continues through them. It is still a position in the code, so rolling back and inserting stay as they are; moved before a merge, the merged lanes come apart. It can also stand on either side of the return: before it, the view shows every leaf; past it, at the end, where new models, ⏭ and End put it, what main returns. New features go before the return from both. Past it, lanes fade and dash as the entries do, and a fork, copy or output that starts a lane past it fades as a whole, since it doesn't exist yet. Markers per lineage would roll back something other than a prefix of the code, which is looking at old versions (peeking does that), and would leave no single place for a new feature.
- **The return is the last entry.** A lane that reaches it ends in a filled port beneath it; one that ends at a merge was consumed; an open head that main doesn't return ends in a hollow port. A returned version inside a lineage goes to the return on a lane of its own. With the marker before the return, the return entry, its ports and the links to it fade, and the code pane greys the return statement. Hovering it highlights what main returns, bodies and sketches, and their lanes; it shows as hovered and underlines the return statement as a feature does, without dependencies. Its dialog edits what main returns ([Output](#output)).
- **Hovering has one source,** a feature or a lineage, and everything else follows from it:
  - A feature, hovered by its entry, its node, its code or a face it made in the view, highlights the lanes it writes into or ends in, drawn over the others, and its bodies' rows in the browser.
  - A lineage, hovered by its row in the browser or its lane, highlights its lane, its body in the view and its row. The feature a click there opens shows as hovered, its code underlined, but without its dependencies. Its other features, and the one it merges into, get a tint of the lane's colour; fading is taken, by the marker and by picking. While a field is picked, only what a click would pick shows.
- **Nodes mirror their entries:** an entry's outline (hovered, open) is a ring around its nodes, its border's colour (status, dependency, picked) theirs, its background the ring's fill, and it fades with them; the return's ports mirror the return entry.
- **Nodes and lanes are targets,** for the pointer only, as the entries, the return entry and the browser rows are for the keyboard. Rows are too close to aim at, so the pointer goes to the nearest row: within 8 px of a node, that's the node's entry, and a click there selects it, or picks that node's version, e.g. one side of a fork; elsewhere on a lane, the lineage, and a click opens or picks the version of that segment.
- **Node positions aren't stored.** A Grasshopper-like graph needs them: in the model they aren't portable ([02](02-model-storage.md#design-goal-portable-models)), in view state each user's layout differs. It also has no order for the marker, and large graphs tangle. A free graph could be a separate tool on the same model later.

## The browser

A pane left of the 3D view, toggled in the toolbar (open by default, per user), listing what exists at the marker, or before the open feature while a field is picked: the bodies with their version there (`plate notched`) and the sketches that no feature used yet; past the return, the returned versions, in the return's order. A label at its top says which ("Returned", "Before the return", "At the timeline marker", "Before joined"). Each row has an eye and the name, nothing else. Hovering a row hovers its lineage ([The timeline with lanes](#the-timeline-with-lanes)): the body, as a ghost if it doesn't show, its lane and its features; clicking it opens its version's dialog, or picks it. Construction geometry would go into folders of its own.

## Combine

`combine({ target, tools: […], operation: "join" | "cut" | "intersect" })` applies one boolean per tool, in order, with OCCT's `BRepAlgoAPI_Fuse`, `_Cut` or `_Common`, and names faces from both inputs' histories, so references into the result name a tool's faces, too. It fails alone without tools, with its target among its tools, or when the result is empty, e.g. an intersection of bodies that don't touch; it then passes its target through. Hovering it shows what changed in its target: `changedVolume` compares a result with a feature's first input only.

## Open

- Which use of a forked version continues its lineage and keeps its name. The longest chain fails right after inserting a branch at a rolled-back marker: the branch and the chain's continuation both have one version, and the branch, earlier in the code, takes the lineage and its name. And while a feature that branches from history is picked, the browser lists the version it branches from next to the lineage that continued it, both with its name (`plate` and `plate extrude1`).
- Named outputs (`return { bracket, mountingPlate }`), together with `body()`'s arrays ([11](11-adopting-shapes.md#body)), and names of bodies independent of features.
- The lanes of large models: many crossing links, and lanes too thin to hover or click.
- A sketch can't be picked in the 3D view, only in the browser and the timeline.
