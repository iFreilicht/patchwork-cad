/** Counts the "IsDeleted but still present" history quirk per OCCT operation and shape type for one M1 build. */
import { buildCase } from "../src/bench.ts";
import { m1 } from "../src/cases/m1-slotted-block.ts";
import { historyQuirks } from "../src/model.ts";
import { loadOC } from "../src/oc.ts";

await loadOC();
buildCase(m1, m1.params, m1.features(m1.params));
console.log(historyQuirks);
