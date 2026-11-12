# Named Views

Named cameras that belong to a model, as Fusion keeps them in the design: listed in the editor, created from the current view, and dragged into other documents to embed the model seen that way. Implementation: [`model/views.ts`](../src/cad/src/model/views.ts), [`namedViews.ts`](../src/cad/src/components/namedViews.ts), the browser's views ([`Browser.tsx`](../src/cad/src/components/editor/Browser.tsx)), embeds ([`embed.ts`](../src/cad/src/components/embed.ts), [`viewer.tsx`](../src/cad/src/tools/viewer.tsx)); tests: [`views.test.ts`](../src/cad/test/views.test.ts), [`cad-named-views.spec.ts`](../src/harness/e2e/tests/cad-named-views.spec.ts), [`cad-viewcube.spec.ts`](../src/harness/e2e/tests/cad-viewcube.spec.ts).

## Prior art

- **Fusion** lists them in the browser: "Right click on the *Named Views* menu within the browser tree and select *New Named View*", and "clicking on the view you just stored in the browser tree will automatically position the camera" ([Renders360](https://renders360.gitbook.io/ftc-rendering-in-fusion-360/rendering-and-exporting/named-views)). A drawing's base view can use a named view ([Autodesk](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-create-a-custom-view-of-a-component-that-is-not-aligned-with-the-X-Y-Z-axis-for-Drawing-in-Fusion-360.html)), the closest thing to embedding one.
- **Onshape:** "Named views capture the perspective, the zoom scale, and the orientation of the current view." They are made in a dialog under the View Tools menu, a name field and a plus button, "per workspace", deleted with an X, and "If the graphic is in a position that matches a named view at the time the Named view dialog is opened, that view will automatically be selected" ([Onshape help](https://cad.onshape.com/help/Content/View/named_views.htm)).
- **SolidWorks** has New View in its Orientation dialog: "It's added to my Orientation window and I just have to click on it to return the model to that view" ([Hawk Ridge](https://hawkridgesys.com/blog/solidworks-manipulation-can-good-thing-manipulating-views)). Update Standard Views redefines Front, Top etc.: "You will then be prompted to select the Standard View you would like to assign the current view too" ([CATI](https://www.cati.com/blog/customizing-view-orientation-solidworks/)).

All three store views in the model, list them, and restore one with a click. None documents updating a named view to the current camera, and only Onshape shows which view the camera is at.

## Storage

The model document holds the views next to `content`, in the `cad` field that configurations will share ([17](17-parameters.md#configurations-and-named-views-in-the-model-document)):

```ts
cad: { views: { id: string; name: string; camera: CameraState }[] }
```

A view is a camera only; configurations and visible bodies may join it later. Names are unique and not empty. Cameras are rounded to 9 decimals, as stored cameras are ([10](10-view-state.md#camera)). Going to a view moves only the user's own camera, which stays per user ([10](10-view-state.md#camera)). The views are part of the model's history, so undo restores a deleted one ([16](16-undo-redo.md)). Concurrent edits merge per view: two users' new views both stay, and a deletion wins over a concurrent rename.

## Home

Every model has a Home view, first in the list, which Fusion keeps as a named view, too. Until someone changes it, it looks from the front, right and above and frames the model with a margin of 0.1 on each side ([20](20-view-framing.md#the-design)), as the ViewCube's Home button always did; "Update to current view" moves it, for everyone, into `cad.home`, and "Reset to default" removes that again and goes there, to show where that is. The Home button, in the editor and the viewer, goes there, and a view without a camera of its own, e.g. a user's first look at a model, opens there. It is set in bold when the camera is there, also at its default framing, which the viewer computes, and hovering it marks the ViewCube's Home button. It can't be renamed or deleted, and an embed names it by the id `home`.

## In the editor

A "Views" section in the [browser](15-bodies.md#the-browser), below the bodies and sketches, as Fusion's Named Views folder:

- **"+" in the section's heading** makes a view from the current camera, named after the nearest ViewCube region ("Front Right Top", numbered if taken), and starts renaming it.
- **Clicking a row** moves the camera to the view, animated, as a click on the ViewCube does. The row whose camera is the current one, up to rounding, is set in bold, as Onshape selects it: after going to it, making it or updating it, until the camera moves.
- **Its context menu,** opened as a body's, renames it (also F2 or a double click), updates it to the current camera, which Fusion and Onshape don't offer, and deletes it.
- **A grip (`⠿`) on each row drags it out** as an embed, with Patchwork's document payload (`text/x-patchwork-urls`, `text/x-patchwork-dnd`, `text/plain`). It must allow every drop effect: the sideboard's list sets `dropEffect = "move"` ("all" keeps move/copy dropEffects … valid so the drop event actually fires). Patchwork has no shared icon for "drag this document"; the pandoc context tool draws the same grip with the file name, titled "Drag … into Patchwork" ([PandocContextTool.tsx](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/pandoc/src/components/PandocContextTool.tsx)), and the `universal-dnd` experiment proposes "drag handles on every `<patchwork-view>`" for Patchwork itself ([NOTES.md](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/universal-dnd/NOTES.md)). The spec drops into the sidebar's document list; other drop targets are untested. In WebKit, a drop only happens where a `dragover` accepted the drag, which Playwright's last move onto a new element hasn't sent yet, so the spec moves a pixel more before releasing.

**The ViewCube orbits when dragged,** at the speed of a drag on the view (OrbitControls' full turn per canvas height), and reports the camera when released; a click still turns the view to a region. A press counts as a drag after 4 pixels.

## Embeds

Dragging a view out creates an embed document, the proxy of [17](17-parameters.md#embedding-proxy-documents), with the unlisted datatype `cad-model-embed` ([`CadModelEmbedDoc`](../src/cad/src/types.ts)):

```ts
{ title: string; model: AutomergeUrl; view?: string }
```

`view` is a view's id, or `home`; `configuration` a configuration's ([17](17-parameters.md#embedding-proxy-documents)). The title is "‹model› – ‹view›" when it is made, and is the document's own afterwards.

The viewer tool shows it: the model, from the view's camera, following the model's latest version and the view as it is updated. Orbiting is local: "Reset" returns to the view, and "Save view" keeps the camera as the view's, in the model, for everyone and every embed of it. A picker lists the model's views, Home first, and choosing one changes the embed's `view`; when the view is deleted, the picker says "Deleted view" and offers the remaining ones. "Open model" opens the model. Views are created, renamed and deleted in the editor.

## Open

- The embed is created when the drag starts, because the payload must carry its URL, so a cancelled drag leaves an orphan.
