/**
 * What exists at the timeline marker and what this user shows of it (research/15, "Visibility",
 * "The browser"). Before the return, that is every body and sketch no feature has used yet; past
 * it, at the end, what main returns. All of it shows unless the user hides it.
 */
import { createMemo, type Accessor } from "solid-js";
import { lanesAt, type Lanes } from "../../model/lanes.ts";
import type { UiState } from "../uiState.ts";
import type { Editor } from "./state.ts";

/** A body (or a sketch) that exists at the marker, by its version there. */
export interface BodyRow {
  lane: number;
  /** The body's name, its first body version's. */
  name: string;
  /** Its version at the marker. */
  version: string;
  kind: "body" | "sketch";
  /** What its visibility is stored under: `body:<name>` for a body's head, `version:<name>` for a returned version inside a body. */
  key: string;
  visible: boolean;
}

export interface Bodies {
  /** The rows at the timeline marker, or before the open feature while something is picked. */
  rows: Accessor<BodyRow[]>;
  /** Whether a version that exists at the marker shows; false hides it. */
  shows(version: string): boolean;
  /** Shows or hides a row's body. */
  setVisible(row: BodyRow, visible: boolean): void;
}

/** The returned versions, in the return's order, as rows. */
function returnedRows(l: Lanes, visible: (key: string) => boolean): BodyRow[] {
  return [...l.returned].flatMap((name) => {
    const v = l.versions.get(name);
    const lane = l.laneOf.get(name);
    if (!v || lane === undefined) return [];
    const info = l.lanes[lane]!;
    // A body's head is the body; a version inside it, consumed later, is an output of its own.
    const key = info.versions.at(-1) === v && info.merged === undefined ? `body:${info.name}` : `version:${name}`;
    return [{ lane, name: info.name, version: name, kind: v.kind, key, visible: visible(key) }];
  });
}

export function createBodies(editor: Editor, ui: Pick<UiState, "visibility" | "setVisibility">): Bodies {
  const visible = (key: string) => ui.visibility()[key] ?? true;

  const rowsAt = (marker: number): BodyRow[] => {
    const l = editor.lanes();
    if (!l) return [];
    if (marker > editor.timeline().entries.length) return returnedRows(l, visible);
    return lanesAt(l, marker).map(({ lane, head }) => {
      const info = l.lanes[lane]!;
      const key = `body:${info.name}`;
      return { lane, name: info.name, version: head.name, kind: info.kind === "body" && head.kind === "body" ? "body" : head.kind, key, visible: visible(key) };
    });
  };
  // While something is picked, the view is rolled back to the open feature, and so are the rows.
  const rows = createMemo(() => rowsAt(editor.pickingAt() ?? editor.marker()));

  return {
    rows,
    shows: (version) => rows().find((r) => r.version === version)?.visible ?? true,
    setVisible(row, value) {
      ui.setVisibility(row.key, value ? undefined : false);
    },
  };
}
