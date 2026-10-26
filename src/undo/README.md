# @patchwork-cad/undo

Undo and redo as a document's history, per tab, for every tool on it: an undo is a new change that reverts this tab's changes and leaves everyone else's ([research/16](../../research/16-undo-redo.md)).

```ts
import { bindUndo, markUndoBoundaries } from "@patchwork-cad/undo";

const { manager, unbind } = bindUndo(element, handle, { ignore: (path) => String(path[0]).startsWith("@") });
manager.onApplied((patches) => moveSelectionTo(patches));
// In CodeMirror, instead of history():
EditorState.transactionExtender.of((tr) => (markUndoBoundaries(manager, tr), null));
```

- `UndoManager(handle, options)`: `undo()`, `redo()`, `canUndo()`, `canRedo()`, `checkpoint()`, `subscribe()`, `onApplied()`. Options: `groupDelayMs` (500), `adjacentOnly` (true), `conflict` (`"skip"` or `"force"`), `ignore`.
- `invertChanges(backend, hashes, options)`: the inversion, inside a running `change`.
- `bindUndo` / `undoManagerFor`: one history per handle, one keyboard binding for the page.

`pnpm test` runs the scenario, edge cases, the comparison with CodeMirror's history and a fuzz (`FUZZ_SEEDS`, `FUZZ_STEPS` for longer ones); `pnpm bench` times recording and undo in large documents.
