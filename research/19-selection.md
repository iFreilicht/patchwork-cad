# One Selection

The editor's browser, timeline, code pane and dialogs share one selection: the item whose dialog is open. A click on any item selects it and opens its dialog, every pane scrolls to what stands for it, and the dialog closes as easily as it opens. Status: design, not implemented.

## Today

| Clicked                           | Does                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| a body or sketch in the browser   | opens its version's feature dialog ([15](15-bodies.md#the-browser)), or picks it |
| a feature entry in the timeline   | opens its dialog; a second click closes it                                       |
| a Custom Script or `body()` entry | opens the code pane at its code                                                  |
| the parameters or return entry    | opens its dialog                                                                 |
| a view, Home                      | moves the camera there ([18](18-named-views.md#in-the-editor))                   |
| a configuration, Defaults         | shows the model with it ([17](17-parameters.md#configurations-in-the-dialog))    |

Each dialog has its own open state (`editor.open()`, `paramsOpen`, `resultOpen` in [`WysiwygEditor.tsx`](../src/cad/src/components/editor/WysiwygEditor.tsx)), the browser marks the current view and configuration on its own, and only a thread focused in the Comments panel scrolls the timeline ([`Timeline.tsx`](../src/cad/src/components/editor/Timeline.tsx)). Views and configurations have no dialog, and nothing scrolls the code pane to a selection.

## Prior art

- **Fusion** edits on a double click: "Double-click the feature you want to edit" or "right-click it and select Edit Feature" ([Autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=ASM-USE-TIMELINE)). A single click selects; on a selected feature, a double click deselects instead and "the Edit Feature window does not open" ([Autodesk Community](https://forums.autodesk.com/t5/fusion-support-forum/timeline-double-click-won-t-edit-feature/td-p/7769605)).
- **Onshape** also opens a dialog on a double click: "you can double click on it in the feature list (or right click and click 'edit')" ([forum](https://forum.onshape.com/discussion/8356/feature-dialogue-box-disappeared)). Selection cross-highlights: "selecting a face or part in the graphics area also cross-highlights associated features" ([help](https://cad.onshape.com/help/Content/feature_list.htm)).
- **Zoo Design Studio** keeps code and feature tree "1:1" ([roadmap](https://zoo.dev/roadmap)), shows "a strong link […] between the 3d-scene and the code from hovering and cursor position" ([blog](https://zoo.dev/blog/why-modeling-app)), and "You can double click feature tree items to edit their parameters" (in-app onboarding).
- **OpenSCAD** jumps from the view to the code: "Add jump to source code from 3D preview", a right-click menu of the call trace under the pointer ([release notes](https://github.com/openscad/openscad/blob/master/RELEASE_NOTES.md)).

All of them open dialogs with a double click; we open them with a single one, since our dialogs apply edits as they are made and have no OK or Cancel that a stray click could start.

## The selection

At most one item is selected per tab, and its dialog is the one in the dialog area. It is named by what survives edits of the code: a feature or Custom Script by an Automerge cursor at the start of its code, with the variable name as a fallback for when the whole text is replaced, as the open feature is now ([`state.ts`](../src/cad/src/components/editor/state.ts)); a view or configuration by its id. Renaming a feature, in the code or in place, therefore keeps it selected: the dialog stays and only its label changes, without closing and opening again, and a test checks this for every keystroke of a rename typed in the code. Only when the item is deleted, e.g. by a collaborator, is the selection cleared. While a dialog's field picks ([07](07-poc-modelling-ui.md#the-editor)), clicks in the browser, timeline and view pick, as they do now, and don't select.

| Selected                                 | Dialog                                                   | Browser                                                | Timeline             | Code                                                                               |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| a feature (entry, or body or sketch row) | its dialog                                               | the rows of the bodies and sketches it made, if listed | its entry            | its statement                                                                      |
| a Custom Script, a `body()`              | none                                                     | as a feature's                                         | its entry            | its lines                                                                          |
| the parameters entry                     | Parameters, with the shown configuration                 | the shown configuration's row, or Defaults             | the parameters entry | `defaultParams`, or the derived values if the dialog's derived table was used last |
| a configuration, Defaults                | Parameters, with it chosen; also shows the model with it | its row                                                | the parameters entry | `defaultParams`                                                                    |
| the return entry                         | the return's                                             | —                                                      | the return entry     | the `return` statement                                                             |
| a view, Home                             | the view's, below; the camera also moves there           | its row                                                | —                    | —                                                                                  |

Choosing a configuration in the Parameters dialog selects its row, so the browser and the dialog never disagree. Clicking a row double-clicked to rename it opens its dialog with the first click, which is harmless; rename stays in place on the row (double click, F2, context menu), without Fusion's select-then-click.

**A view's dialog** has the view's name in its header, "Update to current view" and "Delete"; Home's has "Update to current view" and "Reset to default" ([18](18-named-views.md#home)). The grip stays on the row, where a drag starts.

Clicking a face or edge in the view selects it for its name in the status bar ([12](12-hover-highlighting.md#design)); that geometry selection stays separate from the item selection, and like any click in the view it closes the dialog ([Closing](#closing)). A face's context menu offers "Edit ‹feature›" for the feature that created it, the base of its name ([12](12-hover-highlighting.md#design)), which selects that feature. Edges get no such entry: an edge lies between faces that different features may have created, so it doesn't name one feature, and a feature that formed an edge always created a face along it, which is the more obvious thing to click.

**Presence shares the selection** instead of the open feature ([13](13-collaboration.md)): a collaborator's selected item is marked in their colour wherever it shows, its browser rows, its timeline entry and its code, also when it is a view, a configuration, a Custom Script or the parameters entry. So it is clear who is where, whichever pane one looks at.

## Following the selection

A selection made in one pane scrolls the others to it, `nearest`, so nothing moves that is already visible: the browser to its rows, the timeline to its entry, the code pane, if open, to its code, without moving the cursor. The pane it was made in doesn't scroll. Opening the code pane scrolls to the selection's code. Hover doesn't scroll; it cross-highlights as it does now ([12](12-hover-highlighting.md#design)).

## The code pane

The selection follows the cursor at once while the code pane has focus: entering a feature's statement selects the feature and opens its dialog, entering `defaultParams` the parameters entry, a Custom Script's lines the script. Feedback without delay shows which form edits which code, the relation the editor is about ([07](07-poc-modelling-ui.md#text-vs-ast-editing)); a dialog costs less than the ghost meshes hovering already requests ([12](12-hover-highlighting.md#design)). Where there is no item, e.g. imports or blank lines between statements, the selection is cleared, so a click there closes the dialog as a click elsewhere does.

- **Focus stays in the code.** The dialog opens beside it, and typing goes on; a field's edit splices the code under the cursor as a collaborator's would.
- **While the code doesn't parse,** e.g. halfway through typing a new name, the dialog stays, disabled, instead of closing until the code parses again. Today the open feature is undefined during a syntax error, so this needs the last parsed state.
- **The code and code + preview tools** have no dialogs and stay as they are ([composable tools](07-poc-modelling-ui.md#two-tools)).

## Closing

- the × in the dialog's header;
- **Escape,** unless something in the dialog uses it first: a field restores its value ([07](07-poc-modelling-ui.md#the-editor)), a rename field cancels, a menu closes;
- **clicking the selected item again,** as a timeline entry does now;
- **a click elsewhere:** in the view, on empty space in the browser or timeline, or on code without an item. A press counts as a click if it moves less than 4 pixels, the ViewCube's threshold ([18](18-named-views.md#in-the-editor)); a drag orbits or pans and keeps the dialog, as the wheel does. Controls elsewhere, e.g. the toolbar or the status bar's Copy, do what they do; a toolbar button that adds a feature selects the new one. A click that closes an open menu or comment popover closes only that.

A field with text that isn't one expression drops it when the dialog closes, as it does when the field is left.

## Implementation

A `selection` signal in the editor state ([`state.ts`](../src/cad/src/components/editor/state.ts)), `{ kind: "feature" | "script" | "params" | "configuration" | "return" | "view"; id: string; from: "browser" | "timeline" | "code" | "view" }`, replaces `open`, `paramsOpen` and `resultOpen`; `editor.open()` becomes derived from it. Selecting a configuration also sets the shown one ([17](17-parameters.md#configurations-in-the-dialog)), selecting a view moves the camera. One effect per pane scrolls to the selection unless `from` is that pane. Presence sends `{ kind, id }` in place of `open` ([`WysiwygEditor.tsx`](../src/cad/src/components/editor/WysiwygEditor.tsx)), a feature's or script's id being its Automerge cursor, which every peer of the document resolves. The click-elsewhere rule is one capturing `pointerdown`/`pointerup` pair on the editor, as the timeline's `unpick` is now.

Tests: an e2e spec per pane pair (browser ↔ timeline ↔ code, each way, with the target scrolled out of view first), closing by each means, orbiting with a dialog open, the cursor moving through statements, renaming a selected feature in the code and in place without the dialog closing, "Edit ‹feature›" on a face, and picking a body while a field picks.

## Open

- **Many collaborators'** selections may feel distracting; the PoC marks them all.
- **Touch** is left until touch interactions are designed as a whole ([11](11-adopting-shapes.md#touch)); there, a tap would select, and the view's drag threshold would decide between closing and orbiting.
