# Embedding

What a CAD model can take from other Patchwork documents, and how that looks in the editor: [item 7 of the review](01-basic-idea-and-literature.md#problems-and-risks) ("decal, reference in a sketch, annotation"), widened to every way a document can enter a model. A report with suggestions; only [imports of data and JS](02-model-storage.md#imports-in-the-prototype) and [linked values](17-parameters.md#values-from-other-documents) exist, both without UI beyond a pasted URL. The reverse direction, a model embedded elsewhere, is done ([18](18-named-views.md#embeds)).

## Roles

A document can play several roles in a model; the role, not the document's type, decides where the reference is stored and how it is shown.

| Role | The document contributes | Typical documents | Stored in | State |
|---|---|---|---|---|
| Value | numbers and strings for parameters | JSON files, [datagrids](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/datagrid/src/datatype.ts), any document's fields | code (import), or a configuration (`{ link }`) | done ([02](02-model-storage.md#imports-in-the-prototype), [17](17-parameters.md#values-from-other-documents)) |
| Code | functions, feature types | JS files | code (import) | JS done; feature types open ([02](02-model-storage.md#feature-types)) |
| Sketch geometry | the curves of a drawing, as a profile | SVG, later DXF and tldraw drawings | code | [suggested](#sketch-from-a-drawing) |
| Text | a font's outlines | TTF files | code | later, with the above |
| Body | a solid or mesh | STEP and STL files, other models | code | with assemblies |
| Decal | an image on faces, part of the product | PNG, JPEG, SVG | code | [suggested](#decal) |
| Canvas | an image on a plane, to trace or compare | PNG, JPEG, SVG | the `cad` field | [suggested](#canvas) |
| Annotation | itself, shown at a place on the model | any document | the `cad` field | [suggested](#annotation); comments exist ([13](13-collaboration.md#comments-1)) |

## Prior art

### In CAD systems

- **Fusion collects all of this in one Insert menu:** "Insert Component Insert Fastener Insert Derive Decal Canvas Insert SVG Insert DXF Insert McMaster-Carr Component Insert Mesh" ([Insert tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-TOOLS.htm)). Components and derives are linked: "It creates an associative reference to that design document. … When you edit the original design, the changes display in any assembly where it is referenced."
- **Decal and canvas are separate tools for the same image.** A decal belongs to the part: "Use Decal to apply a sticker-like image to a face. The Decal tool, unlike the Attached Canvas tool, can place an image on a curved face", optionally "Chain Faces to wrap the image across multiple faces", and "a Decal folder displays in the Browser with the image" ([Decal](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INS-DECAL.htm)). A canvas is an aid: "The Canvas tool places an image on a planar face or sketch plane. … If you want to reference the image as you design, select Display Through", and "Use Calibrate to scale your canvas to a specific size so you can use it as a reference for your design" ([Insert tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-TOOLS.htm), [Canvas](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-CANVAS.htm)).
- **Drawings become sketches, as copies in Fusion:** "The Insert SVG tool inserts an SVG file as a fixed sketch object in the current design. You can use SVG files to create detailed sketches like logos or text", and "A sketch is created and the image geometry is centered on the sketch origin" ([Insert SVG](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INS-SVG.htm)); for DXF, "One Sketch per Layer mode creates a separate sketch for each DXF layer".
- **Onshape links them:** "Insert DXF or DWG files into a sketch as sketch entities. The DXF or DWG must have already been imported into the currently open document (or another document you own or that has been shared with you, creating a link to that document)", and "the first dimension applied automatically scales the entire sketch" ([Insert DXF](https://cad.onshape.com/help/Content/Sketch/insert_dwg_or_dxf.htm)). An image in a sketch is a tracing aid ("Create sketch geometry using the image as a guide") that follows its source on request: "If the source of the image changes, it may be updated in its tab using the Update option on the tab context menu. This also updates the image wherever it is used in the document" ([Insert image](https://cad.onshape.com/help/Content/Sketch/insert_image.htm)).
- **Following or pinned is a choice, with a visible state.** Onshape: "When referencing a workspace, any updates to the master model update instantly. When referencing a version, updates to the master model must be versioned, and the reference must be updated to the new version. The version icon indicates when there is an out-of-date reference", and a version "allows you to decide when to rebuild the updates" ([Derived](https://cad.onshape.com/help/Content/PartStudio/derived.htm)); "Instead of changes to RefDoc propagating into UsingDoc with no recourse, you are informed when new versions are available and you choose whether to use them or not", and the source is a click away: "select Open linked document" ([Linking documents](https://cad.onshape.com/help/Content/linked-documents.htm)). Rhino's block definitions are "Embedded", "Embedded and linked" or "Linked", with "Always update", "Prompt when update required" and "Never update" for what happens when a model is opened, and "The icon appears behind the block definition name when the linked block is out of date. Click the icon to reload the block" ([Block](https://docs.mcneel.com/rhino/8/help/en-us/commands/block.htm)). Blender: "Link creates a reference to data in a source file such that changes made there will be reflected in the current file the next time it is reloaded", "Linked data-blocks are indicated with a chain icon in the Outliner", and "you can also Link/Append blend-files by dragging and dropping them into the Blender window" ([Link & Append](https://docs.blender.org/manual/en/latest/files/linked_libraries/link_append.html)).
- **Code-CAD imports by file name.** OpenSCAD's `import()` reads "2D geometry formats DXF PDF SVG" and "Data formats JSON", picks parts of a drawing ("For SVG import only, the id of an element or group to import"), and "PNG can be imported using surface()" ([Importing Geometry](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Importing_Geometry)). build123d's `import_svg(svg_file, *, flip_y=True, align=<Align.MIN>, ignore_visibility=False, label_by='id')` names what it reads: "XML attribute to use for imported shapes’ label property. Defaults to “id”", and `import_svg_as_buildline_code` is the copying variant: "Translate the contents of the given svg file into executable build123d/BuildLine code" ([Import/Export](https://build123d.readthedocs.io/en/latest/import_export.html)). KCL's modules include "Imports that read foreign files (STEP/OBJ/…)" ([Modules](https://zoo.dev/docs/kcl-lang/modules)). FreeCAD's spreadsheet gives values names: "Alias: Define an alias for this cell. This alias can be used in cell formulas and also in general expressions" ([Spreadsheet](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Spreadsheet_Workbench.md)).

### In document tools

- **Link or embed** is OLE's distinction: "Changes to data in the master file immediately affect the document that references it. This is called "linking" (instead of "embedding")" ([Wikipedia](https://en.wikipedia.org/wiki/Object_Linking_and_Embedding)). Transclusion is the linking half: "a resource is stored once and distributed for reuse in multiple documents. Updates or corrections to a resource are then reflected in any referencing documents" ([Wikipedia](https://en.wikipedia.org/wiki/Transclusion)).
- **Shallow or deep.** Embark: "Many transclusion mechanisms have a key limitation: they only support shallow view embeds. … the host is rendering a view without a deeper understanding of the data inside that view" ([Embark](https://www.inkandswitch.com/embark/)). In the [roles](#roles), an annotation is shallow, a view of the document; every other role is deep, the model uses the document's data.
- **One gesture, then the role.** Notion asks after a paste: "Copy and paste the URL. In the menu that appears, select Paste as bookmark", or "Paste as mention" ([Notion help](https://www.notion.com/help/embed-and-connect-other-apps)).
- **Updates are offered, not forced,** in Figma: "When library updates are available, the Libraries icon at the bottom of the navigation bar on the left will display a blue badge", and "Click Update next to an individual asset, or Update all to apply all updates" ([Figma help](https://help.figma.com/hc/en-us/articles/360039234193-Review-and-accept-library-updates)).

### Annotating 3D models

- **Sketchfab:** "Annotations are notes positioned in 3D space. They allow authors to provide information on a specific part of the model and tell a story" ([Viewer API](https://sketchfab.com/developers/viewer/functions)). Each has a camera: "you can mark different points on your model, record the best camera position, and add a description" ([announcement](https://sketchfab.com/blogs/community/want-your-models-to-tell-a-story-meet-our-new-annotations-feature/)); the API's `createAnnotationFromScenePosition( position, eye, target, title, text, [callback] )` takes "the position of the camera when the annotation is selected".
- **PMI** is the engineering form: it "conveys non-geometric attributes in 3D computer-aided design (CAD) and collaborative product development systems necessary for manufacturing product components and assemblies. PMI may include geometric dimensions and tolerances, 3D annotation (text) and dimensions, surface finish, and material specifications" ([Wikipedia](https://en.wikipedia.org/wiki/Product_and_manufacturing_information)). It is structured data on faces for machines and drawings; the annotations here are documents for people.
- **Comments** on faces, edges and features exist, with pins that follow the face and a list of detached threads ([13](13-collaboration.md#comments-1)).

### In Patchwork

- **A drag carries document URLs:** [`text/x-patchwork-dnd`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/sideboard/src/sideboard/dnd/payload.ts), the sideboard's `DndPayload` (`{ source, items: [{ url, name?, type?, toolId? }] }`, where "an item's `type` is the *datatype* id (e.g. "folder", "todo"), not a tool id", [openscad `dnd.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/openscad/src/dnd.ts)), `text/x-patchwork-urls` and `text/plain`, "so existing drop targets (sideboard, paper, space, markdown embed) accept them unchanged" ([universal-dnd](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/universal-dnd/NOTES.md)). "Only `text/x-patchwork-urls` is guaranteed" ([tldraw5 `dnd.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/tldraw5/src/dnd.ts)). Our named views are dragged out this way ([18](18-named-views.md#in-the-editor)).
- **A host shows a document through the embed frame:** "chrome (title, tool picker, open button) around a nested `<patchwork-view>`. Hosts mount it via `<patchwork-view tool-id="embed">`, pin the inner tool with the `embed-tool-id` attribute" ([embed `tool.tsx`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/embed/src/tool.tsx)).
- **Each host stores the reference its own way:** markdown as text, "`[patchwork:docId]` or `[patchwork:docId/toolId]`", following by default: "No heads in the url: the embed follows whatever version the host resolves" ([`embed.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/codemirror-markdown/src/extensions/embed.ts)); tldraw as a shape with props, placed at the drop point, where a second drop of the same document selects the first: "Already embedded: select it rather than creating a duplicate" ([`tool.tsx`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/tldraw5/src/tool.tsx)); chat as `pendingEmbeds` of a message ([`InputArea.tsx`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/chat/src/components/InputArea.tsx)).
- **Comments can hold embeds:** a draft is "A cute.txt editor bound to the comment's `draftContent`. Replaces the plain textarea so drafts get the same rich plain-text (marks, emoji, embeds) that chat and notes use" ([`CommentThread.tsx`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/comments-view/src/CommentThread.tsx)).
- **The openscad tool is the deep one:** "Drag any Patchwork document onto the "Imports" bar above the editor to make its data available inside your `.scad` source as JSON", under "a sanitized, deduped identifier derived from the doc's title (click it to rename)", and "Imports are live: editing the source doc re-resolves and re-renders automatically" ([README](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/openscad/README.md)). [02](02-model-storage.md#verdict-imports-in-code) keeps its gesture and puts the import in the code.
- **Files are documents** `{ name, extension, mimeType, content }` ([`types.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/file/src/types.ts)). Neither `mimeType` nor the type of `content` says what a file is: one dropped into the sidebar keeps its bytes whatever it is (`content = new Uint8Array(arrayBuffer)`) with the browser's type, `mimeType: file.type || "application/octet-stream"` ([`file-drop.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/sideboard/src/sideboard/document-list/file-drop.ts)), which an STL file gets; the file tool's own table knows SVG, PNG, JPEG, PDF, JSON and JS and has `mimeTypes[ext] || "text/plain"` for the rest ([`mime-types.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/file/src/mime-types.ts)).

## Principles

1. **What changes the result is code; what helps people work is tool data.** A sketch profile, a decal, a value are part of what the model is, so they are an import and a feature call, and the model stays a plain module ([02](02-model-storage.md#design-goal-portable-models)). A canvas and an annotation change nothing a build returns, so they sit in the `cad` field next to views and configurations, which "serve the tool" ([17](17-parameters.md#document-fields-and-portability)), anchored to faces as stored cameras and comments are (`RefData`, [`types.ts`](../src/cad/src/types.ts)). Fusion draws the same line between decal and canvas.
2. **Link, and show the link's state.** Every linking system above shows whether a reference follows its source, is pinned or is behind, and offers the update ("Visibility of System Status: The design should always keep users informed about what is going on", [NN/g](https://www.nngroup.com/articles/ten-usability-heuristics/)).
3. **Titles, not URLs.** "Minimize the user's memory load by making elements, actions, and options visible" ([NN/g](https://www.nngroup.com/articles/ten-usability-heuristics/)): `automerge:2owYJFe8…` says nothing, so wherever a document is referred to, its title and datatype icon are shown, and opening it is one click.
4. **One gesture, then a choice.** Dropping a document is the gesture Patchwork users know. Where it lands suggests a role only when the target is specific (a face, a field, a line of code); the user chooses, as in Notion's paste menu, and can change the choice later. A drag needs "feedback previewing what will happen before the user “drops” the object", and an alternative that isn't a drag ([NN/g](https://www.nngroup.com/articles/drag-drop/)).
5. **Nothing embedded can break the model silently.** A source that changes or disappears is an error at its import or a marked row, never a different part without notice.

## Suggestions

### Files as modules

Imports accept only JS and JSON files; anything else is refused with "it is a file of type …, not JavaScript or JSON", and bytes with "its content isn't text" ([`components/imports.ts`](../src/cad/src/components/imports.ts)). Two more kinds of module cover every role in code:

```js
import logo from "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" with { type: "text" };    // a string, e.g. an SVG
import label from "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa" with { type: "bytes" };  // a Uint8Array, e.g. a PNG
```

- **The attributes are the standard's, and runtimes are catching up:** Import Text is at "Stage: **3**" ([proposal](https://github.com/tc39/proposal-import-text)), Import Bytes at "Stage 2.7", "The bytes are returned as a `Uint8Array` backed by an immutable arraybuffer" ([proposal](https://github.com/tc39/proposal-import-bytes)). In Deno, text is "Stable as of Deno 2.8: no flag required", while "Binary `bytes` imports are still experimental" ([Deno](https://docs.deno.com/examples/importing_text/)). In Node, "Text modules are available behind the `--experimental-import-text` flag" ([ESM](https://nodejs.org/api/esm.html#text-modules)), "Added in: v26.5.0", "Stability: 1.0 - Early development" ([CLI](https://nodejs.org/api/cli.html#--experimental-import-text)), and for bytes "Support in Node.js is not yet implemented" ([Node 27 alpha](https://nodejs.org/en/blog/announcements/notable-v8-changes-from-node-js-26-to-27-alpha)). The devshell's Node 24.16.0 has neither (`bad option: --experimental-import-text`), so an [export](#export) can't rely on them yet.
- **The tool doesn't depend on browsers implementing them:** [`prepare.ts`](../src/cad/src/kernel/prepare.ts) already replaces every specifier with a blob-URL module and would drop the attribute; acorn 8.19.0 parses it (checked). A `text` module is `export default "…"`; a `bytes` module reads its bytes, which the tool transfers to the worker.
- **The attribute is required.** Without it a non-JS, non-JSON file stays the error it is, as a standard runtime would fail too. The file's type is checked in the feature that uses it (`svg()` of something that isn't SVG is that feature's error).
- **What a file is comes from its `mimeType` and, where that is generic (`application/octet-stream`, `text/plain`), from its `extension`;** text is decoded from bytes. Today's imports refuse a file whose `content` is bytes ("its content isn't text"), so also a JS or JSON file uploaded through the sidebar.
- **What files give:** SVG as text is a [profile](#sketch-from-a-drawing); an image as bytes is a [decal](#decal); a font as bytes makes text with replicad's `loadFont(fontPath: string | ArrayBuffer, …)` ("The font should be in TTF") and `drawText`; a STEP file is a body with `importSTEP(STLBlob: Blob): Promise<AnyShape>` and [`body()`](11-adopting-shapes.md#body) ([replicad.d.ts](../node_modules/.pnpm/replicad@1.1.0/node_modules/replicad/dist/replicad.d.ts)).
- **Model code stays synchronous.** The last two are `async` only for how they get their bytes: `importSTEP` awaits `STLBlob.arrayBuffer()` and `loadFont` a `fetch` of a path, while OCCT's `STEPControl_Reader` and `opentype.parse` are synchronous. With the bytes of an import in hand, the feature library reads a STEP file with the same OCCT calls, and a font given as an `ArrayBuffer` is registered before `loadFont` returns; both checked with replicad 1.1.0 in Node, a box written as STEP and read back, and `drawText` right after an unawaited `loadFont`.

### Sketch from a drawing

```js
const sketch2 = sketch({ plane: plate.end, body: plate, profile: svg(logo, { width: 40, center: [30, 20] }) });
const engraved = extrude({ sketch: sketch2, operation: "cut", target: plate, distance: 0.5 });
```

- **Linked, as Onshape, not copied, as Fusion:** the profile is computed from the document in every build, so a change of the logo rebuilds the model. `svg()` belongs to the feature library and parses in plain JS, so the model stays portable.
- **replicad draws what SVG paths describe:** its pen has lines, béziers and `ellipseTo(end, horizontalRadius, verticalRadius, rotation, longAxis, sweep)`, with "the long and sweep flags (as defined for SVG paths)" ([replicad.d.ts](../node_modules/.pnpm/replicad@1.1.0/node_modules/replicad/dist/replicad.d.ts)). It writes SVG (`toSVG`) but has no reader; JS prior art is [`@jscad/svg-deserializer`](https://github.com/jscad/OpenJSCAD.org/tree/master/packages/io/svg-deserializer) ("converts raw SVG formatted data (files) to JSCAD scripts or geometries").
- **It needs a richer `Profile`.** Today's is one closed loop, a polygon or a circle ([`feature.ts`](../src/features/src/feature.ts)); a drawing has several loops, holes and curves, and an extrude must be able to take one of a sketch's profiles or several. That is an item of its own, before constraints and the workflow of sketching ([00](00-status.md#not-started)), which build on it.
- **Segment ids come from the drawing,** as build123d's `label_by='id'` and OpenSCAD's `id`: an element's `id` names its loop, and its segments are numbered within it (`extrude2.side["leaf.3"]`). References then survive edits of the drawing that keep the ids, and break visibly otherwise ([03](03-topological-naming.md#recommendation)). An `only: ["leaf"]` option picks elements.
- **Size is explicit:** `width` or `height` in model units, or `scale`; Fusion's dialog has the same (position, angle, flip, scale), Onshape scales with the first dimension. The dialog shows the resulting size.
- **In the editor** it is a sketch like any other: the dialog's profile field shows the document's title, and the outline previews on the plane while dragging.
- **"Convert to sketch"** replaces `svg(…)` by its curves as code, once sketches can hold them: Fusion's behaviour, as the explicit way to cut the link.

### Decal

```js
const labelled = decal({ body: engraved, face: plate.side.front, image: label, width: 30, center: [0, 5], angle: 0 });
```

- **A feature, because a decal is part of the product:** it returns a new version of the body ([15](15-bodies.md#bodies-and-lineages)) that carries the decal, so later features keep it, parameters can place it, and an export can include it. The kernel never decodes the image: the body carries the placement and the image, and the viewer makes the texture.
- **Placement** is a face, a centre and angle in the face's frame, and a width; the height follows the image's aspect. They are set in the dialog. Fusion also has handles in the view ("use the manipulators to move, scale, rotate, and flip the image", [Insert tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-TOOLS.htm)); those are a topic for all features together ([00](00-status.md#not-started)).
- **Rendering:** three's `DecalGeometry( mesh, position, orientation, size )` projects onto any mesh but "decal projections can be distorted when used around corners" ([three.js](https://threejs.org/docs/pages/DecalGeometry.html)). It is exact on planar faces, which is the first step; wrapping a cylinder needs the face's own parameterization.
- **It is the first appearance data on a body,** so it should be designed together with colours and materials.

### Canvas

- **An image on a plane or planar face, drawn in the view only:** `cad.canvases: { id, name, image: AutomergeUrl, plane: Frame | RefData, center, angle, width, opacity, through }[]`. `through` is Fusion's "Display Through".
- **Listed in the browser** under "Canvases", with an eye per user as bodies have ([15](15-bodies.md#visibility)); selecting one opens its dialog ([19](19-selection.md#the-selection)).
- **Calibrate:** pick two points on the image and type their distance, as in Fusion; that sets `width`.
- **Images only.** A live document on a plane is possible with three's `CSS3DRenderer`, which "can also be used in order to combine DOM elements with WebGL content", but "It's not possible to use the material system of three.js" and "The renderer only supports 100% browser and display zoom" ([three.js](https://threejs.org/docs/pages/CSS3DRenderer.html)). Other documents are [annotations](#annotation).

### Annotation

- **Any document, pinned to a face, edge, feature or the model:** `cad.annotations: { id, doc: AutomergeUrl, tool?: string, anchor?: CadAnchor, view?: string }[]`. The anchor is the comments' ([`CadAnchor`](../src/cad/src/types.ts)), so placing a pin, following the face through rebuilds and listing detached ones reuse what comments have ([13](13-collaboration.md#comments-1)).
- **Shown as a pin with the document's datatype icon;** a click opens the document next to it in Patchwork's embed frame (`<patchwork-view tool-id="embed">`), with its tool picker and open button; the picked tool is kept in `tool`. The viewer tool shows them too.
- **An optional named view** ([18](18-named-views.md)), as Sketchfab's camera per annotation: opening the annotation goes there.
- **Not a comment thread,** although a comment can hold an embed: threads are discussions that get resolved, and resolved ones are hidden ([13](13-collaboration.md#comments-1)); a datasheet, a test report or a photo of the printed part should stay.

### Dropping, pasting, inserting

A Patchwork drag over the editor is read from `text/x-patchwork-urls`, with the datatype from `text/x-patchwork-dnd` where present. A drop opens [the document dialog](#the-document-dialog), which offers every role the document allows; where it lands only preselects one:

| Dropped | preselects |
|---|---|
| on a face | Decal for an image, Sketch for an SVG, Annotation for anything else |
| on a plane | Canvas for an image, Sketch for an SVG |
| in the code pane, the timeline or the documents list | Import |
| on a field | Import of one value; in a configuration, a link |
| elsewhere in the view | nothing |

- **While dragging,** the target is highlighted as for a pick (face, plane, the gap in the timeline, the line in the code, the field), and the status bar names what a drop there preselects ("Decal on extrude1.end").
- **A preselected role is applied at once,** and the dialog stays open to change it, as our dialogs "apply edits as they are made and have no OK or Cancel" ([19](19-selection.md#prior-art)). With nothing preselected, nothing is written until a role is chosen. A role in code writes the import line and the feature after the marker ([07](07-poc-modelling-ui.md#the-timeline-marker)); the insert is one undo step ([16](16-undo-redo.md)).
- **Dropped on a field,** a whole document doesn't say which of its values is meant, so the dialog's preview is the picker: the values that fit the field (numbers, for a number field) can be clicked. The pick becomes a link in a configuration's value ([17](17-parameters.md#values-from-other-documents)), or an import whose name is the expression of a feature's argument. A drag that already carries a path to a value ([17](17-parameters.md#values-from-other-documents), "Picking a link") needs no pick.
- **A drop on a comment's draft is the comment's:** threads are Patchwork's `comment-thread` tool in our popover as in the Comments panel ([13](13-collaboration.md#comments-1)), so the document embeds there as it does in the panel, and the editor leaves such drops alone.
- **A document already used** is not imported twice: the existing import is reused, as tldraw selects the existing shape.
- **Without a drag:** "Insert" in the toolbar opens the dialog with an empty document field, which takes a pasted URL or a drop. Pasting an `automerge:` URL into the view opens it with that document.

### The document dialog

One dialog for a document in a model. It opens on a drop, from "Insert", and when the document's row in [the list](#the-documents-list) or a feature's document field is selected ([19](19-selection.md#the-selection)).

| Document | Use as | As |
|---|---|---|
| image file | Decal, Canvas, Annotation, Import | bytes |
| SVG file | Sketch, Decal, Canvas, Annotation, Import | text, bytes |
| JSON file | Import, Annotation | data, text, bytes |
| JS file | Import, Annotation | code, text, bytes |
| any other file | Import, Annotation | text (if its content is text), bytes |
| any other document | Import, Annotation | data |

- **Document:** its datatype icon and title, which opens it. The field takes a drop or a pasted URL, also later, which replaces the document.
- **Use as:** the roles the document allows, wherever it was dropped, so a JS file or a datagrid dropped into the view can become an import. It can be changed while no other feature uses what the role made; the feature or entry is then replaced.
- **As,** for a role in code: how the model gets the document ([Files as modules](#files-as-modules)). A sketch needs text and a decal bytes; for an import it is a choice, also later, which rewrites the import's attribute. A feature that then gets the wrong kind is an error at its call.
- **A preview of what the model gets** tells the kinds apart: data as a tree of keys and values, text as its first lines, bytes as their size and, for an image, the picture, code as its exported names. A click on a value in the tree imports only that: a top-level key as a named import, a deeper one by its path in the URL ([17](17-parameters.md#building-blocks)).
- **Name:** the import's, derived from the document's title, as openscad's.
- **Version:** Following or Pinned, and Update when pinned and behind ([Following and pinning](#following-and-pinning)).
- **Below, the role's own fields:** the feature's form for a sketch or a decal, a canvas's placement, an annotation's anchor, tool and view; none for an import.
- **A document with several uses,** opened from the list, lists them in place of "Use as"; each selects its feature or entry.

### The documents list

A "Documents" section in the [browser](15-bodies.md#the-browser), the place Fusion shows decals and canvases and Blender and Rhino their links: every document the model refers to, whether from an import (`documentImports`, [`kernel/imports.ts`](../src/cad/src/kernel/imports.ts)), a canvas, an annotation or a linked value.

- **A row** shows the datatype icon, the document's title, and its state as an icon with a tooltip: following (chain), pinned (pin), newer version available (dot), unavailable (warning).
- **Hovering or selecting a row** highlights the features that use it ([`deps.ts`](../src/cad/src/model/deps.ts), [12](12-hover-highlighting.md)); selecting it opens [its dialog](#the-document-dialog).
- **Hovering or selecting a feature** highlights the rows of the documents it uses, and "Edit ‹document›" in its context menu and its dialog selects the document, as "Edit ‹feature›" on a face selects its feature ([19](19-selection.md#the-selection)).
- **Its context menu** has the dialog's actions that need no field: Open, Follow or Pin to this version, Update (when pinned and behind), Remove (when nothing uses it).
- **In the code pane,** the title is shown after the specifier as a widget that opens the document; the stored text stays the URL.

### Following and pinning

The URL says which: without heads it follows, with `#heads` it is pinned ([02](02-model-storage.md#versioning)), in code and in the `cad` field alike. Pin, Follow and Update rewrite the URL, which for an import is a splice of the specifier.

- **A choice per document,** made in [its dialog](#the-document-dialog) when it is inserted and changeable there later. Both are needed for every kind: following code is "useful for prototyping and testing" ([02](02-model-storage.md#versioning)), e.g. a library written next to the model, and a pinned logo is a released part's.
- **The default is pinned for code and following for everything else.** For feature types, pinned is already the default ([02](02-model-storage.md#versioning)), and an import of JS runs it ([Security](#security)). A logo or a table of values edited next to the model is expected to arrive, as Patchwork's markdown embeds follow and as Onshape's FeatureScript imports within a workspace "will update automatically when the imported tab is changed" ([02](02-model-storage.md#versioning)).
- **"Newer version available"** is the comparison of a pinned URL's heads with the document's, which the tool has loaded anyway ([`components/imports.ts`](../src/cad/src/components/imports.ts)).
- **A following document is locked to the version the model last built with:** `cad.locks: { [url: AutomergeUrl]: heads }`, written by the editor when a build with newer heads doesn't fail, so only when the document changed. A build fails when it has an import error, a failed feature or a broken reference that the build with the locked version doesn't have; then the model is shown as built with the locked version, and the document's row and its import carry the error ([principle 5](#principles)). An older version of the model document has the locks of its time and rebuilds as it was, which Onshape gives as the reason for versions: "every change in the history of UsingDoc is also stable and recoverable" ([Linking documents](https://cad.onshape.com/help/Content/linked-documents.htm)). Pinning stays in the code, where the module says it itself; a lock is the tool's, the viewer and embeds only read it, and an [export](#export) writes the locked versions. Lock writes are never undo steps: `cad.locks` is one of the undo manager's "Paths that are not undoable; changes only to them neither form steps nor end an undo run" ([`manager.ts`](../src/undo/src/manager.ts)). Two editors that have synced different versions of a source may write different locks; each built, and both are in the model's history.
- **Unavailable documents:** an import is the error on its line that it is today; a canvas or annotation is a marked row and pin. Neither is removed automatically.

### Security

- **An imported JS file runs** as model code, in the same sandbox once there is one ([05](05-sandboxing.md#approach)). Pinning it means a later change of that document can't change what runs without a visible edit of the model.
- **The tool reads every URL the code names, with the user's access.** [05](05-sandboxing.md#threat-model) forbids model code to "access documents the user did not hand to the model"; an import inserted by a drop is handed over, one that arrived with a collaborator's edit is not, which the sandbox's design has to settle.
- **An SVG is never put into the page as markup:** as a profile it is parsed to curves in the worker; as a decal or canvas it is drawn as an image, where "some browsers place restrictions": "JavaScript is disabled", "External resources (e.g., images, stylesheets) cannot be loaded" ([MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)).
- **An annotation runs the embedded document's tool,** as opening that document in Patchwork does.

### Export

A model with `automerge:` imports is "Portable only within the Automerge network" ([02](02-model-storage.md#imports-in-the-prototype)). The documents list is the manifest of an export: each imported document written next to the model as a file, and an import map from the URLs to the files. For runtimes without the attributes, it adds a loader: in Node 24.16.0, a `load` hook of `module.registerHooks` that returns `export default …` for `type: "text"` and `"bytes"` runs both imports unchanged (checked). Canvases and annotations are not exported; the module doesn't know them.

## Suggested order

1. **Text and bytes imports, the documents list and the document dialog** (As, Name, Version, preview) for imports, titles in the code pane. Small, and gives the existing imports their UI.
2. **Drop, paste and Insert,** with Import as the only role; picking a value for a field.
3. **Annotations:** the cheapest of item 7's three, built from comment anchors, pins and the embed frame.
4. **Canvases:** a textured plane, its dialog and Calibrate; no kernel work.
5. **Sketch from SVG:** the richer `Profile` and picking among a sketch's profiles, as an item of its own before sketch constraints; then drops onto faces and planes.
6. **Decals:** appearance on bodies, the projector.
7. **Fonts and STEP/STL bodies,** with assemblies.

## Considered

- **Imports listed outside the code,** as openscad's `doc.imports`: rejected in [02](02-model-storage.md#verdict-imports-in-code); the list here is derived from the code.
- **The role from the drop target alone,** with a menu only where several fit: a drop into the view says little about what is meant, and a JS or data document could then only be imported through the code pane.
- **Copying on insert** (Fusion's SVG, OLE's embedding, Rhino's "Embedded"): loses the source's updates and the way back to it. Copying stays possible by duplicating the document in Patchwork and linking the copy.
- **Decals in the `cad` field:** simpler, but a decal that isn't in the code can't be placed by a parameter and is lost outside the tool.
- **Deriving the kind of module from the document's type** instead of an attribute, as JSON files are today: then the same file fails in a standard runtime after export.
- **PMI** (tolerances, surface finish on faces): a feature of its own, with drawings.

## Open

- SVG details: lengths without physical units, strokes versus fills, text (needs the font), `transform`s, self-intersecting paths as kernel failures ([04](04-kernel-robustness.md)); an XML parser for the worker, which has no DOM.
- Decals on curved faces, and which export formats can carry a decal.
- Whether a lock should hold back on every import error, failed feature and broken reference is for user testing.
- Whether a feature that uses a document shows that document's state icon on its timeline entry at all times, as the mark of what depends on something outside the model.
- Accessibility: without a drag, a document gets into the dialog only as a pasted URL, since Patchwork has no document picker a tool could open; once it has one, it belongs in the dialog's document field. Drags don't exist on touch ([11](11-adopting-shapes.md#touch)).
- A file dropped from the desktop onto the editor must become a file document first, as the sidebar makes one.
- Imported documents are prepared again in every build ([00](00-status.md#not-started)); bytes make that more expensive.
