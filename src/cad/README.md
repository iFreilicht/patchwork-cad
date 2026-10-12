# CAD Model tool (PoC 1)

> [!CAUTION]
> Model code runs **unsandboxed**, with the full authority of the Patchwork page. Use this tool only on the local stack (`pnpm dev`) and only with your own models. Never open shared documents with it and never install it on the public Patchwork instance. Sandboxing is [research/05](../../research/05-sandboxing.md).

A Patchwork datatype and tool, both with the id `cad-model`. The document holds a replicad model as code; the tool shows it in a CodeMirror editor next to a 3D view and re-runs it on every change. Design and measurements: [research/06](../../research/06-poc-replicad-in-patchwork.md).

## Usage

```sh
nix develop
pnpm install
pnpm dev        # from the repo root: builds and serves everything, prints the URL
```

Create a "CAD Model" from the create-new menu. Edits rebuild the tool in `dist/` within about a second; reload the page to load the new build.

## Models

A model is a plain ES module that runs with replicad alone, inside or outside this tool:

```js
import { drawCircle } from "replicad";

export const defaultParams = { radius: 20 };

export default function main({ radius }) {
  return drawCircle(radius).sketchOnPlane().extrude(30);
}
```

`main` returns a shape, an array of shapes, or `{ shape, name, color }` entries ([replicad-evaluator](https://github.com/sgenoud/replicad/tree/main/packages/replicad-evaluator) conventions). Only `replicad` and `replicad/shape-functions` can be imported.

## Layout

- `src/index.ts`: plugin metadata only (it is parsed in a worker by the host)
- `src/datatype.ts`: `{ title, source }` and the seed model
- `src/kernel/`: the OCCT worker (`worker.ts`), its main-thread facade (`engine.ts`) and the source preparation (`prepare.ts`)
- `src/components/`: editor, 3D view and the tool's layout
