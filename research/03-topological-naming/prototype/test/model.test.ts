import { beforeAll, describe as group, expect, test } from "vitest";
import { describeFace } from "../src/geom.ts";
import { build, type Feature, type State } from "../src/model.ts";
import { loadOC, type Shape } from "../src/oc.ts";

beforeAll(loadOC);

const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const rect = (w: number, h: number) => ({
  kind: "polygon" as const,
  points: [[0, 0], [w, 0], [w, h], [0, h]] as [number, number][],
  segments: ["front", "right", "back", "left"],
});

const names = (s: State) => s.faceNames.map((n) => [...n].sort().join("+")).sort();
/** Resolver that picks faces/edges by name, for tests of the runner itself. */
const byName = (want: Record<string, (s: State) => Shape[]>) => (slot: string, s: State) => want[slot]!(s);
const faceNamed = (s: State, n: string) => s.faces.filter((_, i) => s.faceNames[i]!.has(n));

group("lineage naming", () => {
  test("extrude names sides by segment and caps by start/end", () => {
    const m = build([{ id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 20, op: "new" }], () => []);
    const s = m.states[1]!;
    expect(names(s)).toEqual(["f1.end", "f1.side(back)", "f1.side(front)", "f1.side(left)", "f1.side(right)", "f1.start"]);
    expect(s.unnamed).toBe(0);
    expect(describeFace(faceNamed(s, "f1.end")[0]!).centroid[2]).toBeCloseTo(20);
    const front = describeFace(faceNamed(s, "f1.side(front)")[0]!).dir!;
    expect(front[1]).toBeCloseTo(-1);
  });

  test("a notch cut splits the front face; both pieces keep the name", () => {
    const features: Feature[] = [
      { id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 20, op: "new" },
      { id: "f2", type: "extrude", plane: { ...XY, origin: [30, 0, 20] }, profile: { kind: "circle", center: [0, 0], radius: 8, segment: "c" }, distance: 20, op: "cut" },
    ];
    const s = build(features, () => []).states[2]!;
    expect(s.unnamed).toBe(0);
    expect(faceNamed(s, "f1.side(front)")).toHaveLength(2);
    expect(faceNamed(s, "f2.side(c)")).toHaveLength(1);
  });

  test("history names record which operation split a face, and new edges are named by adjacency", () => {
    const features: Feature[] = [
      { id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 20, op: "new" },
      { id: "f2", type: "extrude", plane: { ...XY, origin: [30, 0, 20] }, profile: { kind: "circle", center: [0, 0], radius: 8, segment: "c" }, distance: 20, op: "cut" },
    ];
    const s = build(features, () => []).states[2]!;
    const hist = s.faceHist.map((n) => [...n].join("+")).sort();
    expect(hist).toContain("f1.side(front)/f2#1");
    expect(hist).toContain("f1.side(front)/f2#2");
    const edgeHist = s.edgeHist.map((n) => [...n].join("+"));
    // The front-top edge was split by the notch, too.
    expect(edgeHist.filter((n) => n.startsWith("edge(f1.end | f1.side(front))/f2#"))).toHaveLength(2);
  });

  test("fuse of flush bodies merges coplanar faces into one face with both names", () => {
    const features: Feature[] = [
      { id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 10, op: "new" },
      { id: "f2", type: "extrude", plane: { ...XY, origin: [0, 0, 10] }, profile: rect(60, 10), distance: 30, op: "fuse" },
    ];
    const s = build(features, () => []).states[2]!;
    expect(s.unnamed).toBe(0);
    const front = s.faceNames.filter((n) => [...n].some((x) => x.endsWith("side(front)")));
    expect(front.map((n) => [...n].sort())).toEqual([["f1.side(front)", "f2.side(front)"]]);
  });

  test("fillet names the new face after the filleted edge", () => {
    const features: Feature[] = [
      { id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 20, op: "new" },
      { id: "f2", type: "fillet", edges: "e", radius: 3 },
    ];
    const pick = byName({
      e: (s) => s.edges.filter((_, i) => {
        const adj = s.edgeFaces[i]!.map((fi) => s.faceNames[fi]!);
        return adj.some((n) => n.has("f1.end")) && adj.some((n) => n.has("f1.side(front)"));
      }),
    });
    const s = build(features, pick).states[2]!;
    expect(s.unnamed).toBe(0);
    expect(names(s)).toContain("f2.fillet(edge(f1.end | f1.side(front)))");
  });

  test("shell keeps outer names and marks offset faces as inner", () => {
    const features: Feature[] = [
      { id: "f1", type: "extrude", plane: XY, profile: rect(60, 40), distance: 20, op: "new" },
      { id: "f2", type: "shell", faces: "top", thickness: 2 },
    ];
    const s = build(features, byName({ top: (s) => faceNamed(s, "f1.end") })).states[2]!;
    console.log("shell names:", names(s));
    expect(s.unnamed).toBe(0);
    // The removed top face survives as the rim, which keeps its name.
    const rim = faceNamed(s, "f1.end");
    expect(rim).toHaveLength(1);
    expect(describeFace(rim[0]!).area).toBeCloseTo(60 * 40 - 56 * 36);
    expect(names(s)).toContain("f2.inner(f1.start)");
  });

  test("revolve names faces by profile segment", () => {
    const profile = { kind: "polygon" as const, points: [[0, 0], [10, 0], [10, 20], [0, 20]] as [number, number][], segments: ["bottom", "outer", "top", "axis"] };
    const XZ = { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] } as const;
    const m = build([{ id: "f1", type: "revolve", plane: XZ, profile, axis: { origin: [0, 0], dir: [0, 1] }, op: "new" }], () => []);
    const s = m.states[1]!;
    console.log("revolve names:", names(s));
    expect(s.unnamed).toBe(0);
    expect(names(s)).toEqual(["f1.side(bottom)", "f1.side(outer)", "f1.side(top)"]);
  });
});
