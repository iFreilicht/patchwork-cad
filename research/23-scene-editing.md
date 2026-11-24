# Editing Models in a Scene

A CAD model placed in a [scene](https://github.com/inkandswitch/patchwork-experiments/tree/scene-stage/scene) is built as its content and edited where it stands ([src/cad/README.md](../src/cad/README.md#in-a-scene)). Editing there falls short of the editor's own view in many ways. This document lists every gap and what we decided to do about it. Live documents on canvases ([22](22-document-canvases.md)) are left out: they need more research and possibly changes to Patchwork. Status: in progress, see [Plan](#plan). Scene references are to [`288280e7`](https://github.com/inkandswitch/patchwork-experiments/tree/288280e74dbee3ec63c8747317dedcbf7733042f/scene) of `scene-stage`; the tests run against the scene with this document's scene changes (the submodule, [Plan](#plan)).

## How editing in a scene works

The scene owns the renderer, the camera, picking and input. A model's Open ([`editTool.tsx`](../src/cad/src/scene/editTool.tsx)) mounts the whole editor (`WysiwygEditor`) into the scene's overlay, with [`sceneViewer.ts`](../src/cad/src/scene/sceneViewer.ts) in place of the editor's [`Viewer.tsx`](../src/cad/src/components/Viewer.tsx). `sceneViewer` renders no DOM: it draws the editor's `ViewerProps` into a group of the scene's world with the scene's three.js, and raycasts that group itself for the pointer events the scene hands to it ("Hands", [STAGE.md](https://github.com/inkandswitch/patchwork-experiments/blob/288280e74dbee3ec63c8747317dedcbf7733042f/scene/STAGE.md#the-input-chain)). Every prop it doesn't implement is silently ignored. Its header says so for the camera:

> the scene keeps the camera, so the view's camera props (view, home, ViewCube, faceRefs) mean nothing here.

A view plugin has the scene's camera nevertheless ([STAGE.md](https://github.com/inkandswitch/patchwork-experiments/blob/288280e74dbee3ec63c8747317dedcbf7733042f/scene/STAGE.md#view-plugins)):

> `camera` | `{ get, set, frame(box), hold, ride, touched, watch, onEnd }`

## Gaps and decisions

**Fix**: to be done. **Later**: wanted, not now. **Accepted**: the difference stays. **Intended**: the difference is right. A gap marked *scene* needs a change to the scene, sent to pvh's branch ([Plan](#plan)).

### Camera

| # | Gap | Decision |
|---|---|---|
| A1 | The `view` prop is ignored: choosing a named view doesn't move the camera. | Done: [`sceneCamera.ts`](../src/cad/src/scene/sceneCamera.ts) moves the scene's camera, through the object's frame, as `Viewer.tsx` moves its own; the scene keeps its lens, so a view is fitted by the distance and its `eye` isn't kept. Views fit the part of the port the editor's panels leave free, as `Viewer.tsx`'s canvas |
| A2 | `ViewerApi.camera()` is undefined: a view can't be made or updated from the camera, and the browser marks no view as current. | Done: read from the scene's camera, in that part |
| A3 | `home()` and `homeCamera()` do nothing. | Done |
| A4 | Fits to the model's margins and close-ups ([20](20-view-framing.md)) are neither shown nor saved. | Done |
| A5 | The scene's camera is perspective only; its one orthographic camera is the axes triad's ([`axes.js`](https://github.com/inkandswitch/patchwork-experiments/blob/288280e74dbee3ec63c8747317dedcbf7733042f/scene/src/parts/axes.js)). | Later, *scene* |
| A6 | No ViewCube, Home or projection buttons. | Done ([`sceneViewCube.ts`](../src/cad/src/scene/sceneViewCube.ts)), on a canvas of its own; its projection button is disabled until A5 |
| A7 | A user's camera in a scene isn't kept per user, and the editor doesn't open at the one kept from its own view. | Intended: the scene keeps the camera |

### Look

| # | Gap | Decision |
|---|---|---|
| B1 | Every line is 1 px (`LineBasicMaterial`): edges, highlighted edges, sketches, overlays; no halos ([14](14-edge-contrast.md)). The scene draws wide lines itself (`LineMaterial`, `LineSegments2` in [`viewport.js`](https://github.com/inkandswitch/patchwork-experiments/blob/288280e74dbee3ec63c8747317dedcbf7733042f/scene/src/stage/viewport.js)) but doesn't give them to plugins, and ours are made with another copy of three.js, which the scene's renderer can't draw. | Done with a copy ([`wideLines.js`](../src/cad/src/scene/wideLines.js)), as of `glb.js`; then *scene*: expose them, and drop the copy |
| B2 | Fixed colours instead of the theme's `--cad-model-*`: no dark mode; overlays orange. | Done: Viewer.tsx's materials, from the theme where the editor is |
| B3 | A hovered face has no outline, a hovered selected edge no ring, ghosts no thin edges; face opacities differ. | Done, as in Viewer.tsx |
| B4 | Bodies faded while picking keep their edges. | Done |
| B5 | The scene's lights, not the key light that follows the camera. | Accepted |
| B6 | The live build's grey differs from the built GLB's colour, which the scene's theme gives it. | Intended: opening the editor visibly changes the mode |
| B7 | `prefers-contrast: more` doesn't widen lines. | Done, with B1 |

### Selecting and picking

| # | Gap | Decision |
|---|---|---|
| C1 | The selected face or edge isn't highlighted: `Viewer.tsx` draws its own selection, `sceneViewer` only reports it. | Done |
| C2 | `regions` is ignored: no picking of sketch regions, e.g. profiles to extrude ([21](21-embedding.md)). | Done |
| C3 | A right click off the model opens the scene's menu, not the editor's. | Intended |
| C4 | Picking tests every triangle in JS, without bounds or a BVH. | Done: boxes of every face and edge group ([`picking.ts`](../src/cad/src/scene/picking.ts)), checked against testing everything (`test/picking.test.ts`) |
| C5 | Documents can't be dropped on faces or into the view, not even from the browser's Documents. | Done: drags over the view reach the scene, not the editor, whose elements there let the pointer through; with a host's view the editor takes those over its stage cell before the scene does |

### Collaboration

| # | Gap | Decision |
|---|---|---|
| D1 | No pins of comments and annotations. | Done |
| D2 | No markers of collaborators' pointers; their highlights show. | Done: dots and names on the model, beside the scene's own presence (its people and their bodies, `scene.others`' selection boxes) |

### Tests

| # | Gap | Decision |
|---|---|---|
| E1 | The e2e harness doesn't run the scene, and `sceneViewer` has no `ViewerTestHook`. | Done: the scene is a submodule ([harness](../src/harness/README.md)); `sceneViewer`'s element carries the hook's `entities`, `screenPoint`, `highlighted` and `centroid` ([`cad-scene.spec.ts`](../src/harness/e2e/tests/cad-scene.spec.ts)) |

### The scene source

| # | Gap | Decision |
|---|---|---|
| F1 | A model is built with its default parameters: a scene can't show a configuration. A source's parameters are its plugin metadata, the same for every document ([README](https://github.com/inkandswitch/patchwork-experiments/blob/288280e74dbee3ec63c8747317dedcbf7733042f/scene/README.md): "every field but `load` must survive `structuredClone`"). | Done: the scene's `params(doc)` (its branch `scene/glb-textures`); a placed model is built with one of its configurations, chosen in the inspector's Settings, its linked values read as they are |
| F2 | A built GLB's edges are drawn 1 px wide too. | Fix, *scene*: wide lines opt-in per primitive, so that other sources' GLBs stay as they are |

### Canvases

Image canvases ([21](21-embedding.md)) are images on planes: PNG, JPEG and SVG files, draw.io's SVG exports among them.

| # | Gap | Decision |
|---|---|---|
| G1 | The built GLB has no canvases. | Done: the scene's `glb.js` v5 (its branch `scene/glb-textures`); [`canvasGlb.ts`](../src/cad/src/scene/canvasGlb.ts) reads each image at its version, draws an SVG as the editor does and places it as the editor does, on a face the build locates; a drawing's material says it was drawn for a light background, so a dark scene recolours it |
| G2 | `sceneViewer` ignores `canvases` and `canvasPick`: no canvases while editing, and no Calibrate. | Done |

Two differences stay. A canvas's eye is per user in the editor ([21](21-embedding.md)), while a scene's layers are the object's, the same for everyone. A canvas drawn through the model is hidden behind it in the GLB, which can't draw through; while editing, `sceneViewer` draws it through.

### Left out

Live documents on canvases (`ShownCanvas.document`) and editing them in place (`editing`, `onEditCamera`). A GLB could only hold a still of them, and a texture doesn't work for them in the view either ([22](22-document-canvases.md)).

## Plan

The e2e harness gets the scene as a git submodule of a fork of `patchwork-experiments`, pinned to the commit under test. The *scene* changes go on a branch of that fork, based on a commit of `scene-stage` and rebased onto its latest before they are sent. The CAD side is committed on `scene-source`.

1. E1, so that every later fix is tested in the scene.
2. The other gaps without *scene*, one commit each.
3. The *scene* changes, one commit each, each with the commit here that uses it: B1, F1, F2. A5 later.
