# Named Views

Named cameras that belong to a model, as Fusion keeps them in the design: listed in the editor, created from the current view, and dragged into other documents to embed the model seen that way. They replace view documents and dragging the ViewCube ([10](10-view-state.md#view-documents)). Not implemented yet.

## Prior art

- **Fusion** lists them in the browser: "Right click on the *Named Views* menu within the browser tree and select *New Named View*", and "clicking on the view you just stored in the browser tree will automatically position the camera" ([Renders360](https://renders360.gitbook.io/ftc-rendering-in-fusion-360/rendering-and-exporting/named-views)). A drawing's base view can use a named view ([Autodesk](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-create-a-custom-view-of-a-component-that-is-not-aligned-with-the-X-Y-Z-axis-for-Drawing-in-Fusion-360.html)), the closest thing to embedding one.
- **Onshape:** "Named views capture the perspective, the zoom scale, and the orientation of the current view." They are made in a dialog under the View Tools menu, a name field and a plus button, "per workspace", deleted with an X, and "If the graphic is in a position that matches a named view at the time the Named view dialog is opened, that view will automatically be selected" ([Onshape help](https://cad.onshape.com/help/Content/View/named_views.htm)).
- **SolidWorks** has New View in its Orientation dialog: "It's added to my Orientation window and I just have to click on it to return the model to that view" ([Hawk Ridge](https://hawkridgesys.com/blog/solidworks-manipulation-can-good-thing-manipulating-views)). Update Standard Views redefines Front, Top etc.: "You will then be prompted to select the Standard View you would like to assign the current view too" ([CATI](https://www.cati.com/blog/customizing-view-orientation-solidworks/)).

All three store views in the model, list them, and restore one with a click. None documents updating a named view to the current camera, and only Onshape shows which view the camera is at.

## Storage

The model document holds the views next to `source`, in the `cad` field that configurations will share ([17](17-parameters.md#configurations-and-named-views-in-the-model-document)):

```ts
cad: { views: { id: string; name: string; camera: CameraState }[] }
```

A view is a camera only. Configurations and visible bodies may join it later. Cameras are rounded to 9 decimals, as stored cameras are ([10](10-view-state.md#camera)). Restoring a view moves only the user's own camera, which stays per user ([10](10-view-state.md#camera)).

## In the editor

A "Views" section in the [browser](15-bodies.md#the-browser), below the bodies, as Fusion's Named Views folder:

- **A "+" in the section's header** makes a view from the current camera, named after the nearest ViewCube region ("Front Right Top", numbered if taken), and starts renaming it.
- **Clicking a row** moves the camera to the view, as a click on the ViewCube does. The row whose camera is the current one is marked, as Onshape selects it.
- **Its context menu,** opened as a body's, renames it (also F2 or a double click), updates it to the current camera, which Fusion and Onshape don't offer, and deletes it. Undo restores a deleted view ([16](16-undo-redo.md)).
- **A grip (`⠿`) on each row drags it out** with Patchwork's document payload (`text/x-patchwork-dnd`, `text/x-patchwork-urls`, `text/plain`), which existing drop targets accept, as dragging the ViewCube does today. Patchwork has no shared icon for "drag this document"; the pandoc context tool draws the same grip with the file name, titled "Drag … into Patchwork" ([PandocContextTool.tsx](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/pandoc/src/components/PandocContextTool.tsx)), and the `universal-dnd` experiment proposes "drag handles on every `<patchwork-view>`" for Patchwork itself ([NOTES.md](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/universal-dnd/NOTES.md)).

**The ViewCube orbits when dragged.** Today "a click on the cube turns the view, a drag creates a view; the cube can't be dragged to orbit" ([10](10-view-state.md#view-documents)), which is hard to discover, and users expect a drag to orbit. A click still turns the view to a region.

## Embeds

Dragging a view out creates an embed document, the proxy of [17](17-parameters.md#embedding-proxy-documents), with the datatype `cad-model-embed`:

```ts
{ title: string; model: AutomergeUrl; view?: string }
```

`view` is a view's id; `configuration` joins it with configurations. The title is "‹model› – ‹view›" when it is made, and is the document's own afterwards. The datatype is unlisted, as an embed can't be made without a model.

The viewer tool shows it, repurposing what shows view documents today: the model, from the view's camera, following the model's latest version. Orbiting is local, and "Reset" returns to the view. A picker lists the model's views, and choosing one changes the embed's `view`; when the view is deleted, the picker says so and offers the remaining ones. "Open model" opens the model. Views are created, renamed and updated in the editor only.

The embed is created when the drag starts, because the payload must carry its URL, so a cancelled drag leaves an orphan, as with view documents today.

## What goes

View documents are removed without migration: the `cad-model-view` datatype ([`viewDatatype.ts`](../src/cad/src/viewDatatype.ts)), `CadModelViewDoc`, [`viewDoc.ts`](../src/cad/src/components/viewDoc.ts), the viewer's view-document mode with "Save view" ([`viewer.tsx`](../src/cad/src/tools/viewer.tsx)), dragging out of the ViewCube ([`Viewer.tsx`](../src/cad/src/components/Viewer.tsx)) and [`cad-view-doc.spec.ts`](../src/harness/e2e/tests/cad-view-doc.spec.ts). Existing view documents no longer open. [10](10-view-state.md#view-documents) then describes named views and embeds by reference to this document.
