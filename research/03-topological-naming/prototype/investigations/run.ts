/** Runs a filtered slice of the benchmark: tsx investigations/run.ts [model] [edit] [slot] [strategy]; FAIL_ONLY=1, CODE=1. */
import { runCase } from "../src/bench.ts";
import { cases } from "../src/cases/index.ts";
import { loadOC } from "../src/oc.ts";

await loadOC();
const [model, edit, slot, strategy] = process.argv.slice(2);
const sym = { correct: "✅", reported: "⚠️", wrong: "❌" } as const;
for (const c of cases as Parameters<typeof runCase>[0][]) {
  if (model && !c.model.startsWith(model)) continue;
  for (const r of runCase(c, { ...(edit ? { edit } : {}), ...(slot ? { slot } : {}), ...(strategy ? { strategy } : {}) })) {
    if (process.env["FAIL_ONLY"] && r.score === "correct") continue;
    console.log(`${sym[r.score]} ${r.model} | ${r.edit} | ${r.slot} | ${r.strategy} | ${r.outcome} | expected: ${r.expected}${process.env["CODE"] ? ` | code: ${r.code}` : ""}${r.explanation ? ` | why: ${r.explanation}` : ""}`);
  }
}
