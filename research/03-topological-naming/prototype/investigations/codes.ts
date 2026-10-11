/** Prints how a few references look as code under each strategy. */
import { buildCase, consumerOf, type Case } from "../src/bench.ts";
import { cases } from "../src/cases/index.ts";
import { loadOC } from "../src/oc.ts";
import { strategies } from "../src/strategies.ts";

await loadOC();
for (const [m, slot] of [["M1", "frontRightFace"], ["M1", "frontRightTopEdge"], ["M3", "innerCornerEdges"], ["M3", "backFace"], ["M4", "shoulderEdge"]] as const) {
  const c = (cases as Case<unknown>[]).find((c) => c.model.startsWith(m))!;
  const f = c.features(c.params);
  const s = buildCase(c, c.params, f).before(consumerOf(f, slot)!);
  const ref = c.refs.find((r) => r.slot === slot)!;
  const picked = ref.oracle(s, c.params);
  if (picked === "gone") continue;
  console.log(`\n${m} ${slot}:`);
  for (const st of strategies) console.log(`  ${st.name}: ${picked.map((e) => st.toCode(st.capture(s, ref.kind, e))).join(", ")}`);
}
