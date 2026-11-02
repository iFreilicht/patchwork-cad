/**
 * What exists at the timeline marker and what this user shows of it (research/15, "Visibility",
 * "The browser"). Before the return, that is every body and sketch no feature has used yet, and
 * every returned version, which is a body of its own; past it, at the end, what main returns. While
 * a field is picked, also what the open feature works on. All of it shows unless the user hides it.
 */
import { createMemo, type Accessor } from "solid-js";
import { lanesAt, type Lanes, type Version } from "../../model/lanes.ts";
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
  /** What its visibility is stored under: `body:<name>` for a body's head, `version:<name>` for a version that is a body of its own: returned, or what the open feature works on. */
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

/** A version that is a body of its own, on lane `lane`: named and kept visible by itself. */
const versionRow = (lane: number, v: Version, visible: (key: string) => boolean): BodyRow => ({ lane, name: v.name, version: v.name, kind: v.kind, key: `version:${v.name}`, visible: visible(`version:${v.name}`) });

/** The returned versions, in the return's order, as rows. */
function returnedRows(l: Lanes, visible: (key: string) => boolean): BodyRow[] {
  return [...l.returned].flatMap((name) => {
    const v = l.versions.get(name);
    const lane = l.laneOf.get(name);
    if (!v || lane === undefined) return [];
    const info = l.lanes[lane]!;
    // A body's head is the body; a version inside it, consumed later, is a body of its own, on its own lane to the return.
    if (info.versions.at(-1) === v && info.merged === undefined) return [{ lane, name: info.name, version: name, kind: v.kind, key: `body:${info.name}`, visible: visible(`body:${info.name}`) }];
    const output = l.lanes.findIndex((x) => x.output && x.name === name);
    return [versionRow(output < 0 ? lane : output, v, visible)];
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
      if (info.output) return versionRow(lane, head, visible);
      const key = `body:${info.name}`;
      return { lane, name: info.name, version: head.name, kind: info.kind === "body" && head.kind === "body" ? "body" : head.kind, key, visible: visible(key) };
    });
  };
  // While something is picked, the view is rolled back to the open feature, and so are the rows;
  // what it works on is there, also a version a feature before it consumed, which it branches from.
  const rows = createMemo(() => {
    const at = editor.pickingAt();
    const out = rowsAt(at ?? editor.marker());
    const l = editor.lanes();
    if (at === undefined || !l) return out;
    const inputs = (editor.open()?.trace?.inputs ?? []).flatMap((name) => {
      const v = l.versions.get(name);
      const lane = l.laneOf.get(name);
      return v && lane !== undefined && !out.some((r) => r.version === name) ? [versionRow(lane, v, visible)] : [];
    });
    return [...out, ...inputs];
  });

  return {
    rows,
    shows: (version) => rows().find((r) => r.version === version)?.visible ?? true,
    setVisible(row, value) {
      ui.setVisibility(row.key, value ? undefined : false);
    },
  };
}
