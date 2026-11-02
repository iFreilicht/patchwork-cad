/**
 * Bodies as lineages of versions (research/15, "Bodies and lineages"), derived from the code: a
 * feature's result is a version, and a feature that works on a version continues its lineage. The
 * timeline draws each lineage as a lane beneath its entries ("The timeline with lanes"), the
 * browser lists them, and visibility is kept per lineage.
 */
import type { Graph, Use } from "./deps.ts";
import type { Timeline } from "./timeline.ts";

export interface Version {
  name: string;
  /** The timeline entry that declares it: its column. */
  entry: number;
  kind: "body" | "sketch";
}

/** How a lane joins another one: a fork or a copy (`move`) starts it, a merge (a tool, a sketch) or an output (the return) ends it. */
export interface Link {
  kind: "fork" | "copy" | "merge" | "output";
  /** The version it leaves from, its lane and column. */
  from: { lane: number; entry: number };
  /** The lane and column it arrives at; an output arrives at the return, column `entries.length`. */
  to: { lane: number; entry: number };
}

export interface Lane {
  /** The body's name, that of its first body version (research/15); a sketch's own if it has none. */
  name: string;
  kind: "body" | "sketch";
  versions: Version[];
  /** The link that starts it, if it forks or copies another lane's version. */
  from: Link | undefined;
  /** The entry it merges into, if its head is used as a tool, by a feature with a target, or by Custom Script code. */
  merged: number | undefined;
  /** Whether `main` returns its head. */
  returned: boolean;
  /** Its row beneath the timeline; rows are reused once a lane ends. */
  row: number;
  /** The columns it occupies: from its link's origin or its first version to its merge, the return or its head. */
  start: number;
  stop: number;
  /** A lane of its own for an output link (a returned version that isn't a head), not a lineage. */
  output?: boolean;
}

export interface Lanes {
  lanes: Lane[];
  links: Link[];
  /** The lane of each version, by name. */
  laneOf: Map<string, number>;
  /** All versions by name. */
  versions: Map<string, Version>;
  /** The names `main` returns. */
  returned: Set<string>;
  rows: number;
}

/** A use by a feature that carries a version on: its continuation, a merge, or a copy. */
interface Flow {
  version: string;
  owner: number;
  kind: "continue" | "merge" | "copy";
}

/** The names an entry declares that are versions: a feature's results, and a Custom Script's names that features use as bodies or sketches or that `main` returns. */
function versionsOf(tl: Timeline, g: Graph): Version[] {
  const used = new Map<string, "body" | "sketch">();
  for (const u of g.uses) if (u.role !== "hard" || u.key === "sketch") used.set(u.name, u.key === "sketch" ? "sketch" : (used.get(u.name) ?? "body"));
  return tl.entries.flatMap((entry, index): Version[] => {
    if (entry.kind === "feature") return entry.names.map((name) => ({ name, entry: index, kind: entry.type === "sketch" ? "sketch" : "body" }));
    return (g.declares[index] ?? []).flatMap((name) => {
      const kind = used.get(name);
      return kind ? [{ name, entry: index, kind }] : [];
    });
  });
}

function flowsOf(tl: Timeline, g: Graph, versions: Map<string, Version>): Flow[] {
  const consumes = new Set(g.uses.filter((u) => u.role === "consume").map((u) => u.owner));
  const declaresVersion = new Set([...versions.values()].map((v) => v.entry));
  const flow = (u: Use): Flow["kind"] | undefined => {
    const owner = tl.entries[u.owner];
    // Custom Script code that uses a version carries it on, as far as anyone can tell, into what it declares (M3's `let body = upright`), or ends it.
    if (owner?.kind === "script") return declaresVersion.has(u.owner) ? "continue" : "merge";
    if (owner?.kind !== "feature") return undefined;
    if (u.role === "consume") return "continue";
    if (u.role === "tool") return "merge";
    if (u.role === "read" && owner.type === "move") return "copy";
    // A sketch becomes the body a new extrusion makes; one that joins or cuts merges it into its target.
    if (u.role === "hard" && u.key === "sketch" && owner.type === "extrude") return consumes.has(u.owner) ? "merge" : "continue";
    return undefined;
  };
  return g.uses.flatMap((u) => {
    const kind = versions.has(u.name) ? flow(u) : undefined;
    return kind ? [{ version: u.name, owner: u.owner, kind }] : [];
  });
}

/**
 * The lanes of a timeline. A version that several features continue forks: the continuation with
 * the longest chain after it keeps the lane, the earliest on a tie (which one should, is open in
 * research/15). Rows go to lanes in the order they start, each to the first row that is free.
 */
