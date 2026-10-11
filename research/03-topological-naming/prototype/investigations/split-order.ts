/**
 * When does OCCT change the order of a split's pieces in Modified()? S4's `#k` suffixes depend on it.
 * Prints, per parameter value, which piece (by x position) got which `#k` in the history names.
 */
import { buildCase, type Case } from "../src/bench.ts";
import { m1 } from "../src/cases/m1-slotted-block.ts";
import { m3 } from "../src/cases/m3-bracket.ts";
import { describe } from "../src/geom.ts";
import type { State } from "../src/model.ts";
import { loadOC } from "../src/oc.ts";

await loadOC();

function order(s: State, kind: "face" | "edge", match: (n: string) => boolean): string {
  const ents = kind === "face" ? s.faces : s.edges;
  const hist = kind === "face" ? s.faceHist : s.edgeHist;
  return ents
    .map((e, i) => ({ x: describe(e, kind).centroid[0], n: [...hist[i]!].find(match) }))
    .filter((r) => r.n)
    .sort((a, b) => a.x - b.x)
    .map((r) => `x=${r.x.toFixed(1)}:${r.n!.slice(r.n!.lastIndexOf("/"))}`)
    .join("  ");
}

const probe = <P>(c: Case<P>, label: string, variants: Partial<P>[], at: string, kind: "face" | "edge", match: (n: string) => boolean) => {
  console.log(`\n${label}`);
  for (const v of variants) {
    const p = { ...c.params, ...v };
    console.log(" ", JSON.stringify(v).padEnd(36), order(buildCase(c, p, c.features(p)).before(at), kind, match));
  }
};

const notchPositions = [10, 15, 20, 25, 30, 35, 40, 45, 50].map((a) => ({ a }));
probe(m1, "M1 front face pieces vs notch position", notchPositions, "f5", "face", (n) => n.startsWith("f1.side(front)/"));
probe(m1, "M1 front-top edge pieces vs notch position", notchPositions, "f4", "edge", (n) => n.startsWith("edge(f1.end | f1.side(front))/"));
probe(m1, "M1 with flipped block", [{ flip: false }, { flip: true }], "f5", "face", (n) => n.startsWith("f1.side(front)/"));
probe(m3, "M3 corner edge pieces vs rib position", [5, 10, 20, 30, 40, 50, 55].map((x) => ({ ribs: [x] })), "f4", "edge", (n) => n.includes("/rib0#"));
probe(m3, "M3 corner edge pieces with two ribs", [{ ribs: [20, 40] }, { ribs: [40, 20] }], "f4", "edge", (n) => n.includes("/rib"));

// Same rectangle, same segment names, but drawn in reverse (clockwise) or starting at another corner.
type Poly = Extract<import("../src/model.ts").Profile, { kind: "polygon" }>;
const reverse = (pr: Poly): Poly => {
  // segment i goes points[i] → points[i+1]; reversed, it goes points[i+1] → points[i]
  const n = pr.points.length;
  const pts = [...pr.points].reverse();
  const segs = pts.map((_, i) => pr.segments[(n - 2 - i + n) % n]!);
  return { ...pr, points: pts, segments: segs };
};
const rotate = (pr: Poly, k: number): Poly => ({ ...pr, points: [...pr.points.slice(k), ...pr.points.slice(0, k)], segments: [...pr.segments.slice(k), ...pr.segments.slice(0, k)] });
for (const [label, tf] of [["as is", (p: Poly) => p], ["reversed", reverse], ["rotated by 2", (p: Poly) => rotate(p, 2)]] as const) {
  const f = m1.features(m1.params).map((x) => (x.id === "f1" && x.type === "extrude" ? { ...x, profile: tf(x.profile as Poly) } : x));
  const s = buildCase(m1, m1.params, f);
  console.log(`\nM1 sketch drawn ${label}: segments ${(f[0] as { profile: Poly }).profile.segments.join(",")}`);
  console.log("  face:", order(s.before("f5"), "face", (n) => n.startsWith("f1.side(front)/")));
  console.log("  edge:", order(s.before("f4"), "edge", (n) => n.startsWith("edge(f1.end | f1.side(front))/")));
}
