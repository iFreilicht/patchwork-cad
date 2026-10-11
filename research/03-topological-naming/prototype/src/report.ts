/**
 * Runs the benchmark and prints the markdown results used in research/03-topological-naming.md.
 * Every non-correct cell is classified by the rules below; anything unmatched is "UNCLASSIFIED" and
 * fails test/bench.test.ts.
 */
import { runCase, type Category, type Result } from "./bench.ts";
import { cases } from "./cases/index.ts";
import { loadOC } from "./oc.ts";

export function runAll(): Result[] {
  return (cases as Parameters<typeof runCase>[0][]).flatMap((c) => runCase(c));
}

/** Mechanism behind a non-correct cell, derived from the strategy's own explanation. */
export function classify(r: Result): string {
  const x = r.explanation ?? "";
  const s = r.strategy;
  if (r.score === "correct") return "";
  if (s.startsWith("S0")) {
    if (x.startsWith("intended entity gone")) return "index now points at another entity";
    if (/is now #[\d,-]+ \(captured #\d+\)/.test(x)) return r.outcome.startsWith("missing") ? "index out of range" : "index shifted";
  }
  if (s.startsWith("S1")) {
    if (x.startsWith("intended entity gone")) return "positional predicate matches another entity";
    const fails = [...x.matchAll(/intended entity fails ([a-zA-Z, ]+)/g)].flatMap((m) => m[1]!.split(", "));
    if (fails.length) return `positional predicate no longer holds (${[...new Set(fails)].join(", ")})`;
    if (x.includes("satisfies all predicates")) return r.score === "wrong" ? "predicate matches only some pieces" : "minimal predicate no longer unique";
  }
  if (s.startsWith("S2") || s.startsWith("S3")) {
    const m = x.match(/^(?:intended entity gone; )?(\d+) entities named .* \(captured (\d+), picked #(\d+)\)/);
    if (m) {
      const [now, cap] = [+m[1]!, +m[2]!];
      if (now === 0) return "origin name changed (sketch edit)";
      if (now < cap) return s.startsWith("S2") ? "sibling vanished; positional index out of range" : "piece count changed (fewer); reported";
      if (now > cap) return s.startsWith("S2") ? (r.score === "wrong" ? "pieces added; positional index picks wrong piece" : "split of a named entity; reported") : "piece count changed (more); reported";
    }
  }
  if (s.startsWith("S4")) {
    const m = x.match(/(\d+) descendants/);
    if (m) {
      const n = +m[1]!;
      if (n === 0) return r.outcome.includes("suggests") ? "split undone; ancestor only suggested" : "origin name changed (sketch edit)";
      if (n > 1) return "split into several pieces; single-entity parameter";
    }
  }
  return "UNCLASSIFIED";
}

const sym = { correct: "✅", reported: "⚠️", wrong: "❌" } as const;

export function markdown(all: Result[]): string {
  const strategies = [...new Set(all.map((r) => r.strategy))];
  const categories = [...new Set(all.map((r) => r.category))] as Category[];
  const out: string[] = [];
  const count = (rs: Result[], k: Result["score"]) => rs.filter((r) => r.score === k).length;

  out.push(`${all.length / strategies.length} cells per strategy (${cases.length} models × edits × references).`, "");
  out.push("| Strategy | ✅ correct | ⚠️ reported | ❌ silently wrong | suggestion right | median resolve |", "|---|---|---|---|---|---|");
  for (const s of strategies) {
    const rs = all.filter((r) => r.strategy === s);
    const sug = rs.filter((r) => r.suggestion);
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b)[rs.length >> 1]!;
    out.push(`| ${s} | ${count(rs, "correct")} | ${count(rs, "reported")} | ${count(rs, "wrong")} | ${sug.length ? `${sug.filter((r) => r.suggestion === "right").length}/${sug.length}` : "–"} | ${ms.toFixed(2)} ms |`);
  }
  out.push("", "By edit category (✅/⚠️/❌):", "", `| Category | ${strategies.join(" | ")} |`, `|---|${strategies.map(() => "---").join("|")}|`);
  for (const c of categories) {
    const cells = strategies.map((s) => {
      const rs = all.filter((r) => r.strategy === s && r.category === c);
      return `${count(rs, "correct")}/${count(rs, "reported")}/${count(rs, "wrong")}`;
    });
    out.push(`| ${c} | ${cells.join(" | ")} |`);
  }
  out.push("", "Failure mechanisms (every non-✅ cell):", "", "| Strategy | Mechanism | ⚠️ | ❌ |", "|---|---|---|---|");
  const groups = new Map<string, Result[]>();
  for (const r of all.filter((r) => r.score !== "correct")) {
    const k = `${r.strategy}\u0000${classify(r)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rs] of [...groups].sort()) {
    const [s, mech] = k.split("\u0000");
    out.push(`| ${s} | ${mech} | ${count(rs, "reported")} | ${count(rs, "wrong")} |`);
  }
  return out.join("\n");
}

/** Every non-correct cell with its explanation, for the appendix. */
export function details(all: Result[]): string {
  const out = ["| Model | Edit | Reference | Strategy | Result | Mechanism | Explanation |", "|---|---|---|---|---|---|---|"];
  for (const r of all.filter((r) => r.score !== "correct")) {
    const esc = (t: string) => t.replaceAll("|", "\\|");
    out.push(`| ${r.model} | ${r.edit} | ${r.slot} | ${r.strategy} | ${sym[r.score]} ${esc(r.outcome)} | ${classify(r)} | ${esc(r.explanation ?? "")} |`);
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadOC();
  const all = runAll();
  console.log(markdown(all));
  if (process.argv.includes("--details")) console.log(`\n${details(all)}`);
}