export function lanes(tl: Timeline, g: Graph): Lanes {
  const n = tl.entries.length;
  const all = versionsOf(tl, g);
  const versions = new Map(all.map((v) => [v.name, v]));
  const flows = flowsOf(tl, g, versions);
  const returned = new Set(g.uses.filter((u) => u.role === "return").map((u) => u.name));
  /** The first version an entry declares, which continues the lane it works on. */
  const firstOf = (entry: number) => all.find((v) => v.entry === entry);

  // How long the chain after each version is, latest first, to choose the continuation that keeps a lane.
  const length = new Map<string, number>();
  const continuations = (name: string) => flows.filter((f) => f.version === name && f.kind === "continue" && firstOf(f.owner));
  for (const v of [...all].reverse()) length.set(v.name, 1 + Math.max(0, ...continuations(v.name).map((f) => length.get(firstOf(f.owner)!.name) ?? 0)));
  const kept = new Map<string, number>();
  const byScript = (f: Flow) => (tl.entries[f.owner]?.kind === "script" ? 1 : 0);
  for (const v of all) {
    // A feature's continuation before one in a Custom Script, which may only refer to the version.
    const best = continuations(v.name).sort((a, b) => byScript(a) - byScript(b) || (length.get(firstOf(b.owner)!.name) ?? 0) - (length.get(firstOf(a.owner)!.name) ?? 0) || a.owner - b.owner)[0];
    if (best) kept.set(v.name, best.owner);
  }

  const out: Lane[] = [];
  const links: Link[] = [];
  const laneOf = new Map<string, number>();
  for (const v of all) {
    const incoming = flows.filter((f) => f.owner === v.entry && (f.kind === "continue" || f.kind === "copy") && firstOf(v.entry) === v);
    const continued = incoming.find((f) => f.kind === "continue" && kept.get(f.version) === v.entry);
    if (continued && laneOf.has(continued.version)) {
      const lane = laneOf.get(continued.version)!;
      out[lane]!.versions.push(v);
      laneOf.set(v.name, lane);
      continue;
    }
    const lane = out.length;
    const source = incoming[0];
    const from = source && laneOf.has(source.version) ? { kind: source.kind === "copy" ? ("copy" as const) : ("fork" as const), from: { lane: laneOf.get(source.version)!, entry: versions.get(source.version)!.entry }, to: { lane, entry: v.entry } } : undefined;
    if (from) links.push(from);
    out.push({ name: v.name, kind: v.kind, versions: [v], from, merged: undefined, returned: false, row: 0, start: from?.from.entry ?? v.entry, stop: v.entry });
    laneOf.set(v.name, lane);
  }

  for (const [index, lane] of out.entries()) {
    const head = lane.versions.at(-1)!;
    lane.stop = head.entry;
    lane.name = lane.versions.find((v) => v.kind === "body")?.name ?? lane.versions[0]!.name;
    if (lane.versions.some((v) => v.kind === "body")) lane.kind = "body";
    const merges = flows.filter((f) => f.version === head.name && f.kind === "merge").sort((a, b) => a.owner - b.owner);
    const into = merges[0];
    if (into) {
      const target = firstOf(into.owner);
      lane.merged = into.owner;
      lane.stop = into.owner;
      if (target && laneOf.has(target.name)) links.push({ kind: "merge", from: { lane: index, entry: head.entry }, to: { lane: laneOf.get(target.name)!, entry: into.owner } });
    }
    lane.returned = returned.has(head.name) && !into;
    if (lane.returned) lane.stop = n;
    // A version merged into more than one feature, or into one before its lane ends: a link for each further merge.
    for (const v of lane.versions)
      for (const f of flows.filter((f) => f.version === v.name && f.kind === "merge" && f !== into)) {
        const target = firstOf(f.owner);
        if (target && laneOf.has(target.name)) links.push({ kind: "merge", from: { lane: index, entry: v.entry }, to: { lane: laneOf.get(target.name)!, entry: f.owner } });
      }
  }

  // A returned version that isn't an open head goes to the return on a lane of its own.
  for (const v of all) {
    const lane = out[laneOf.get(v.name)!]!;
    if (!returned.has(v.name) || (lane.returned && lane.versions.at(-1) === v)) continue;
    const index = out.length;
    const link: Link = { kind: "output", from: { lane: laneOf.get(v.name)!, entry: v.entry }, to: { lane: index, entry: n } };
    links.push(link);
    out.push({ name: v.name, kind: v.kind, versions: [], from: link, merged: undefined, returned: true, row: 0, start: v.entry, stop: n, output: true });
  }

  // Rows: each lane, in the order lanes start, gets the first row whose last lane ended before it
  // starts. A lane ends in a merge's bend or a port, so the next one in its row doesn't read as its continuation.
  const ends: number[] = [];
  for (const lane of [...out].sort((a, b) => a.start - b.start || out.indexOf(a) - out.indexOf(b))) {
    const row = ends.findIndex((end) => end < lane.start);
    lane.row = row < 0 ? ends.length : row;
    ends[lane.row] = lane.stop;
  }
  return { lanes: out, links, laneOf, versions, returned, rows: ends.length };
}

/** The lanes that exist at timeline marker `marker`, with their head there: started before it and not merged before it. */
export function lanesAt(l: Lanes, marker: number): { lane: number; head: Version }[] {
  return l.lanes.flatMap((lane, index) => {
    if (lane.output || (lane.merged !== undefined && lane.merged < marker)) return [];
    const head = lane.versions.filter((v) => v.entry < marker).at(-1);
    return head ? [{ lane: index, head }] : [];
  });
}
