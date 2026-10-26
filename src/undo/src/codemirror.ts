import type { UndoManager } from "./manager.ts";

/** The part of a CodeMirror `Transaction` used here, so that this package doesn't depend on CodeMirror. */
interface Transaction {
  docChanged: boolean;
  isUserEvent(event: string): boolean;
}

const USER_EVENTS = ["input", "delete", "move", "select", "undo", "redo"];

/**
 * Ends undo steps where CodeMirror's history would (`@codemirror/commands`, `HistoryState.addChanges`):
 * after a selection the user made, and before a change that isn't typing or deleting (a paste, a
 * drop, a completion); typing right after it joins it. Call it for every transaction, e.g. from a
 * `transactionExtender`.
 */
export function markUndoBoundaries(manager: Pick<UndoManager<unknown>, "checkpoint">, tr: Transaction): void {
  if (!USER_EVENTS.some((e) => tr.isUserEvent(e))) return;
  if (tr.docChanged ? !tr.isUserEvent("input.type") && !tr.isUserEvent("delete") : tr.isUserEvent("select")) manager.checkpoint();
}
