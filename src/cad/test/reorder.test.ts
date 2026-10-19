/**
 * Moving and inserting features Fusion-style (research/07, "Reordering", "The timeline marker"):
 * the dependency ranges the timeline allows, the text a move or insert writes, and that the result
 * still builds with every reference resolved (run directly, a broken reference throws).
 */
import { readFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { measureVolume } from "replicad";
import { beforeAll, expect, test } from "vitest";
import * as features from "@patchwork-cad/features";
import { loadOC } from "../../features/test/oc.ts";
import { analyze } from "../src/model/analyze.ts";
import { allowedRange, canMove, graph, relations } from "../src/model/deps.ts";
import { apply, insertFeatureAt, moveEntry, type Edit } from "../src/model/splice.ts";
import { markerPosition, timeline } from "../src/model/timeline.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(loadOC);

const example = (name: string) => readFileSync(new URL(`../../features/examples/${name}.js`, import.meta.url), "utf8");
const tlOf = (source: string) => timeline(source, analyze(source), []);
const indexOf = (source: string, name: string) => tlOf(source).entries.findIndex((e) => e.kind === "feature" && e.name === name);
const names = (source: string) => tlOf(source).entries.map((e) => (e.kind === "feature" ? e.name : "script"));

function edit(source: string, edits: (a: ReturnType<typeof analyze>) => Edit[]): string {
  let doc = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  const handle = { change: (fn: (d: CadModelDoc) => void) => (doc = A.change(doc, fn)) } as unknown as DocHandle<CadModelDoc>;
  apply(handle, edits(analyze(source)));
  return doc.source;
}

const move = (source: string, name: string, position: number) => edit(source, (a) => moveEntry(source, a, tlOf(source), indexOf(source, name), position));

/** Runs a model directly with the feature library, as a plain module would (strict: broken references throw). */
function run(source: string): features.Body {
  const body = source
    .replace(/^import \{([^}]*)\} from "@patchwork-cad\/features";$/m, "const {$1} = features;")
    .replace("export const defaultParams", "const defaultParams")
    .replace("export default function main", "function main");
  const result = new Function("features", `${body}\nreturn main(defaultParams);`)(features) as unknown;
  expect(result).toBeInstanceOf(features.Body);
  return result as features.Body;
}
const volume = (b: features.Body) => measureVolume(b.shape as Parameters<typeof measureVolume>[0]);

test("M1's dependency ranges: a chain link doesn't bound a move, a reference does", () => {
  const source = example("m1");
  const g = graph(analyze(source), tlOf(source));
  // chamfer1 works on fillet1 (a chain link) and refers to extrude1 and notch.
  expect(allowedRange(g, indexOf(source, "chamfer1"))).toMatchObject({ min: indexOf(source, "fillet1"), max: 8 });
  expect(canMove(g, indexOf(source, "chamfer1"), indexOf(source, "fillet1"))).toBe(true);
  expect(canMove(g, indexOf(source, "chamfer1"), indexOf(source, "notch"))).toBe(false);
  // sketch2 is used by notch only, so it can go before extrude1 but not after notch.
  expect(canMove(g, indexOf(source, "sketch2"), indexOf(source, "extrude1"))).toBe(true);
  expect(canMove(g, indexOf(source, "sketch2"), indexOf(source, "fillet1"))).toBe(false);
  // extrude1 creates the body; notch cuts it, which a move can't rewire.
  expect(allowedRange(g, indexOf(source, "extrude1")).max).toBe(indexOf(source, "notch"));
  expect(relations(g, indexOf(source, "fillet1"))).toEqual([
    { index: 1, relation: "dependency", link: "hard", names: ["extrude1"] },
    // body: notch is a chain link, but notch.side.c is a reference, which makes the link hard.
    { index: 3, relation: "dependency", link: "hard", names: ["notch"] },
    { index: 5, relation: "dependent", link: "chain", names: ["fillet1"] },
  ]);
});

