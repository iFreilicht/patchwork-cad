import { beforeAll, expect, test } from "vitest";
import { print } from "../src/names.ts";
import { beginBuild, currentTrace, owners } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

const runExample = async (name: string) => {
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: unknown };
  beginBuild({ lenient: false });
  model.default(model.defaultParams);
  return currentTrace();
};

// Every face and edge can be referenced only if it has a history name. Blends propagate along
// tangent edges, and OCCT reports the faces this creates as generated from the edges of the chain,
// not only from the picked ones (M1's chamfer meets the notch's fillet).
test.each(["m1", "m3"])("every face and edge of %s has a history name", async (name) => {
  for (const t of await runExample(name)) {
    const topo = t.result?.topo;
    if (!topo) continue;
    expect(topo.faceHist.filter((h) => h.size === 0), `${t.name} faces`).toHaveLength(0);
    expect(topo.edgeHist.filter((h) => h.size === 0), `${t.name} edges`).toHaveLength(0);
  }
});

// A feature owns the faces it created and the pieces it split (research/12), so hovering it in
// the timeline highlights them in the final body.
test("features own the faces they created or split in M1's final body", async () => {
  const body = (await runExample("m1")).at(-1)!.result!;
  const owned = owners(body);
  const faces = (feature: string) => (owned[feature]?.faces ?? []).map((i) => [...body.topo.faceHist[i]!.values()].map((n) => print(n)).join(" | ")).sort();

  expect(faces("extrude#2")).toEqual(['ref["extrude#1"].side.front.piece(ref["extrude#2"], 1)', 'ref["extrude#1"].side.front.piece(ref["extrude#2"], 2)', 'ref["extrude#2"].side.c']);
  expect(faces("fillet#1")).toEqual(['ref["fillet#1"].face(edge(ref["extrude#1"].end, ref["extrude#2"].side.c))']);
  expect(faces("extrude#1")).toContain('ref["extrude#1"].start');
  expect(faces("extrude#3")).toEqual(['ref["extrude#3"].end', 'ref["extrude#3"].side.c']);

  const all = new Set(Object.values(owned).flatMap((o) => o.faces));
  expect(all.size).toBe(body.topo.faces.length);
  // An owned face's edges are the feature's, too.
  for (const { faces: f, edges } of Object.values(owned)) for (const e of edges) expect(body.topo.edgeFaces[e]!.some((x) => f.includes(x))).toBe(true);
});
