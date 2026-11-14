# draw.io diagrams

A Patchwork datatype `drawio` and its tool `drawio`: [draw.io](https://www.drawio.com)'s own editor on a diagram kept as a `.drawio.svg` file, an SVG of the diagram that carries the diagram in its root's `content` attribute. Any viewer shows the picture; draw.io opens the diagram. A CAD model shows one on a canvas as the SVG it is, and follows its saves ([research/21](../../research/21-embedding.md#canvas)).

## Usage

```sh
nix develop
pnpm install
pnpm dev        # from the repo root: builds and serves the CAD tool and this one
```

Create a "draw.io Diagram" from the create-new menu. `pnpm test` runs the unit tests; the e2e spec is [`drawio.spec.ts`](../harness/e2e/tests/drawio.spec.ts).

## How it works

- **draw.io's web app is served with the tool.** [`webapp.nix`](webapp.nix) fetches a release (`draw.war`, pinned by hash) and leaves out what an embedded, offline editor never loads: the Java servlet, the cloud integrations, the separate viewer builds, the unminified sources and the service worker (67 MB in about 2900 files, of 120 MB). The devshell sets `DRAWIO_WEBAPP` to it, and the build copies it to `dist/drawio`, next to the bundle.
- **The editor runs in an iframe of it, in embed mode** ([draw.io](https://www.drawio.com/doc/faq/embed-mode): "When the `embed=1` URL parameter is set, the editor communicates with the parent page or opener window via `postMessage`"), with `stealth` and `offline`, so it asks no other site for anything; the e2e harness, which refuses every request that leaves the machine, checks this.
- **Every change is saved:** the editor reports each change (`autosave`); 300 ms after the last one, the tool asks for an export as an "SVG with embedded XML" (`xmlsvg`) and writes it as the document's `content`. An export right at the change lacks the new shapes, which draw.io hasn't drawn yet.
- **The content is replaced whole,** so that two concurrent saves leave one of them, never a mix of both that isn't valid XML. A change from elsewhere, another tab or a collaborator, is loaded into the open editor, which then shows that version.
- **A version that can't be edited,** a handle at fixed heads, is shown as its picture.
- **Shaped as a file:** the document has `name`, `extension: "drawio.svg"`, `mimeType: "image/svg+xml"` and `content`, so that what reads files reads it as an SVG; the CAD tool counts a document of another datatype with a file's content, MIME type and extension as a file (`isFile` in [`imports.ts`](../cad/src/components/imports.ts)).

## Limits

- No presence: collaborators each have their own editor, and a collaborator's save replaces what is open, with draw.io's selection and undo history.
- A change that arrives while the tool's own export is on its way is overwritten by it.
- Deploying the tool with pushwork means syncing the web app's 2900 files; tried only on the local stack.
- `.drawio.svg` files uploaded through the sidebar are of Patchwork's `file` datatype, which this tool doesn't open.
