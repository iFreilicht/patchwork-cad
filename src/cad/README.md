# CAD Model tool (PoC 1)

> [!CAUTION]
> Model code runs **unsandboxed**, with the full authority of the Patchwork page. Use this tool only on the local stack (`pnpm dev`) and only with your own models. Never open shared documents with it and never install it on the public Patchwork instance. Sandboxing is [research/05](../../research/05-sandboxing.md).

A Patchwork datatype `cad-model` and two tools for it. The document holds a model as code; every tool that shows it re-runs it on every change. Design and measurements: [research/06](../../research/06-poc-replicad-in-patchwork.md) (PoC 1) and [research/07](../../research/07-poc-modelling-ui.md) (PoC 2).

| Tool id | |
|---|---|
| `cad-model` | Fusion-like editor: toolbar, timeline, feature forms, picking faces and edges, and a code pane (the default) |
| `cad-model-viewer` | the 3D view alone, for embedding |

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

`main` returns a shape or body, an array of them, or `{ shape, name, color }` entries ([replicad-evaluator](https://github.com/sgenoud/replicad/tree/main/packages/replicad-evaluator) conventions). Only `replicad`, `replicad/shape-functions` and `@patchwork-cad/features` can be imported. The editor recognizes `const x = feature({…})` statements of `main` as timeline entries; everything else is a Custom Script.

## Layout

- `src/index.ts`: plugin metadata only (it is parsed in a worker by the host)
- `src/datatype.ts`: `{ title, source }` and the seed model
- `src/tools/`: one mount function per tool
- `src/kernel/`: the OCCT worker (`worker.ts`), its main-thread facade (`engine.ts`) and the source preparation (`prepare.ts`), which also names features in memory
- `src/model/`: reading the source (`analyze.ts`, `timeline.ts`) and editing it with minimal splices (`splice.ts`)
- `src/components/`: the shared model (`createModel.ts`), code editor, 3D view and status bar; `editor/` holds the WYSIWYG editor
