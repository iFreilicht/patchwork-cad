export { invertChanges, follow, type ConflictPolicy, type InvertOptions, type InvertReport } from "./invert.ts";
export { UndoManager, type UndoableHandle, type UndoOptions } from "./manager.ts";
export { bindUndo, undoManagerFor } from "./keys.ts";
export { markUndoBoundaries } from "./codemirror.ts";
