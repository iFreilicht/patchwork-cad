import { For, Show } from "solid-js";
import type { Lane, Lanes, Link } from "../../model/lanes.ts";

/** Geometry of the lanes, in pixels: the first row's centre, the distance between rows, and the radius of a link's bend. */
export const LANES = { top: 5, row: 7, bend: 5, dot: 2.5, port: 3.5 };

/** The height the lanes take beneath the entries. */
export const lanesHeight = (rows: number) => (rows ? LANES.top * 2 + (rows - 1) * LANES.row : 0);

/** Where the timeline's columns are: the centres of its entries and of its return entry, the marker, all within the scrolling timeline. */
export interface Columns {
  xs: number[];
  returnX: number;
  markerX: number;
  /** Where the faded part starts: at the marker, or nowhere when it is at the end, where the return isn't rolled back. */
  pastX: number;
  width: number;
}

const y = (row: number) => LANES.top + row * LANES.row;

/** A link from one row to another: forks, copies and outputs bend at their start, merges at their end. */
function linkPath(l: Lanes, link: Link, c: Columns): string {
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
function lanePath(lane: Lane, c: Columns): string | undefined {
  const first = lane.versions[0];
  const head = lane.versions.at(-1);
  if (!first || !head) return undefined;
  const end = lane.returned ? c.returnX : c.xs[head.entry]!;
  return `M ${c.xs[first.entry]!} ${y(lane.row)} H ${end}`;
}

/** A port: a half disc on its flat side at `x`, filled for an output, hollow for a private head. */
const portPath = (x: number, cy: number) => `M ${x} ${cy - LANES.port} A ${LANES.port} ${LANES.port} 0 0 1 ${x} ${cy + LANES.port} Z`;

/**
 * Everything in the lanes, drawn once before the marker and once, faded, past it. Links that arrive
 * past the marker, e.g. a copy made there of a body before it, don't exist yet: `links` picks those
 * (`future`) or the others.
 */
function Drawing(props: { lanes: Lanes; columns: Columns; hovered: Set<number>; links: "current" | "future"; marker: number }) {
  const l = () => props.lanes;
  const c = () => props.columns;
  const linkLane = (link: Link) => (link.kind === "merge" ? link.from.lane : link.to.lane);
  /** A fork, copy or output that starts a lane past the marker, which is rolled back. */
  const future = (link: Link) => link.kind !== "merge" && props.marker <= c().xs.length && link.to.entry >= props.marker;
  /** Private heads: open, not merged and not returned; a port after them says they leave nothing. */
  const privateHead = (lane: Lane) => !lane.output && !lane.returned && lane.merged === undefined;
  const isHovered = (lane: number) => props.hovered.has(lane);
  // SVG paints in document order: the hovered lanes go last, so that they cross over the others.
  const lines = (hovered: boolean) => (
    <>
      <For each={l().links.filter((link) => future(link) === (props.links === "future") && isHovered(linkLane(link)) === hovered)}>
        {(link) => <path class="cad-editor__lane" data-link={link.kind} data-hovered={hovered ? "true" : undefined} d={linkPath(l(), link, c())} />}
      </For>
      <Show when={props.links !== "future"}>
        <For each={l().lanes.flatMap((lane, i) => (isHovered(i) === hovered ? [lane] : []))}>
          {(lane) => <Show when={lanePath(lane, c())}>{(d) => <path class="cad-editor__lane" data-kind={lane.kind} data-name={lane.name} data-hovered={hovered ? "true" : undefined} d={d()} />}</Show>}
        </For>
      </Show>
    </>
  );
  const ends = (hovered: boolean) => (
    <Show when={props.links !== "future"}>
      <For each={l().lanes.flatMap((lane, i) => (isHovered(i) === hovered ? [lane] : []))}>
        {(lane) => (
          <>
            <For each={lane.versions}>
              {(v) => <circle class="cad-editor__lane-dot" data-kind={v.kind} data-version={v.name} data-hovered={hovered ? "true" : undefined} cx={c().xs[v.entry]} cy={y(lane.row)} r={LANES.dot} />}
            </For>
            <Show when={lane.returned}>
              <path class="cad-editor__lane-port" data-returned="true" data-name={lane.name} data-hovered={hovered ? "true" : undefined} d={portPath(c().returnX - LANES.port / 2, y(lane.row))} />
            </Show>
            <Show when={privateHead(lane) && lane.versions.at(-1)}>
              {(head) => <path class="cad-editor__lane-port" data-returned="false" data-name={lane.name} data-hovered={hovered ? "true" : undefined} d={portPath(c().xs[head().entry]! + LANES.dot + 2, y(lane.row))} />}
            </Show>
          </>
        )}
      </For>
    </Show>
  );
  return (
    <>
      {lines(false)}
      {ends(false)}
      {lines(true)}
      {ends(true)}
    </>
  );
}

/**
 * The lanes beneath the timeline's entries (research/15, "The timeline with lanes"): one per
 * lineage, in rows that are reused once a lane ends, with links where lanes fork, copy, merge and
 * go to the return. Past the marker, they fade as the entries do.
 */
export function TimelineLanes(props: { lanes: Lanes; columns: Columns; hovered: Set<number>; marker: number }) {
  const height = () => lanesHeight(props.lanes.rows);
  const id = `cad-lanes-${Math.random().toString(36).slice(2)}`;
  return (
    <svg class="cad-editor__lanes" width={props.columns.width} height={height()} aria-hidden="true" data-rows={props.lanes.rows}>
      <defs>
        <clipPath id={`${id}-before`}>
          <rect x="0" y="0" width={Math.max(0, props.columns.pastX)} height={height()} />
        </clipPath>
        <clipPath id={`${id}-past`}>
          <rect x={props.columns.pastX} y="0" width={Math.max(0, props.columns.width - props.columns.pastX)} height={height()} />
        </clipPath>
      </defs>
      <g clip-path={`url(#${id}-before)`}>
        <Drawing lanes={props.lanes} columns={props.columns} hovered={props.hovered} links="current" marker={props.marker} />
      </g>
      <g class="cad-editor__lanes-past" clip-path={`url(#${id}-past)`}>
        <Drawing lanes={props.lanes} columns={props.columns} hovered={props.hovered} links="current" marker={props.marker} />
      </g>
      <g class="cad-editor__lanes-past">
        <Drawing lanes={props.lanes} columns={props.columns} hovered={props.hovered} links="future" marker={props.marker} />
      </g>
      <line class="cad-editor__lanes-marker" x1={props.columns.markerX} x2={props.columns.markerX} y1="0" y2={height()} />
    </svg>
  );
}

/** The return entry's glyph: the port that the lanes of the returned versions end in. */
export const ReturnGlyph = () => <PortGlyph />;
const PortGlyph = () => (
  <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true" class="cad-editor__glyph">
    <path d="M1 1 A 5 5 0 0 1 1 11 Z" fill="currentColor" />
  </svg>
);
