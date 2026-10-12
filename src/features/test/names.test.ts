import { beforeAll, expect, test } from "vitest";
import { beginBuild, currentTrace } from "../src/runtime.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

// Every face and edge can be referenced only if it has a history name. Blends propagate along
// tangent edges, and OCCT reports the faces this creates as generated from the edges of the chain,
// not only from the picked ones (M1's chamfer meets the notch's fillet).
test.each(["m1", "m3"])("every face and edge of %s has a history name", async (name) => {
  const model = (await import(`../examples/${name}.js`)) as { default: (p: unknown) => unknown; defaultParams: unknown };
  beginBuild({ lenient: false });
  model.default(model.defaultParams);
  for (const t of currentTrace()) {
    const topo = t.result?.topo;
    if (!topo) continue;
    expect(topo.faceHist.filter((h) => h.size === 0), `${t.name} faces`).toHaveLength(0);
    expect(topo.edgeHist.filter((h) => h.size === 0), `${t.name} edges`).toHaveLength(0);
  }
});
