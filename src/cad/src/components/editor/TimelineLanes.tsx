import { For, Show, type JSX } from "solid-js";
import type { Lanes, Link } from "../../model/lanes.ts";
import { LANES, lanePath, lanesHeight, laneTargetAt, linkPath, privateHead, y, type Columns, type LaneTarget } from "./laneGeometry.ts";

/** The data attributes of a node, mirrored from its entry's button, and its collaborator's colour. */
export type NodeData = { [key: `data-${string}`]: string | undefined; style?: JSX.CSSProperties };

/** A port: a half disc on its flat side at `x`, filled for an output, hollow for a private head. */
const portPath = (x: number, cy: number) => `M ${x} ${cy - LANES.port} A ${LANES.port} ${LANES.port} 0 0 1 ${x} ${cy + LANES.port} Z`;

/**
 * One layer of the lanes, the lines or the nodes and ports, of the highlighted lanes or the others;
 * each is drawn once before the marker and once, faded, past it. Links that arrive past the marker,
 * e.g. a copy made there of a body before it, don't exist yet: `links` picks those (`future`) or the
 * others.
 */
function Drawing(props: {
  lanes: Lanes;
  columns: Columns;
  hovered: Set<number>;
  links: "current" | "future";
  marker: number;
  node: (entry: number, version: string) => NodeData;
  returnNode: NodeData;
  layer: "lines" | "ends";
  highlighted: boolean;
}) {
  const l = () => props.lanes;
  const c = () => props.columns;
  const linkLane = (link: Link) => (link.kind === "merge" ? link.from.lane : link.to.lane);
  /** A fork, copy or output that starts a lane past the marker, which is rolled back. */
  const future = (link: Link) => link.kind !== "merge" && props.marker <= c().xs.length && link.to.entry >= props.marker;
  const isHovered = (lane: number) => props.hovered.has(lane);
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
              {(v) => (
                <g class="cad-editor__node" {...props.node(v.entry, v.name)}>
                  <circle class="cad-editor__node-ring" cx={c().xs[v.entry]} cy={y(lane.row)} r={LANES.ring} />
                  <circle class="cad-editor__lane-dot" data-kind={v.kind} data-version={v.name} data-hovered={hovered ? "true" : undefined} cx={c().xs[v.entry]} cy={y(lane.row)} r={LANES.dot} />
                </g>
              )}
            </For>
            <Show when={lane.returned}>
              <g class="cad-editor__node" {...props.returnNode}>
                <circle class="cad-editor__node-ring" cx={c().returnX} cy={y(lane.row)} r={LANES.ring} />
                <path class="cad-editor__lane-port" data-returned="true" data-name={lane.name} data-hovered={hovered ? "true" : undefined} d={portPath(c().returnX - LANES.port / 2, y(lane.row))} />
              </g>
            </Show>
            <Show when={privateHead(lane) && lane.versions.at(-1)}>
              {(head) => <path class="cad-editor__lane-port" data-returned="false" data-name={lane.name} data-hovered={hovered ? "true" : undefined} d={portPath(c().xs[head().entry]! + LANES.dot + 2, y(lane.row))} />}
            </Show>
          </>
        )}
      </For>
    </Show>
  );
  return <>{props.layer === "lines" ? lines(props.highlighted) : ends(props.highlighted)}</>;
}

const LAYERS = [
  { layer: "lines", highlighted: false },
  { layer: "lines", highlighted: true },
  { layer: "ends", highlighted: false },
  { layer: "ends", highlighted: true },
] as const;

/**
 * The lanes beneath the timeline's entries (research/15, "The timeline with lanes"): one per
 * lineage, in rows that are reused once a lane ends, with links where lanes fork, copy, merge and
 * go to the return. Past the marker, they fade as the entries do. An entry's nodes mirror its
 * button, the return's ports the return entry; hovering or clicking one is hovering or clicking
 * that, and a lane its lineage, as in the browser.
 */
export function TimelineLanes(props: {
  lanes: Lanes;
  columns: Columns;
  hovered: Set<number>;
  marker: number;
  node: (entry: number, version: string) => NodeData;
  returnNode: NodeData;
  /** What the pointer is on, and whether a click would pick it, for the cursor. */
  target: LaneTarget | undefined;
  picking: boolean;
  pickable: (version: string) => boolean;
  onHover: (target: LaneTarget | undefined) => void;
  onClick: (target: LaneTarget) => void;
}) {
  const height = () => lanesHeight(props.lanes.rows);
  const id = `cad-lanes-${Math.random().toString(36).slice(2)}`;
  const at = (event: MouseEvent & { currentTarget: SVGRectElement }) => {
    const box = event.currentTarget.getBoundingClientRect();
    return laneTargetAt(props.lanes, props.columns, event.clientX - box.left, event.clientY - box.top);
  };
  const cursor = () => {
    const t = props.target;
    if (!t) return undefined;
    if (!props.picking || t.kind === "return") return "pointer";
    return props.pickable(t.version) ? "crosshair" : "not-allowed";
  };
  return (
    <svg class="cad-editor__lanes" width={props.columns.width} height={height()} data-rows={props.lanes.rows}>
      {/* Only split at the marker: above and below, the rings around nodes may stick out. */}
      <defs>
        <clipPath id={`${id}-before`}>
          <rect x="0" y={-LANES.top} width={Math.max(0, props.columns.pastX)} height={height() + 2 * LANES.top} />
        </clipPath>
        <clipPath id={`${id}-past`}>
          <rect x={props.columns.pastX} y={-LANES.top} width={Math.max(0, props.columns.width - props.columns.pastX)} height={height() + 2 * LANES.top} />
        </clipPath>
      </defs>
      {/* SVG paints in document order: the other lines, the highlighted ones over them, then the nodes and ports over all lines, the highlighted lanes' last. */}
      <For each={LAYERS}>
        {(layer) => (
          <>
            <g clip-path={`url(#${id}-before)`} aria-hidden="true">
              <Drawing {...props} {...layer} links="current" />
            </g>
            <g class="cad-editor__lanes-past" clip-path={`url(#${id}-past)`} aria-hidden="true">
              <Drawing {...props} {...layer} links="current" />
            </g>
            <Show when={layer.layer === "lines"}>
              <g class="cad-editor__lanes-past" aria-hidden="true">
                <Drawing {...props} {...layer} links="future" />
              </g>
            </Show>
          </>
        )}
      </For>
      <line class="cad-editor__lanes-marker" x1={props.columns.markerX} x2={props.columns.markerX} y1="0" y2={height()} />
      {/* Pointer only: the entries' buttons, the return entry and the browser's rows are the same targets for the keyboard. */}
      <rect
        class="cad-editor__lanes-hit"
        x="0"
        y="0"
        width={props.columns.width}
        height={height()}
        style={{ cursor: cursor() }}
        onPointerMove={(event) => props.onHover(at(event))}
        onPointerLeave={() => props.onHover(undefined)}
        onClick={(event) => {
          const target = at(event);
          if (target) props.onClick(target);
        }}
      />
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
