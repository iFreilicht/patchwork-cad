/**
 * The naming benchmark of research/03, rerun through the library: each reference is picked at the
 * base model, printed as code, and after every edit evaluated from that code and resolved. Models
 * are built with the oracles' answers, so each reference is scored independently, as in the
 * prototype.
 */
import { beforeAll, expect, test } from "vitest";
import { any, edge, ref, type Body, type Ref } from "../src/index.ts";
import { beginBuild, currentTrace, pick } from "../src/runtime.ts";
import { resolveAll, type Resolution } from "../src/refs.ts";
import { entities, indexOf } from "../src/topo.ts";
import type { Shape } from "../src/oc.ts";
import { m1, m3, type Case, type Expected } from "./cases.ts";
import { loadOC } from "./oc.ts";

beforeAll(loadOC);

type Score = "correct" | "reported" | "wrong";

function score(expected: Expected, r: Resolution): Score {
  if ("ok" in r) {
    if (expected === "gone") return "wrong";
    return r.ok.length === expected.length && r.ok.every((x) => expected.some((y) => y.IsSame(x))) ? "correct" : "wrong";
  }
  return expected === "gone" ? "correct" : "reported";
}

/**
 * Evaluates reference code the way a model would, with the feature variables in scope. A variable
 * whose feature an edit deleted is replaced by `ref.<name>`, as the editor does when it deletes a
 * feature, so that the reference reports itself instead of throwing.
 */
function evaluate(code: string, scope: Record<string, Body>, names: string[]): Ref[] {
  const values = names.map((n) => scope[n] ?? ref[n]);
  return new Function("edge", "any", "ref", ...names, `return [${code}];`)(edge, any, ref, ...values) as Ref[];
}

interface Cell {
  model: string;
  edit: string;
  slot: string;
  score: Score;
  outcome: string;
  suggestion?: "right" | "wrong";
}

function run<P>(c: Case<P>): { codes: Record<string, string>; cells: Cell[] } {
  const codes: Record<string, string> = {};
  let variables: string[] = [];
  // Base model: pick what the oracle means and record the code the GUI would write.
  beginBuild({ lenient: true });
  c.build(c.params, (slot, before) => {
    const spec = c.refs.find((r) => r.slot === slot)!;
    const picked = spec.oracle(before.topo, c.params);
    if (picked === "gone") throw new Error(`${c.model}/${slot}: oracle finds nothing in the base model`);
    const refs = picked.map((e) => pick(before, spec.kind, indexOf(before.topo, spec.kind, e)));
    codes[slot] = refs.map(String).join(", ");
    return refs;
  });
  variables = currentTrace().filter((t) => t.variable && t.result).map((t) => t.name);
  const cells: Cell[] = [];
  for (const edit of c.edits) {
    const p = { ...c.params, ...edit.params } as P;
    beginBuild({ lenient: true });
    c.build(p, (slot, before: Body) => {
      const scope = Object.fromEntries(currentTrace().flatMap((t) => (t.result ? [[t.name, t.result]] : [])));
      const spec = c.refs.find((r) => r.slot === slot)!;
      const expected = spec.oracle(before.topo, p);
      const { whole } = resolveAll(before.topo, evaluate(codes[slot]!, scope, variables), spec.multi);
      const s = score(expected, whole);
      const show = (es: Shape[]) => es.map((e) => entities(before.topo, spec.kind).findIndex((x) => x.IsSame(e))).join(",");
      const outcome = "ok" in whole ? `ok ${show(whole.ok)}` : "missing" in whole ? `missing (${whole.missing})` : `ambiguous (${whole.why})`;
      const cell: Cell = { model: c.model, edit: edit.name, slot, score: s, outcome };
      if (!("ok" in whole) && whole.suggestion) cell.suggestion = score(expected, { ok: whole.suggestion }) === "correct" ? "right" : "wrong";
      cells.push(cell);
      // Build on with the ground truth.
      return expected === "gone" ? [] : expected.map((e) => pick(before, spec.kind, indexOf(before.topo, spec.kind, e)));
    });
  }
  return { codes, cells };
}

const summary = (cells: Cell[]) => cells.filter((c) => c.score !== "correct").map((c) => `${c.model} | ${c.edit} | ${c.slot} | ${c.score}${c.suggestion ? ` (suggestion ${c.suggestion})` : ""}`);

test("M1: references survive edits as in the benchmark's S5", () => {
  const { codes, cells } = run(m1);
  console.log(codes, "\n" + cells.map((c) => `${c.edit} | ${c.slot} | ${c.score} | ${c.outcome}${c.suggestion ? ` | suggestion ${c.suggestion}` : ""}`).join("\n"));
  expect(cells).toHaveLength(27);
  expect(cells.filter((c) => c.score === "wrong")).toEqual([]);
  expect(summary(cells)).toMatchSnapshot();
});

test("M3: references survive edits as in the benchmark's S5", () => {
  const { codes, cells } = run(m3);
  console.log(codes, "\n" + cells.map((c) => `${c.edit} | ${c.slot} | ${c.score} | ${c.outcome}${c.suggestion ? ` | suggestion ${c.suggestion}` : ""}`).join("\n"));
  expect(cells).toHaveLength(27);
  expect(cells.filter((c) => c.score === "wrong")).toEqual([]);
  expect(summary(cells)).toMatchSnapshot();
});