test("moving the chamfer before the fillet rewires the chain", () => {
  const source = example("m1");
  const out = move(source, "chamfer1", indexOf(source, "fillet1"));
  expect(names(out)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "fillet1", "sketch3", "extrude2"]);
  expect(out).toContain("const chamfer1 = chamfer({ body: notch, ");
  expect(out).toContain("const fillet1 = fillet({ body: chamfer1, ");
  expect(out).toContain("const sketch3 = sketch({ body: fillet1, ");
  expect(out).toContain('operation: "join", target: fillet1 });');
  // The chamfer meets the notch's fillet (research/07, "The reference syntax"), so the order changes the part a little.
  expect(Math.abs(volume(run(out)) / volume(run(source)) - 1)).toBeLessThan(1e-3);
  // And back: the original text.
  expect(move(out, "chamfer1", indexOf(out, "sketch3"))).toBe(source);
});

test("moving a feature to the end makes the return show it", () => {
  const source = example("m1");
  const out = move(source, "chamfer1", 8);
  expect(names(out).at(-1)).toBe("chamfer1");
  expect(out).toContain("const chamfer1 = chamfer({ body: extrude2, ");
  expect(out).toContain("target: fillet1 });");
  expect(out).toContain("return chamfer1;");
  run(out);
});

test("a sketch moves without rewiring anything but its plane's body", () => {
  const source = example("m1");
  const out = move(source, "sketch2", indexOf(source, "extrude1"));
  expect(names(out).slice(0, 3)).toEqual(["sketch1", "sketch2", "extrude1"]);
  expect(volume(run(out))).toBeCloseTo(volume(run(source)), 6);
  const moved = move(source, "sketch3", indexOf(source, "fillet1"));
  expect(moved).toContain("const sketch3 = sketch({ body: notch, ");
  expect(moved).toContain("const extrude2 = extrude({ sketch: sketch3, distance: 4, operation: \"join\", target: chamfer1 });");
  run(moved);
});

test("M3: a shorthand body keeps its key, and nothing moves before the loop that makes it", () => {
  const source = example("m3");
  const g = graph(analyze(source), tlOf(source));
  const script = names(source).indexOf("script");
  expect(allowedRange(g, indexOf(source, "fillet1")).min).toBe(script + 1);
  const out = move(source, "chamfer1", indexOf(source, "fillet1"));
  expect(out).toContain("const chamfer1 = chamfer({ body: body, ");
  expect(out).toContain("const fillet1 = fillet({ body: chamfer1, ");
  expect(out).toContain("const sketch3 = sketch({ body: fillet1, ");
  run(out);
});

test("a fillet inserted before the chamfer goes into the chain", () => {
  const source = example("m1");
  const position = indexOf(source, "chamfer1");
  const out = edit(source, (a) => insertFeatureAt(source, a, tlOf(source), "fillet2", "fillet({ body: fillet1, edges: [edge(extrude1.start, extrude1.side.front)], radius: 1 })", position, { consumes: "fillet1", shows: true }));
  expect(names(out).slice(4, 7)).toEqual(["fillet1", "fillet2", "chamfer1"]);
  expect(out).toContain("  const fillet2 = fillet({ body: fillet1, edges: [edge(extrude1.start, extrude1.side.front)], radius: 1 });\n  const chamfer1 = chamfer({ body: fillet2, ");
  expect(out).toContain("return extrude2;");
  expect(volume(run(out))).toBeLessThan(volume(run(source)));
});

