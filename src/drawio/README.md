# draw.io diagrams

A Patchwork datatype `drawio` and its tool `drawio`: [draw.io](https://www.drawio.com)'s own editor on a diagram that collaborators edit at once, each seeing the others' pointers and selections, kept also as a `.drawio.svg` file, an SVG of the diagram that carries the diagram in its root's `content` attribute. Any viewer shows the picture; draw.io opens the diagram. A CAD model shows one on a canvas as the SVG it is, and follows its saves ([research/21](../../research/21-embedding.md#canvas)).

## Usage

```sh
nix develop
pnpm install
pnpm dev        # from the repo root: builds and serves the CAD tool and this one
```

Create a "draw.io Diagram" from the create-new menu. `pnpm test` runs the unit tests; the e2e spec is [`drawio.spec.ts`](../harness/e2e/tests/drawio.spec.ts).

## How it works

- **draw.io's web app is served with the tool.** [`webapp.nix`](webapp.nix) fetches a release (`draw.war`, pinned by hash) and leaves out what an embedded, offline editor never loads: the Java servlet, the cloud integrations, the separate viewer builds, the unminified sources and the service worker (67 MB in about 2900 files, of 120 MB). The devshell sets `DRAWIO_WEBAPP` to it, and the build copies it to `dist/drawio`, next to the bundle.
- **The editor runs in an iframe of it, in embed mode** ([draw.io](https://www.drawio.com/doc/faq/embed-mode): "When the `embed=1` URL parameter is set, the editor communicates with the parent page or opener window via `postMessage`"), with `stealth`, so it asks no other site for anything; the e2e harness, which refuses every request that leaves the machine, checks this. Not `offline`, which also turns off plugins, and with them the plugin API (`Draw.loadPlugin`, "the only long-term supported solution for access to the EditorUi instance", draw.io's `App.js`) that the tool reaches the editor through: the iframe is same-origin.
- **The diagram is records per cell** ([`diagram.ts`](src/diagram.ts)), as tldraw's are: each page's cells keyed by id, with their attributes as a map, their geometry as one value, and the drawing order as a list. Two users' edits of different shapes, or of different properties of one shape (one moves it, the other recolours it), both stay; two moves of the same shape leave one, the same everywhere.
- **Each change syncs both ways at once:** the editor reports a change (`autosave`), or the document changes elsewhere, and the tool reads the diagram from the editor, writes what this user changed since it last did, and merges the document into the editor with draw.io's own merge of a file changed elsewhere (`DrawioFile.mergeFile`), which patches only what differs and keeps the selection and undo history. draw.io diffs against the diagram as it last loaded or merged it, which the tool sets to what it just read, so that the editor then shows the document exactly ([`editor.ts`](src/editor.ts)).
- **The SVG follows:** 300 ms after the last change, the tool asks for an export as an "SVG with embedded XML" (`xmlsvg`) and writes it as the document's `content`, replaced whole. An export right at the change lacks the new shapes, which draw.io hasn't drawn yet. The SVG is a copy for what reads files: a document with records is edited through them, and writing only its `content` changes nothing in the editor.
- **Presence:** each tab sends its contact, page, pointer (in the diagram's coordinates) and selected cells over Patchwork's presence on the document ([`presence.ts`](src/presence.ts)); the others draw its pointer with the contact's name, and its selection as draw.io's own cell highlight, in the contact's colour.
- **A version that can't be edited,** a handle at fixed heads, is shown as its picture.
- **Shaped as a file:** the document has `name`, `extension: "drawio.svg"`, `mimeType: "image/svg+xml"` and `content`, so that what reads files reads it as an SVG; the CAD tool counts a document of another datatype with a file's content, MIME type and extension as a file (`isFile` in [`imports.ts`](../cad/src/components/imports.ts)).

## Limits

- Text being typed into a label is merged once its editing ends, as draw.io saves it then; collaborators see no caret.
- Undo undoes this user's edits as draw.io recorded them, also where a collaborator changed the same property since.
- A document from before the records has its diagram only in the SVG; the first change writes the records, and two users making that first change at once leave one of them.
- The SVG is only as concurrent as a file: two exports at once leave one, which the next change replaces.
- Deploying the tool with pushwork means syncing the web app's 2900 files; tried only on the local stack.
- `.drawio.svg` files uploaded through the sidebar are of Patchwork's `file` datatype, which this tool doesn't open.
