/** M5 with the cap-splitting slot: OCCT's MakeThickSolidByJoin fails for every variant tried. */
import { buildCase } from "../src/bench.ts";
import { m5 } from "../src/cases/m5-boss-shell.ts";
import type { Feature } from "../src/model.ts";
import { loadOC } from "../src/oc.ts";

await loadOC();
for (const [depth, width, thickness, x0] of [[5, 4, 1, 0], [3, 4, 1, 0], [5, 4, 1, -1], [3, 6, 0.8, -1], [5, 4, 2, -1]] as const) {
  const p = { ...m5.params, slot: true };
  const f = m5.features(p).map((x): Feature => {
    if (x.id === "slot" && x.type === "extrude") return { ...x, distance: depth, profile: { kind: "polygon", points: [[x0, 8], [p.w - x0, 8], [p.w - x0, 8 + width], [x0, 8 + width]], segments: ["a", "b", "c", "d"] } };
    if (x.id === "f4" && x.type === "shell") return { ...x, thickness };
    return x;
  });
  console.log({ depth, width, thickness, x0 }, buildCase(m5, p, f).failures);
}