test("the marker stays between the surviving entries when entries on both sides are deleted at once", () => {
  const source = example("m1");
  const doc = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  // The marker sits between chamfer1 and sketch3: its cursor is on sketch3's first character.
  const tl = tlOf(source);
  const cursor = A.getCursor(doc, ["source"], tl.entries[indexOf(source, "sketch3")]!.span.start, "after");
  // Another user deletes notch, fillet1 and chamfer1 before the marker and sketch3 after it.
  const lineOf = (name: string) => {
    const e = tl.entries[indexOf(source, name)]!.span;
    return { start: source.lastIndexOf("\n", e.start) + 1, end: source.indexOf("\n", e.end) + 1 };
  };
  const doomed = ["notch", "fillet1", "chamfer1", "sketch3"].map(lineOf).sort((a, b) => b.start - a.start);
  const edited = A.change(doc, (d) => doomed.forEach((l) => A.splice(d, ["source"], l.start, l.end - l.start)));
  const after = tlOf(edited.source);
  const position = markerPosition(after, A.getCursorPosition(edited, ["source"], cursor), "sketch3");
  expect(names(edited.source)[position - 1]).toBe("sketch2");
  expect(names(edited.source)[position]).toBe("extrude2");
  // When the whole text is replaced, the cursor is lost and the marker falls back to the next entry's name.
  const replaced = A.change(A.clone(doc), (d) => (d.source = source));
  expect(() => A.getCursorPosition(replaced, ["source"], cursor)).toThrow();
  expect(markerPosition(tlOf(source), undefined, "sketch3")).toBe(indexOf(source, "sketch3"));
});

/**
 * Experiment for research/07, "Reordering": a move is one change that deletes the statement and
 * inserts its text elsewhere, so it merges with concurrent edits like any delete and insert.
 */
test("concurrent edits and moves merge as deletes and inserts of text", () => {
  const source = example("m1");
  const base = A.from({ title: "t", source }) as A.Doc<CadModelDoc>;
  const change = (doc: A.Doc<CadModelDoc>, edits: Edit[]) =>
    A.change(doc, (d) => [...edits].sort((x, y) => y.start - x.start).forEach((e) => A.splice(d, ["source"], e.start, e.end - e.start, e.text)));
  const moveIn = (doc: A.Doc<CadModelDoc>, name: string, position: number) => change(A.clone(doc), moveEntry(doc.source, analyze(doc.source), tlOf(doc.source), indexOf(doc.source, name), position));
  const parses = (text: string) => {
    try {
      analyze(text);
      return true;
    } catch {
      return false;
    }
  };

  // A moves chamfer1 before fillet1 while B changes chamfer1's distance: B's insertion survives the
  // deletion of the text around it, so it is left behind where the statement was, and the code doesn't parse.
  const moved = moveIn(base, "chamfer1", indexOf(source, "fillet1"));
  const edited = A.change(A.clone(base), (d) => A.splice(d, ["source"], source.indexOf("distance: 1 })"), "distance: 1".length, "distance: 2"));
  const orphaned = A.merge(A.clone(moved), edited).source;
  expect(orphaned).toContain("radius: 1.5 });\ndistance: 2  const sketch3");
  expect(orphaned).toContain("const chamfer1 = chamfer({ body: notch, edges: [edge(extrude1.end, extrude1.side.front).piece(notch, 1, { near: [49.75, 0, 20] })], distance: 1 });");
  expect(parses(orphaned)).toBe(false);

  // A and B move chamfer1 at once: its statement is there twice, a redeclared const that doesn't parse.
  const elsewhere = moveIn(base, "chamfer1", 8);
  const both = A.merge(moveIn(base, "chamfer1", indexOf(source, "fillet1")), elsewhere).source;
  expect(both.match(/const chamfer1 =/g)).toHaveLength(2);
  expect(parses(both)).toBe(false);

  // A moves chamfer1 while B edits another feature: both arrive.
  const other = A.change(A.clone(base), (d) => A.splice(d, ["source"], source.indexOf("radius: 1.5"), "radius: 1.5".length, "radius: 2"));
  const merged = A.merge(moveIn(base, "chamfer1", indexOf(source, "fillet1")), other).source;
  expect(merged).toBe(moved.source.replace("radius: 1.5", "radius: 2"));
  run(merged);
});
