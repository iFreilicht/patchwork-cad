# CAD Model tool (PoC 1)

> [!CAUTION]
> Model code runs **unsandboxed**, with the full authority of the Patchwork page. Use this tool only on the local stack (`pnpm dev`) and only with your own models. Never open shared documents with it and never install it on the public Patchwork instance. Sandboxing is [research/05](../../research/05-sandboxing.md).

A Patchwork datatype `cad-model`, an unlisted `cad-model-embed` (a model seen from one of its named views, [research/18](../../research/18-named-views.md)), and two tools for them. The document holds a model as code; every tool that shows it re-runs it on every change. Design and measurements: [research/06](../../research/06-poc-replicad-in-patchwork.md) (PoC 1) and [research/07](../../research/07-poc-modelling-ui.md) (PoC 2).

| Tool id | |
|---|---|
| `cad-model` | Fusion-like editor: toolbar, timeline, feature forms, picking faces and edges, and a code pane (the default) |
| `cad-model-viewer` | the 3D view alone, for embedding, and the tool of embeds |

## Usage

```sh
nix develop
pnpm install
pnpm dev        # from the repo root: builds and serves everything, prints the URL
```

Create a "CAD Model" from the create-new menu, and switch tools with "Open with…" (or `&tool=<id>` in the URL). Edits rebuild the tool in `dist/` within about a second; reload the page to load the new build. `pnpm test` runs the source-editing tests.

## Models

A model is a plain ES module that runs with replicad and the [feature library](../features/) alone, inside or outside this tool:

```js
import { sketch, plane, rect, extrude } from "@patchwork-cad/features";

export const defaultParams = { size: 20 };

export default function main({ size }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [size, size] }) });
  return extrude({ sketch: sketch1, distance: 30 });
}
```

`main` returns a shape or body, an array of them, or `{ shape, name, color }` entries ([replicad-evaluator](https://github.com/sgenoud/replicad/tree/main/packages/replicad-evaluator) conventions). Only `replicad`, `replicad/shape-functions`, `@patchwork-cad/features` and documents (`automerge:` URLs of data documents, JS files and any file `with { type: "text" }` or `with { type: "bytes" }`, see [research/02](../../research/02-model-storage.md#imports-in-the-prototype)) can be imported; the editor lists them in its browser, with a dialog each, and holds back a newer version of a followed one that breaks the model ([research/21](../../research/21-embedding.md#the-documents-list)). A document dragged from Patchwork's sidebar, pasted, or given to "Insert" is imported, or one of its values fills a number field ([research/21](../../research/21-embedding.md#dropping-pasting-inserting)). The editor recognizes `const x = feature({…})` statements of `main` as timeline entries; everything else is a Custom Script.

`main` takes its parameters from `defaultParams`; `const`s at its start that only compute values are derived parameters, and an optional `export const paramConfig = { w: { title, minimum, maximum, unit } }` describes them in JSON Schema's terms ([research/17](../../research/17-parameters.md)). The editor's first timeline entry, "params", edits them; configurations (named sets of values), named views and the locks of followed documents are kept in the model document next to the code.

## In a scene

The package also registers a `scene:source`, `cad-model-scene`, for [patchwork-experiments' scene](https://github.com/inkandswitch/patchwork-experiments/tree/scene-stage/scene) (its README, "Writing a provider"): a model dropped or pasted into a scene is built with its defaults or one of its configurations, chosen in the scene's inspector (`params(doc)`), with the documents it follows at their locks (the versions the editor last built with), into a GLB in the scene's frame (Y up, metres; models are Z up, millimetres). Each shape is a node and a layer named by `main`'s return key, so the scene shows and hides bodies; edges are dark lines, and sketches `main` returns are lines on a "Sketches" layer. Each image canvas is a picture on a layer of its own (`src/scene/canvasGlb.ts`); live documents on canvases aren't in it. The scene builds again when the code, the locks, the configurations, the canvases or a followed document without a lock changes, not on a title or the editor's views or annotations. A failed build keeps the last geometry and the render says why. Every model in a page shares one kernel worker, one build at a time, released after a minute idle. The caution above holds here too: a scene runs the code of every model in it.

A model is also edited where it stands: its **Open** (the scene's Open convention: the inspector's button, the object's menu, a double-click or Enter, while the scene is in Edit) is a `scene:view`, `cad-model-scene-edit` (`src/scene/editTool.tsx`). It puts a hand on the scene's stack, hides the object's built GLB from this viewer, and draws the editor's own live build in its place (`src/scene/sceneViewer.ts`, an implementation of `ViewerProps` with the scene's three.js, raycasting the meshes itself for faces and edges). The editor's panels lie over the scene's view (`WysiwygEditor`'s `viewer` prop, `.cad-model--over-host`), drawn as the editor's own view draws (wide lines, the theme's colours, its selection). Its views, Home and ViewCube move the scene's camera, and a view is made from it (`src/scene/sceneCamera.ts`, `sceneViewCube.ts`); the editor neither keeps that camera per user nor opens at its own. Escape first steps out of the editor's picking and selection, then puts the hand down. Undo is the scene's: the editor binds none of its own there, and every write goes through the scene's `edits` service (scene EDITOR.md, "Undo") as one step, without what this tool's undo ignores (`UNDO_IGNORE`: locks, comments). The gaps to the editor's own view, and what is done about each: [research/23](../../research/23-scene-editing.md).

## Layout

- `src/index.ts`: plugin metadata only (it is parsed in a worker by the host)
- `src/datatype.ts`: `{ title, content, mimeType, cad }` and the seed model; `src/embedDatatype.ts`: embeds
- `src/tools/`: one mount function per tool
- `src/kernel/`: the OCCT worker (`worker.ts`), its main-thread facade (`engine.ts`) and the source preparation (`prepare.ts`), which also names features in memory
- `src/model/`: reading the source (`analyze.ts`, `timeline.ts`, `documents.ts`) and editing it with minimal splices (`splice.ts`), and the locks of followed documents (`locks.ts`)
- `src/scene/`: the scene's content provider (`source.ts`), its shared kernel (`kernel.ts`) and the GLB of a build (`modelGlb.ts`, with the scene's encoder `glb.js`, copied whole, and the canvases' pictures, `canvasGlb.ts`); editing in a scene (`editTool.tsx`, `sceneViewer.ts`)
- `src/components/`: the shared model (`createModel.ts`), code editor, 3D view and status bar, and reading drags and pastes of documents (`dnd.ts`); `editor/` holds the WYSIWYG editor
