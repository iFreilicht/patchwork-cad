# View Framing

How a camera keeps showing what it was meant to show when the viewport's size changes, when it is shown in another viewport (a named view in the editor and in an embed), and when the model's geometry changes (edits, configurations). Implementation today: `frame`, `apply` and `resize` in [`Viewer.tsx`](../src/cad/src/components/Viewer.tsx); stored cameras: [`CameraState`](../src/cad/src/types.ts), [10](10-view-state.md#camera), [18](18-named-views.md#storage).

## The problem

A camera is stored as direction, target, `distance` and orthographic `zoom`. How much of the model that shows depends on the viewport, for three reasons:

1. **The vertical field of view is fixed.** The perspective camera is `new THREE.PerspectiveCamera(45, 1, 0.1, 10_000)`, and a resize only sets `perspective.aspect = width / height`; the orthographic camera's height is `heightAt(distance)` and its width is that height times the aspect. So the visible height at the target is constant in model units, and the visible width follows the viewport's aspect. Making the viewport taller, as between the screenshots of a 1.8:1 and a 0.9:1 view, halves the visible width: the model is cropped left and right and shown larger.
2. **Framing ignores the viewport.** `frame` puts the camera at `sphere.radius * 3` from the bounding sphere of the model's bounding box. The sphere's angular radius is asin(1/3) = 19.5°, which fits in the 22.5° half-height, but only fits horizontally for an aspect of at least tan 19.5° / tan 22.5° = 0.85. And a sphere around a box is loose: a long flat part leaves a wide margin above and below.
3. **"Still fits" is guessed.** A build reframes unless the new bounding sphere lies in the `framed` sphere. For a stored camera, `apply` makes that up from the distance: `framed = new THREE.Sphere(to.target.clone(), view.distance / 3)`. Whether a configuration switch reframes therefore depends on how close the previous camera was, not on what is on the screen, and when it does reframe, it reframes to the loose sphere.

## Prior art

- **SVG** separates the region to show from the viewport: a `viewBox` and `preserveAspectRatio`. `meet` scales so that "The entire viewBox is visible within the viewport" and "is scaled up as much as possible", `slice` so that "The entire viewport is covered by the viewBox" ([MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/preserveAspectRatio)). CSS's `object-fit: contain`/`cover` is the same pair.
- **Fusion's API** stores this region for an orthographic camera as `setExtents(width, height)` in model units, and fits it with `meet`: "When the camera is assigned to a viewport, typically only the width or the height is used depending on the aspect ratio of the viewport. For example, if the width and height are both 10 but the viewport is 2:1 … the height extent will be 10 and the width extent will be recomputed to be 20" ([Camera.setExtents](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Camera_setExtents.htm)). For perspective, "The extents of a perspective camera is defined by a combination of the position of the eye point … and the perspective angle". A camera can also be a fit instead: with `isFitView`, "when this camera is applied to a viewport it will modify the camera such that the entire model is displayed in the viewport" (quoted in [the Autodesk forum](https://forums.autodesk.com/t5/fusion-api-and-scripts-forum/script-to-set-current-view-to-home-fit-to-view/td-p/5525046)).
- **Blender**'s camera can keep the field of view of the larger side instead of the height: Sensor Fit "Auto: Calculates a square sensor size based on the larger of the Resolution dimensions" ([manual](https://docs.blender.org/manual/en/latest/render/cameras.html)). That halves the problem: going from landscape to portrait swaps which side is kept, but a 2:1 and a 1:1 viewport still show different amounts.
- **OCCT** fits a bounding box with a margin: `V3d_View::FitAll(theMargin=0.01)`, "the margin coefficient for view borders", must be in [0, 1) ([V3d_View](https://occt3d.com/dev/doc/refman/html/class_v3d___view.html)).
- **camera-controls** (three.js) fits a box "using the nearest axis", by the larger of height and width ÷ aspect, plus half the depth, with a `cover` option and paddings "in unit" ([CameraControls.ts](https://github.com/yomotsu/camera-controls/blob/main/src/CameraControls.ts)): `heightToFit * 0.5 / Math.tan( fov * 0.5 ) + depth * 0.5`. Adding half the depth is conservative, not tight.

## Margins to the silhouette

The idea to evaluate: store, per viewport edge, the distance from the model's outline to that edge, negative for a close-up of a part of the model; when shown, move the camera back while an edge is too close, and forward until one edge is exactly as close as stored.

- **It is `meet`.** Four stored margins outline a rectangle around the silhouette; "back until none is too close, forward until one touches" is the largest scale at which that rectangle is inside the viewport. With a different aspect, two margins grow, as in Fusion's example. So resizing works.
- **The unit needs care.** Pixels depend on the viewport, fractions of the viewport are circular; model units at the target, as Fusion's extents, work.
- **It anchors every view to the whole model's outline.** For a view of everything, that is the intent: a wider configuration stays fully visible. For a close-up, it is not: a configuration that only lengthens the plate to the right moves the outline, so a view of the left hole with a negative right margin slides away from the hole. A close-up is anchored to its place in the model, or to the part it shows, not to the silhouette.
- **It costs a fit per show,** which is cheap (below), but needs the meshes before the camera can be placed, so an embed shows nothing until the build.

So the margins are the right model for views that fit the model, and a fixed region for close-ups. Fusion's API leaves that choice to the caller (`isFitView` or extents); the viewer can make it from what the camera shows.

## Recommendation

**A camera stores the region it shows, not a distance.** `CameraState` gets `extent: [width, height]`, the visible rectangle in the plane through the target, in model units, instead of `distance` and `zoom`. Shown in a viewport, the camera fits the rectangle with `meet`: the visible height is `max(height, width / aspect)`. Perspective places the eye at `visibleHeight / (2 tan(fov/2))`; orthographic shows `visibleHeight` directly, so both projections show the same at the target and switching them needs no conversion. The distance becomes the transitory value the idea asks for. A viewport keeps the extent it was given, and a resize only refits it, so shrinking and growing back returns to the same picture. Dollying and zooming scale the extent; orbiting keeps it while the drag lasts.

Cameras are stored in three places: the named views and the changed Home in the model document ([18](18-named-views.md#storage)), and each user's last camera per model and tool in tool storage ([10](10-view-state.md#camera)). Those written before the change have `distance` and `zoom` and are converted when read, as `height = heightAt(distance) / zoom`, `width = height`, which shows what they showed in a landscape viewport; the next save writes the new form.

**Every camera is stored relative to the model if it shows all of it.** When a camera is saved or reported, the viewer fits the model from its direction ([below](#fitting)). If the whole model is inside the visible rectangle, the camera stores its margins instead of a region: `fit: [top, right, bottom, left]`, the distances from the fitted rectangle to the visible one's edges, as fractions of the fitted rectangle's size. Shown again, it fits the model and adds the margins, then `meet`. If part of the model is outside, the camera is a close-up and stores its region. This is the margin idea, restricted to the views it suits, and decided by what the camera shows, so a view has no type to choose: "Update to current view" and "+" store whichever the camera is. The default Home is `fit: [m, m, m, m]` with a small margin `m`. The user's own camera is reported the same way at the end of every orbit, dolly or pan, so it keeps the margins it had where the orbit ended, and a resize of the viewport refits those, also for a camera that isn't a named view.

"Close-up" is this document's term. Fusion's "Detail View" is something else, a drawing view: "An enlarged view of a portion of another drawing view" ([Fusion Drawing reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-REF-DRAWING-TAB.htm)).

### Close-ups

A close-up follows what it shows. When it is saved, it also stores the names of what is entirely inside its rectangle, and its margins to their fitted rectangle, which are never negative: `subject: { faces: string[]; sketches: string[]; fit: [top, right, bottom, left] }`. Faces are named as below, sketches by their feature's name; things embedded in the model, once there are any ([00](00-status.md#not-started)), join them. All of them are stored, however many; a long list costs only storage. Shown again, it fits them as the whole model is fitted ([below](#fitting)) and adds the margins. A body doesn't do: a close-up of a hole shows a part of the plate, not the plate.

The names are the faces' topological names, the ones that code references resolve ([03](03-topological-naming.md#recommendation)): rooted in the feature that made the face, e.g. `extrude1.side.front`, and extended by splits, so a name that splits resolves to all its pieces, which the fit then contains. They survive configurations as references in the code do, and break where those break ([17](17-parameters.md#parameters-stress-references)). Faces that no longer resolve, e.g. of a feature that a configuration's loop parameter removed, are left out; when none resolves, the close-up shows its stored region. When the named faces move apart, the close-up widens to keep them all.

A camera with nothing entirely inside it, e.g. one inside a single large face, shows nothing to look at, so it is taken as not meant that way: it stores the face that covers most of its rectangle, and is shown fitting that face with the default margin `m`. A camera that shows no part of the model at all stores the default Home's fit from its direction.

### Fitting

For a direction, express the corners of the bounding box of each body, or of each face, sketch or other subject of a close-up, in camera coordinates (x right, y up, z towards the eye), with `t` the tangent of half the horizontal or vertical field of view. Per axis, with `a = max(x + t·z)` and `b = max(−x + t·z)`, the eye must be at least at depth `(a + b) / (2t)`, centred at `x = (a − b) / 2`; the larger depth of the two axes wins, and the other axis is only centred. That is the tightest perspective fit of these points for the direction (checked numerically on random point sets: every point inside, one on the frustum). The box corners make it slightly loose for bodies that are rotated against the axes; the mesh vertices would be tight, but cost a pass over every vertex per fit, and a camera with margins fits on every frame of a resize drag. Orthographic is the projected bounding rectangle. The target is the point on the fitted eye's axis at the depth of the model's centre, and the fitted rectangle is what the frustum covers there.

### When the geometry changes

A named view, Home or an embed's view applied after a build, e.g. in another configuration, applies its margins to the new geometry exactly: a configuration that halves the model shows it as large as before.

The camera the user is working with follows the geometry less eagerly. When the model, seen with the camera's margins, fills its rectangle less than half or no longer fits in it, the camera refits with those margins, keeping the direction, as today. Within that band, an edit doesn't move the camera, so that the user sees a parameter change make the part bigger or smaller instead of the camera undoing it. A close-up refits only when no part of the model is left in its rectangle. Today's sphere test has a similar band (it refits when the model's sphere is less than a third of the framed one's), but measured against a guessed sphere instead of what is on the screen.

**Blender's Auto sensor fit is not needed:** with extents and `meet`, the fixed axis no longer decides what is visible, and a fixed vertical field of view keeps perspective distortion the same across viewports.

## Open

- The band's width, half, is a guess to try out.
- The fit formula is not yet in the viewer; a unit test should pin it down there.
