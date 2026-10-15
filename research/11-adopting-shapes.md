# Adopting Shapes

How plain replicad code and the feature library work together: a shape made with replicad becomes a body that features can use, that the timeline shows and that the marker rolls back. Design only; nothing of it is implemented yet. Touch input is deferred ([touch](#touch)).

## The problem

The feature library and the editor only know values that are instances of the library's `Body`, a replicad shape with a naming history (`Topo`) that references like `extrude1.side.front` resolve against ([07](07-poc-modelling-ui.md#the-feature-library)). Shapes made with replicad have no history, so the library can't name their faces and edges. Two symptoms, with a model that mixes both:

```js
const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
const extrude1 = extrude({ sketch: sketch1, distance: 20, operation: "new" });
const other_plate = drawRoundedRectangle(depth, width, 6).sketchOnPlane().extrude(-height);
return [cut_plate, extrude1, other_plate];
```

- **A shape is not a target.** `extrude({ …, operation: "join", target: cut_plate })` fails the whole build with "a join needs a target body": [`features.ts`](../src/features/src/features.ts) checks `target instanceof Body`. The failing extrude has no input body to pass through, so even a lenient build stops.
- **Rollback shows only library bodies.** The editor shows the state at the timeline marker with the `before` list of the first feature after the marker, the library's live bodies ([07](07-poc-modelling-ui.md#the-timeline-marker)). With the marker before `extrude1`, that list is empty although `cut_plate` exists, so nothing shows. With the marker before the last Custom Script, no feature runs after the marker, and the editor shows the whole model, `other_plate` included.

## Options

- **A. Explicit adoption:** a library function `body(…)` turns shapes into bodies; a timeline entry with a name.
- **B. Implicit adoption:** features accept shapes wherever they expect a body and wrap them. No friction, but references into a shape would look like history-based ones while being weaker, and nothing says why.
- **C. Rollback by truncated evaluation:** evaluate `main` up to the marker and show the top-level shapes that no later entry before the marker uses. Fixes both visibility symptoms without changing models, but "used later" only guesses "consumed".
- **D. Tracking replicad at runtime:** wrap replicad's shape-producing methods in the worker to record results and consumed operands. Fragile across replicad versions, and consumption is still a guess.
- **E. Visibility as UI state:** eye toggles per body, as in Fusion's browser. Complements any of the above.

**Decision: A, with B's error message.** `instanceof Body` checks name the fix: "target: cut_plate is a replicad shape, not a feature body; wrap it with body(…)".

## `body()`

```js
const cut_plate = body(() => {
  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
  return plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
});
const [left, right] = body(() => [a, b]);
const imported = body(shape);
```

- **One function, the same convention as `main`:** the closure (or a bare shape, or an array of them) returns one shape or an array of shapes, and `body` returns one body or an array of bodies. Several bodies are destructured into top-level names.
- **Composition:** a model's `main` is such a function, so `const [base, lid] = body(() => box.default(box.defaultParams))` brings another model's bodies in (imports: [02](02-model-storage.md#verdict-imports-in-code)).
- **A black box:** the closure is opaque code. Its intermediates (`plate`, `bore`) stay local, so only the adopted bodies are top-level names, and the question of what replicad code consumed doesn't arise. Renaming a body is renaming its name in the declaration.
- **A feature like the others:** it registers its bodies as live, so rollback shows them ([07](07-poc-modelling-ui.md#the-timeline-marker)); it is traced with its status and time; and an exception in the closure fails this entry, which has nothing to pass through, instead of the whole build. Being a function, the closure can later be skipped when it is rolled back.
- **Names are geometric.** An adopted body has no history, so references to its faces and edges use the geometric hint (`cut_plate.face({ near: […] })`), the weakest strategy of the naming benchmark ([03](03-topological-naming.md)). The code shows where it applies.
- **Timeline:** one entry per `body()` statement, with its names (`◆ left, right`): the bodies are made at once. Each body starts its own chain of bodies ([07](07-poc-modelling-ui.md#reordering)), and body choices in forms list them separately. [`timeline.ts`](../src/cad/src/model/timeline.ts) must accept a destructuring `const` as a feature entry; [`deps.ts`](../src/cad/src/model/deps.ts) already handles declarations of several names and the free identifiers of closures.
- **No dialog:** the code can't be edited in a form. Selecting the entry opens the code pane at the closure, as for a Custom Script; its status is in the entry's title and the status bar; rename and delete are in the [context menu](#context-menu).

### Wrap in `body()`

An editor action that turns a Custom Script into a `body()` entry. The deps graph knows which names the script declares and which of them later entries use: when exactly one shape (or a list of them) escapes, the rest moves into the closure, and the escaping names become the declaration. Unwrap is the inverse. The action is offered in two places:

- the context menu of a Custom Script entry, and
- the error that needs it: "target: cut_plate is a replicad shape …" carries a "Wrap cut_plate in body()" button.

## Context menu

Timeline entries get a context menu: roll back to here, edit, edit code, rename, delete, wrap in `body()` / unwrap. NN/g's guidelines for it:

- **Secondary actions only.** "Hide actions that are not primary but that are used enough that they need to be accessible"; don't hide "essential, high-frequency actions behind an extra tap or click" ([10 guidelines](https://www.nngroup.com/articles/contextual-menus-guidelines/)). Selecting an entry therefore opens it (a feature's dialog, the code of a script or `body()`), on every device, and the menu holds the rest.
- **A visible trigger.** Gestures "are not discoverable and have still not become standard"; the menu's options should be "the same, regardless of how users interact with the system to reveal these menus" ([Contextual menus](https://www.nngroup.com/articles/contextual-menus/)). A ⋯ button, "visible without hover when possible" and "directly within or beside the object it controls" ([10 guidelines](https://www.nngroup.com/articles/contextual-menus-guidelines/)), opens the same menu as right-click. Timeline entries are too small for one each, so it is shown on the open entry.
- **No mouse-only paths.** "Do not use mouse-specific functionality (e.g., hover states, right button clicks)" as the only way ([Split buttons](https://www.nngroup.com/articles/split-buttons-navigation/)); every command should also be available outside the menu ([Contextual menus](https://www.nngroup.com/articles/contextual-menus/)): delete and rename in the dialog and as keys (Delete, F2), roll back by dragging the marker.
- **Keyboard and screen readers:** menus must "be opened and navigated using keyboard shortcuts" and be "fully readable and actionable via screen readers" ([10 guidelines](https://www.nngroup.com/articles/contextual-menus-guidelines/)): the context-menu key and Shift+F10.

## Touch

Deferred: the PoC targets mouse and keyboard, but no pattern should only work on a desktop. Known for later:

- Touch has no hover and needs targets of about 1 cm × 1 cm ([Mouse vs. fingers](https://www.nngroup.com/articles/mouse-vs-fingers-input-device/)); hover highlights need another trigger.
- Long-press opens the context menu.
- Dragging entries competes with scrolling the timeline. Entries set no `touch-action`, so a horizontal drag presumably scrolls instead (untested). As on iOS, a long-press could lift an entry, showing the menu while it is held and starting a drag once the finger moves.

## Open

- Whether `body()` keeps the naming history of values that already are library bodies, e.g. those of an imported model, with prefixed names, instead of treating them as geometry only.
- Rollback still shows the whole model when no feature runs after the marker, e.g. before a Custom Script that isn't wrapped in `body()`.
- Scalar calculations stay Custom Scripts; a parameter view like Fusion's user parameters would suit them better than timeline entries.
