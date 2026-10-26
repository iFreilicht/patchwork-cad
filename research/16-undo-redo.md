# Undo and Redo

Can undo and redo be one feature of Patchwork, for every tool, instead of each editor's own? Automerge already records who changed what, so an undo can be a new change that reverts one tab's earlier changes and leaves everyone else's alone. Prototype: [src/undo](../src/undo/), used by the CAD editor and a tldraw tool.

AM = [`@automerge/automerge` 3.4.1](../node_modules/.pnpm/@automerge+automerge@3.4.1/node_modules/@automerge/automerge/dist), the version we bundle; PB = the vendored [patchwork-base](../.claude/skills/writing-patchwork-tools/reference/patchwork-base).

## The model

**Whose changes:** a tab's. Every change carries its actor, and a tab's documents have their own: automerge-repo creates them with `Automerge.init()` ([Repo.ts](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/Repo.ts)), which uses "a random actor ID" unless given one (AM, `init`), and "Patchwork runs one `Repo` per tab" ([13](13-collaboration.md#the-presence-class)). So the undo history is per tab and per document, as in CodeMirror, tldraw, Yjs ("By default, all local changes that don't specify a transaction `origin` will be tracked", [Yjs](https://docs.yjs.dev/api/undo-manager)) and Loro ("it should only undo/redo local operations without affecting other collaborators' edits", [Loro](https://github.com/loro-dev/loro-docs/blob/main/pages/docs/advanced/undo.mdx)). Two tabs of one user undo independently. The history lives in memory, like CodeMirror's.

**Steps:** consecutive local changes less than 500 ms apart form one step, like CodeMirror's `newGroupDelay` and Yjs's `captureTimeout` ("defaults to 500ms"). A text edit joins a step only next to its last edit, as in CodeMirror (`isAdjacent`). Tools end steps where they know better with `checkpoint()`: CodeMirror after a selection and before a paste ([`markUndoBoundaries`](../src/undo/src/codemirror.ts)), tldraw at its history marks. A step whose undo changes nothing visible, e.g. typing a character and deleting it, is skipped, so that every press changes something.

**An undo run is a step** (the [GURQ](https://github.com/zaboople/klonk/blob/master/TheGURQ.md)'s solution: "The underlying data structure is strictly linear, but all edit states are preserved and reachable", with its shortcut of treating the undone segment as one jump). Undo and redo presses walk back and forth through the steps; the next local change ends the run, and the run's changes become one step. Redo only exists inside a run. Nothing is ever lost: undoing the run brings back what it undid. The scenario this was designed for, Alice and Bob in separate sections of one document:

| # | Action | Alice's section | Alice's history |
|---|---|---|---|
| 1–6 | Alice: A, C, E; Bob: B, D, F in between | A C E | A, C, E |
| 7 | Alice presses undo twice (G) | A | A, C, E (run: E, C undone) |
| 8–9 | Bob: H; Alice: I | A I | A, C, E, G, I |
| 10 | Bob undoes H (J) | A I | unchanged |
| 11 | Alice presses undo three times (K): I, G (which brings back C and E), E | A C | A, C, E, G, I (run) |
| 12 | Bob: L | A C | unchanged |

**Each press is a change at once.** Every undo and redo writes a change and syncs, so collaborators see the same state as the user and can build on it; the history only groups the run. The alternative, keeping undos local until the next edit, would need a fork that the tool shows instead of the document. Patchwork can swap what a handle shows (the draft overlay's `scopeReplaced`, which "invalidates the undo stack", PB [useAutomergeStore.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/tldraw4/src/lith/useAutomergeStore.ts)), but collaborators would keep editing the state the user is undoing away from, and closing the tab would drop the undos. The cost of committing at once is a few extra changes per run.

## Inverting changes

Automerge has no inverse of a change ("I know undo/redo were cut for 1.0", [automerge#985](https://github.com/automerge/automerge/issues/985)). Applying the reverse patches at the change's heads, as [automerge-repo-undo-redo](https://github.com/onsetsoftware/automerge-repo-undo-redo) does with untracked changes in between, leaves concurrent text "tacked unatractively on" (its README). [`invertChanges`](../src/undo/src/invert.ts) works on the change's operations instead (`getDecodedChangeByHash`) and writes through AM's backend by object id, inside one `change`, like Yjs's UndoManager:

| The step | Its inverse |
|---|---|
| inserted a character or list element | deletes it, if still there |
| deleted one | inserts a copy where it was (its cursor resolves to that place), in document order for runs |
| set or deleted a map value or list element | restores the value from before the step, if the value is still the step's; else a conflict |
| incremented a counter | decrements it |
| changed something inside an object it created | nothing: the object goes |
| set a mark | nothing (not supported) |

- **Copies get new ids.** Automerge can't undelete, so a re-inserted character, a restored value or object is new. A map from each original id to its copy, which the inversion keeps up to date, lets later undos find them, as Yjs's `redone` pointers do ("If this type's effect is redone this type refers to the type that undid this operation", [Item.js](https://github.com/yjs/yjs/blob/main/src/structs/Item.js)). Copied objects map their contents too, so undoing an edit inside a record that was deleted and restored reaches the copy.
- **Order matters.** Restores run newest first and repeat while one makes another's target reachable again (an object, then the text inside it). Index-based inserts go right after the preceding visible element, so a copy can land before tombstones its original followed; the inversion steps back over such copies.
- **Conflicts:** a value that someone else set after the step (or concurrently) is skipped by default, as Yjs does (its `redoItem` gives up on a map entry with a newer value, `if (left && left.right !== null)`, unless `ignoreRemoteAttributeChanges`, [UndoManager.js](https://github.com/yjs/yjs/blob/main/src/utils/UndoManager.js)); `conflict: "force"` restores it anyway. Both are tested, neither is obviously right: skipping means an undo can silently do nothing to a field, forcing overwrites a collaborator. The CAD editor and CodeMirror only write text, which never conflicts.
- **Two users in one paragraph:** undo removes only one's own characters, wherever the other typed: Alice types "hello world", Bob adds "," and ">", Alice's undo leaves ">,". Undoing a deletion restores the text around what the other inserted into it concurrently ("<X>" → "<helloX world>"). Text the other deleted stays deleted. The result is always a merge, never a lost edit, but it can leave fragments that make sense to nobody. Undoing the creation of a record deletes the other's edits inside it.

AM limits and bugs found on the way, also in 3.5.0:

- **Cursors exist only for text** ("cursors only valid on text - obj type: list"). List elements are found by the ids of the ops that wrote their values, and positions are carried through the patches between states.
- **A cursor at historic heads throws** "cursor … is invalid" for a tombstone without visible successor once the document has changed since. It resolves to the end in the workaround.
- **`getHeads()` inside a `change` commits** the pending ops as a change of their own, which the resulting document doesn't show. The inversion takes the heads from before the change.

## Experiments

- **The scenario and edge cases** ([scenario.test.ts](../src/undo/test/scenario.test.ts), [cases.test.ts](../src/undo/test/cases.test.ts)): the table above, redo, grouping, text both edit, map conflicts under both policies, counters, tldraw-shaped records (create, move, edit text, delete, undo all, undo the run), ignored paths.
- **Fuzz** ([fuzz.test.ts](../src/undo/test/fuzz.test.ts)): two users edit their own sections (text, map values and objects, lists with and without overwrites, records with text) with random undos, redos and syncs. After every action each section must equal what an Emacs-style history of snapshots predicts. 2 × 2000 seeds of 500 actions pass (`FUZZ_SEEDS=2000 FUZZ_STEPS=500`); the default run is 2 × 40 seeds of 150.
- **CodeMirror** ([codemirror.test.ts](../src/undo/test/codemirror.test.ts)): the same edits at the same times in an editor with `history()` and in one that writes to Automerge and undoes with the manager. In eight sessions (typing with and without pauses, typing at two places, backspace, a paste, replacing a selection, two cursors, a click) both give the same texts after every undo and redo. The cursor after an undo is the same except after replacing a selection, where CodeMirror restores the selected range and the manager's `onApplied` puts a cursor. After an edit that follows undos, CodeMirror has dropped its redo branch, the manager has not.
- **The CAD editor** ([cad-undo.spec.ts](../src/harness/e2e/tests/cad-undo.spec.ts)): the editor binds the document's history instead of CodeMirror's, which also makes timeline and dialog edits undoable for the first time. The scenario typed by two browser profiles in the code pane, through Subduction, and deleting a feature in the timeline, then undo and redo with the focus in the 3D view, pass in Chromium, Firefox and WebKit.
- **Cost** ([bench.ts](../src/undo/bench.ts), Node 24, Apple M1 Pro): recording takes 0.3–0.4 ms per local change; an undo takes 3 ms (median) in a document of 10 000 characters with 1 000 changes and 24 ms in one of 100 000 characters with 10 000 changes.


## tldraw

tldraw's `HistoryManager` records the store's user changes between marks (`markHistoryStoppingPoint`), so a drag is one step however many changes it makes, and every user change clears the redo stack ([HistoryManager.ts](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/editor/managers/HistoryManager/HistoryManager.ts)). It also cancels gestures through it: "you can bail back to this mark" (`bailToMark`, `Editor.ts`). PB's binding writes only document records to Automerge (`store.listen(…, { source: "user", scope: "document" })`, [useAutomergeStore.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/tldraw5/src/lith/useAutomergeStore.ts)), as map values that it updates key by key, arrays element by element.

[16-undo-redo/tldraw](16-undo-redo/tldraw/) is a second tool for PB's `tldraw5` documents with the same binding, undone with the document's history:

- **Marks are checkpoints:** it wraps `editor.history._mark`, through which all marks go, and groups nothing by time (`groupDelayMs: Infinity`). A cancelled gesture is undone by tldraw and written as a change of the same step, which then has no effect and is skipped.
- **tldraw keeps a record of the user in the document** (`user:…`). Undoing the first step deletes it, tldraw puts it back at once, and that local change ends the undo run, so redo is gone after every undo. Such records must be ignored (`ignore`), as `@comments` in the CAD editor.
- **Undo and redo** (keys, and tldraw's menu actions, overridden) go to the document's history.

[undo-tldraw.spec.ts](../src/harness/e2e/tests/undo-tldraw.spec.ts) draws two rectangles (one drag pausing for 700 ms), moves one and deletes the other, with the mouse and keys, in PB's tldraw5 tool and in this one, then undoes and redoes until nothing changes. The shapes after every press are the same in both: four steps back to the empty canvas and four forward, in Chromium, Firefox and WebKit. Not compared: the selection, which tldraw's own undo restores from session records and the document's history doesn't have.

## Undos nobody sees

In the CAD editor, a step can change the code without changing the geometry, e.g. whitespace in a feature's formula. Once that feature's dialog is closed, undoing such a step changes nothing on screen, and the press looks like it did nothing. Text editors show every edit, and tldraw's shapes are what is edited, so this matters mostly where the view is derived from the document. No solution yet. Options: showing what an undo changed (a brief highlight of the feature, as [12](12-hover-highlighting.md) highlights hovered ones, or a notice in the status bar), or skipping steps that don't change the timeline's meaning, which would hide edits that do matter to the code.

## What Patchwork would need

- **One history per document and tab, shared by all tools on it** ([`undoManagerFor`](../src/undo/src/keys.ts)), so that the CAD editor's code pane and timeline, or two panes on one document, undo together.
- **One keyboard binding for the page** ([`bindUndo`](../src/undo/src/keys.ts)): Mod+Z, Mod+Shift+Z, Mod+Y outside macOS, caught before any tool, for the document of the focused tool or else the tool used last (a 3D view takes no focus). Form fields keep the browser's undo of their text.
- **A small API for tools,** e.g. through a provider like `patchwork:focus`: `checkpoint()` where a step ends, `onApplied(patches)` to move the selection to what changed (Loro's `onPush`/`onPop` store cursors with each step for that), and paths that are not undoable (`@comments`, `@patchwork`). Tools drop their own history, as the CAD editor's code pane did.
- **Handles at the document's root.** The manager needs the whole document (`getActorId`, change history); a sub-handle's `doc()` is "the value at the handle's path". A draft swap (`scopeReplaced`) resets the history, as PB's tools do today.

## Open

- Restoring selections after an undo: range selections in CodeMirror, selected shapes in tldraw.
- Steps that span documents, e.g. a tool that edits a model and its view document.
- Which conflict policy feels right.
- List cursors upstream, and reporting the two AM bugs.
