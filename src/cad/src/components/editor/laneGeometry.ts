/** Where the lanes beneath the timeline's entries go (research/15, "The timeline with lanes"), and what the pointer is on there. */
import type { Lane, Lanes, Link } from "../../model/lanes.ts";

/**
 * Geometry of the lanes, in pixels: the first row's centre, the space beneath the last one, the
 * distance between rows, the radius of a link's bend, of a node and of the ring around it, a port's,
 * and how far from a node's centre the pointer is on it. The ring hugs the node, so that it fuses
 * with an open entry's outline above it.
 */
export const LANES = { top: 8, bottom: 5, row: 7, bend: 5, dot: 2.5, ring: 4, port: 3.5, hit: 8 };

/** What the pointer is on in the lanes: an entry's node, which stands for one of its versions, a port of the return, or a lane, by the version of the segment. */
export type LaneTarget = { kind: "entry"; entry: number; version: string } | { kind: "return" } | { kind: "lane"; lane: number; version: string };

/** The height the lanes take beneath the entries. */
export const lanesHeight = (rows: number) => (rows ? LANES.top + LANES.bottom + (rows - 1) * LANES.row : 0);

/** Where the timeline's columns are: the centres of its entries and of its return entry, the marker, all within the scrolling timeline. */
export interface Columns {
  xs: number[];
  returnX: number;
  markerX: number;
  /** Where the faded part starts: at the marker, or nowhere when it is at the end, where the return isn't rolled back. */
  pastX: number;
  width: number;
}

export const y = (row: number) => LANES.top + row * LANES.row;

/** A link from one row to another: forks, copies and outputs bend at their start, merges at their end. */
export function linkPath(l: Lanes, link: Link, c: Columns): string {
  const n = c.xs.length;
  const x = (entry: number) => (entry >= n ? c.returnX : c.xs[entry]!);
  const x1 = x(link.from.entry);
  const x2 = x(link.to.entry);
  const y1 = y(l.lanes[link.from.lane]!.row);
  const y2 = y(l.lanes[link.to.lane]!.row);
  const r = Math.max(0, Math.min(LANES.bend, (x2 - x1) / 2));
  if (link.kind === "merge") return `M ${x1} ${y1} H ${x2 - 2 * r} C ${x2 - r} ${y1}, ${x2 - r} ${y2}, ${x2} ${y2}`;
  return `M ${x1} ${y1} C ${x1 + r} ${y1}, ${x1 + r} ${y2}, ${x1 + 2 * r} ${y2} H ${x2}`;
}

/** A lane's own line: from its first version to its head, or on to the return. */
export function lanePath(lane: Lane, c: Columns): string | undefined {
  const first = lane.versions[0];
  const head = lane.versions.at(-1);
  if (!first || !head) return undefined;
  const end = lane.returned ? c.returnX : c.xs[head.entry]!;
  return `M ${c.xs[first.entry]!} ${y(lane.row)} H ${end}`;
}

/** Private heads: open, not merged and not returned; a port after them says they leave nothing. */
export const privateHead = (lane: Lane) => !lane.output && !lane.returned && lane.merged === undefined;

/**
 * What is at `x`, `y` in the lanes: within `LANES.hit` of a node or a port, that; else the lane in
 * the nearest row, as rows are too close to aim at, by the version its segment there stands for.
 * The lane of a returned version that isn't a head stands for its lineage.
 */
export function laneTargetAt(l: Lanes, c: Columns, x: number, y: number): LaneTarget | undefined {
  if (!l.rows) return undefined;
  const row = Math.min(l.rows - 1, Math.max(0, Math.round((y - LANES.top) / LANES.row)));
  const inRow = l.lanes.flatMap((lane, i) => (lane.row === row ? [{ lane, i }] : []));
  let best: { target: LaneTarget; dx: number } | undefined;
  const consider = (target: LaneTarget, at: number) => {
    const dx = Math.abs(at - x);
    if (dx <= LANES.hit && (!best || dx < best.dx)) best = { target, dx };
  };
  for (const { lane } of inRow) {
    for (const v of lane.versions) consider({ kind: "entry", entry: v.entry, version: v.name }, c.xs[v.entry]!);
    if (lane.returned) consider({ kind: "return" }, c.returnX);
  }
  if (best) return best.target;
  const column = (entry: number) => (entry >= c.xs.length ? c.returnX : c.xs[entry]!);
  const on = inRow.find(({ lane }) => column(lane.start) <= x && x <= column(lane.stop) + (privateHead(lane) ? LANES.dot + 2 + LANES.port : 0));
  if (!on) return undefined;
  if (on.lane.output) return { kind: "lane", lane: on.lane.from!.from.lane, version: on.lane.name };
  const version = on.lane.versions.filter((v) => c.xs[v.entry]! <= x).at(-1) ?? on.lane.versions[0]!;
  return { kind: "lane", lane: on.i, version: version.name };
}
