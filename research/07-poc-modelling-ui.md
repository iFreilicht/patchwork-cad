# PoC 2: modelling UI

The second proof of concept: the Fusion-360-like experience on top of [PoC 1](06-poc-replicad-in-patchwork.md). It tests whether "the model is code, the timeline is a view" ([02](02-model-storage.md#the-timeline-is-a-view)) holds up in use.

## Scope

- **A feature library subset** defined with `defineFeature` ([feature types](02-model-storage.md#feature-types)): a sketch with simple segments, extrude, fillet, chamfer, and one boolean (extrude's operation). Enough for M1 and M3 of the [naming benchmark](03-topological-naming.md#setup).
- **The timeline editor:** parse the code text, show recognized feature calls as timeline entries and everything else as Custom Script entries. Editing a feature's parameters in a form splices only the changed argument's source span back into the text, and code and timeline edits merge live between two users.
- **Selection and references:** pick a face or edge in the 3D view to fill a reference parameter, written as a JS expression following [03's recommendation](03-topological-naming.md#recommendation) (S5), with broken references reported in the timeline.

Sketches are edited through forms with a 3D preview, not drawn. Out of scope: sandboxing (still unsandboxed and local, as in PoC 1, see [05](05-sandboxing.md)), sketch constraints, assemblies, imports of other models, user-defined features and the full feature set.

## Implementation

### The feature library

[src/features/](../src/features/) is the package `@patchwork-cad/features`, the thin library that model files import ([portable models](02-model-storage.md#design-goal-portable-models)):

```js
import { sketch, plane, rect, circle, extrude, fillet, chamfer, edge } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 20, a: 30, r: 8 };

export default function main({ w, d, h, a, r }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: h });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [a, 0], radius: r }) });
  const notch = extrude({ sketch: sketch2, operation: "cut", target: extrude1, extent: "through" });
  const fillet1 = fillet({ body: notch, edges: [edge(extrude1.end, notch.side.c)], radius: 1.5 });
  const chamfer1 = chamfer({ body: fillet1, edges: [edge(extrude1.end, extrude1.side.front).piece(notch, 1, { near: [49.75, 0, 20] })], distance: 1 });
  const sketch3 = sketch({ body: chamfer1, plane: extrude1.side.front.piece(notch, 2, { near: [49.501, 0, 9.499] }), profile: circle({ center: [w - 6, h / 2], radius: 2 }) });
  return extrude({ sketch: sketch3, distance: 4, operation: "join", target: chamfer1 });
}
```

- **Features** are `sketch`, `extrude` (operation `new`, `join` or `cut`; extent `distance` or `through`), `fillet` and `chamfer`. Their parameter schemas live in a kernel-free module ([`schema.ts`](../src/features/src/schema.ts)), so the editor renders forms without loading replicad. Profiles are `rect`, `circle` and `polygon`, whose segment ids (`front`, `c`, or the keys of a polygon) are the origin names of the swept faces, as 03 requires.
- **Naming** is ported from the benchmark prototype ([`topo.ts`](../src/features/src/topo.ts), [`refs.ts`](../src/features/src/refs.ts)). The operations call OCCT's builders directly, because replicad doesn't expose their history. A history name is a structured value whose canonical print is the reference expression, so picking an entity prints its names as code.
- **A body is returned as is.** replicad-evaluator treats any returned object with a `shape` as a `{ shape, name }` entry (`if (!inputShape.shape) return { shape: inputShape }`), so `return extrude2` works in the tool and without it.
- **Failures pass through:** in the tool's lenient builds, a feature with a broken reference or a kernel failure returns its input body, and the build goes on, as a failed feature does in a CAD timeline. Run directly, a failing feature throws.
- **Every call is traced:** name, line, status, its references' resolution with suggestions, the bodies visible before it, and its time.

The tool's [`prepare.ts`](../src/cad/src/kernel/prepare.ts) adds names in memory: `const extrude1 = extrude({…})` runs as `extrude({…}, { name: "extrude1", line: 9, variable: true })`, on the same line. A feature without its own `const` (in a loop, or reassigned) gets only its line; its fallback name is `extrude@L16#1`, or an explicit `{ name: \`rib${i}\` }`. Outside the tool, features are `extrude#1`, … and references still resolve, because they point to bodies within one evaluation ([portability test](../src/features/test/portability.test.ts)).

### Two tools

[src/cad](../src/cad/) registers two tools on the datatype `cad-model`. They share Solid components and one kernel worker per tool instance as modules, which is Patchwork's own rule for tools that share code ("When two tools want the same code: Make them one package", [AGENTS.md](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/AGENTS.md)). Tools share nothing but the document: `<patchwork-view tool-id="…">`, which other tools embed them with, only carries a document and a tool id, and a frame may arrange tools in any way ([research/09](09-patchwork-26-features.md#tiling-frame)). So the code editor is a pane of the editor, which keeps the error line and the edited feature's code in sync with the GUI, and only the viewer is a separate tool, for embedding and for several views of one model.

| Tool id | Name | What it is |
|---|---|---|
| `cad-model` | CAD Editor | The WYSIWYG editor: toolbar, 3D view with picking, timeline, feature dialogs, and the code editor on demand. It is the default because Patchwork opens a datatype's first listed tool by id (`@inkandswitch/patchwork-plugins`, `getFallbackTool`: `sortPlugins(plugins, "supportedDatatypes", type, "id")?.filter((tool) => !tool.unlisted)?.[0]`). |
| `cad-model-viewer` | CAD Viewer | The 3D view alone, for embedding a model, and the tool of view documents (`cad-model-view`, [10](10-view-state.md#view-documents)). |

### The editor

- **The timeline** ([`timeline.ts`](../src/cad/src/model/timeline.ts)) is derived from the source on every change with acorn ([`analyze.ts`](../src/cad/src/model/analyze.ts)): each `const x = feature({…})` statement of `main` is an entry, every run of other statements a Custom Script entry, and both are matched with the last build's trace.
- **Forms** are generated from the schemas. Scalars are expression fields (`w / 2`), bodies and sketches are choices of earlier variables, references are chips with their status and a "use suggestion" button, and a sketch has a plane and a profile form whose fields edit the nested arguments (`rect({ from: [0, 0], to: [w, d] })`).
- **Every GUI edit is a minimal splice** ([`splice.ts`](../src/cad/src/model/splice.ts)): a form edit replaces only the argument's span, a pick appends one array element, a new feature is inserted before `return`, which then returns the new body, and missing imports are added to the import line.
- **Picking:** while a reference is selected, the view rolls back to the bodies the feature works on, as Fusion's timeline does, and highlights what its references resolve to. A click asks the kernel worker for the entity's reference code. replicad's meshes identify faces and edges by `ReplicadShapeHasher.HashCode`, which maps them to the body's entities.
- **Deleting a feature** rewires the features that used its body to its input, and turns references that named it into `ref.<name>` lookups, which then report themselves as broken.
- **Unused results are marked.** A body that no later feature uses and `main` doesn't return is geometry the model drops, e.g. after a feature was retargeted to an earlier body, which branches the model. The timeline greys it out, and its dialog adds it to the result. When a form changes a feature's `body` or `target`, the body it no longer uses comes back into the result unless another feature uses it.

### The ViewCube

Both tools' 3D view ([`Viewer.tsx`](../src/cad/src/components/Viewer.tsx), [`ViewCube.ts`](../src/cad/src/components/ViewCube.ts)) has a translucent ViewCube in its top-right corner, with Home and a perspective/orthographic toggle in the free corners of its square; feature dialogs open top left, as in Onshape, so that the cube stays usable while picking. Z is up, Front looks along +Y, Right along −X and Top along −Z. A click on one of its 26 regions (6 faces, 12 edges, 8 corners) turns the camera to look from that region's direction (each axis −1, 0 or 1) around the orbit target; Home looks from front, right and above and frames the model. A model that outgrows the view is reframed along the camera's current direction, so an edit never turns the view. The e2e specs set views by clicking the cube ([`cad-viewcube.spec.ts`](../src/harness/e2e/tests/cad-viewcube.spec.ts)); they wait for the turn's end, which the view marks with `data-turning`. Dragging a region out creates a view document ([10](10-view-state.md#view-documents)).

## Results

The "done when" scenario is the spec [`cad-collab`](../src/harness/e2e/tests/cad-collab.spec.ts), which passes in Chromium, Firefox and WebKit, with [`cad-editor`](../src/harness/e2e/tests/cad-editor.spec.ts), [`cad-tools`](../src/harness/e2e/tests/cad-tools.spec.ts) and PoC 1's specs:

- User A builds M1 in the WYSIWYG editor while user B writes code in the editor's code pane. B writes the block and the notch. A adds the fillet, the chamfer, the sketch on the split front face and the boss through the toolbar, forms and picks, while B types above A's open dialog.
- B moves the notch and makes the block taller in code, and every reference still resolves. Then A deletes the notch: the fillet and the sketch report broken references, and the sketch's suggestion fixes it.
- For M3, B writes the base, the upright and the ribs in a loop. A picks the inner corner edge's pieces between the ribs, the top edge and the merged back face. The references survive moving the rib and adding a second one.

### Text vs. AST editing

**Read the AST, write text.** The editor parses with acorn and splices the argument's span. An experiment ([`merge.test.ts`](../src/cad/test/merge.test.ts)) changes a fillet radius from 1.5 to 2 three ways and merges each with a concurrent edit by another user:
- **splice:** the editor's way
- **recast:** reprints only the changed nodes, applied with `updateText`
- **astring:** prints the whole program from the AST, applied with `updateText`

| concurrent edit | splice | recast | astring |
|---|---|---|---|
| comment above, other argument of the call, comment in the call | ✓ | ✓ | ✓, but 60 other lines change and the file's comment is lost |
| another line reformatted | ✓ | ✓ | the reformatting is lost |
| the same argument (radius 3) | `23` | `32` | `2 3`, doesn't parse |

- **Splicing is as good as reprinting changed nodes,** without recast or a diff. Printing the whole program reformats the file, so it is ruled out.
- **Concurrent edits of the same argument still merge character by character** into a valid but wrong value (`23`). 02 accepts such conflicts as "visible and fixable", but nothing flags this one.

### Feature identity across re-parses

**An automerge cursor, with the variable name as a fallback.** The open dialog is anchored with `getCursor` at its call. `cad-tools` checks that it stays open on its feature while another user renames the variable everywhere or inserts a feature above it; a name-based identity would close on the rename. A cursor is lost when the whole text is replaced (assigning `source` instead of splicing, e.g. a tool rewriting the file; checked in `merge.test.ts`), so the dialog then falls back to the variable name, which `cad-tools` also checks.

The same spec found that identity is not only about the dialog. The form re-rendered its inputs after every build, because each re-parse creates new entry objects. Firefox dropped what the user was typing when a build finished; Chromium commits a removed input on blur. Inputs are now keyed by the feature type's parameters, and the spec checks that the input survives a build.

### The reference syntax

What the GUI writes for M1 and M3:

```js
edge(extrude1.end, notch.side.c)
edge(extrude1.end, extrude1.side.front).piece(notch, 1, { near: [49.75, 0, 20] })
edge(upright.side.back, upright.start).piece(ref.rib0, 1, { near: [46.5, 8, 8] })
any(base.side.front, upright.side.front)
```

- **Feature variables, with `ref.<name>` as a fallback.** Variables keep the file portable and make renames carry over. `ref.rib0` names features that have no variable, e.g. those an explicit `{ name }` names in a loop.
- **A deleted feature is a problem for references.** Deleting a feature in code makes every reference to it a `ReferenceError`, so the whole model fails, although a reference only names history. The editor's delete therefore rewrites them to `ref.notch`, which reports itself as broken with a suggestion, as the benchmark expects.
- **The geometric hint is one centroid.** S5's cross-check compared all sibling pieces' centroids at pick time. The code keeps only the picked piece's (`near`), and the check takes the piece nearest to it. Rerun through the library's code path ([`bench.test.ts`](../src/features/test/bench.test.ts)), M1 and M3 give the benchmark's S5 results: no reference silently wrong, and the same 8 of 54 cells reported.
- **Suggestions:**
  - 7 of the 8 reported cells come with a suggestion, all of them right; the prototype offered 5.
  - Merged faces carry no hint, so M3's ambiguous back face gets none.
  - When an entity is really gone ("notch to right end"), the nearest piece is still offered, and it is wrong. A suggestion must stay the user's choice.
- **Blends name more faces than they were asked for.** A chamfer or fillet propagates along tangent edges, and OCCT reports the faces this creates as `Generated` from the edges of the chain, not from the picked edge. M1's chamfer meets the notch's fillet that way. Naming now asks every input edge, and a test checks that every face and edge of M1 and M3 has a name ([`names.test.ts`](../src/features/test/names.test.ts)).

### Collapsed timelines

**A Custom Script entry lists the features the build ran inside it.** It matches trace entries by source line, so M3's rib loop shows `✎ sketch@L13#3` and `⬆ rib0`. That is where references into it come from: a pick on a rib prints `ref.rib0`. Features without a stable name can still be picked, but their fallback name depends on the source line, so a reference to them breaks when lines move. They should be named explicitly. A new fillet or chamfer from the toolbar works on what `main` returns, so it also builds on bodies a Custom Script made. Selecting a Custom Script entry opens the code editor at its lines.

### Rebuild performance

**A full re-run per edit is fast enough for these parts.** Medians of 10 builds, edit to mesh, measured with [`cad-measure-features`](../src/harness/e2e/tests/cad-measure-features.spec.ts) (`CAD_MEASURE=1`, one worker) on an Apple Silicon Mac; in brackets the part of the features' time spent on naming:

| ms | Chromium | Firefox | WebKit |
|---|---|---|---|
| M1, replicad only (PoC 1) | 29.5 | 120 | 44 |
| M1, library | 21.3 (3.5) | 80 (5) | 32 (5) |
| M3, library | 22.5 (5.9) | 79 (10) | 34 (9) |
| M3, library, 3 ribs | 41.2 (14.5) | 145 (26) | 57 (22) |

Naming grows fastest with the part's size, from 22 % (M1) to 40 % (M3 with 3 ribs) of the features' time in Chromium, because it matches entities pairwise with `IsSame`. That is the first thing to make faster, by matching through hash maps; per-feature caching isn't needed yet.

## Open

- **Bodies are versions, the timeline is an order.** Each feature result is a fixed version of a body, and `body:`/`target:` name a version, while references name a body's history (`plate.side.left`) and survive inserting features. Inserting a feature before a chamfer therefore means joining to the chamfer's input and making the chamfer use the result, a reorder by hand; targeting the earlier version instead branches the model. Fusion has one changing body per name and an insert position in the timeline. Whether the editor should insert at a position and relink the chain, whether `body:` should name a body's history, or whether models should reassign a variable, is a question of mental models, to be answered by implementing several and trying them with users.
- Concurrent edits of the same argument merge into a valid wrong value, unflagged.
- Fallback names of unnamed features in loops depend on source lines.
- The editor never shows a feature's own preview while its references are being picked, because the view is rolled back then.
- Expression scope ([02](02-model-storage.md#consequences)): forms accept any expression; nothing restricts the names it uses.
- User-defined features, whose schemas would have to be loaded in the sandbox ([02](02-model-storage.md#feature-types)).
