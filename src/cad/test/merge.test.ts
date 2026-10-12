/**
 * Experiment for research/07, "Text vs. AST editing": a form edit (fillet radius 1.5 → 2) applied
 * three ways, each merged with a concurrent edit by another user:
 * - splice: replace the argument's source span only (what the editor does)
 * - recast: change the AST and reprint with recast, which reprints only changed nodes; applied
 *   with updateText (a minimal character diff)
 * - astring: change the AST and print the whole program; applied with updateText
 * Each result is checked for: parses, the form edit arrived, the concurrent edit arrived, comments
 * and formatting are untouched elsewhere.
 */
import { readFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import { generate } from "astring";
import { parse as acornParse } from "acorn";
import * as recast from "recast";
import * as acornParser from "recast/parsers/acorn.js";
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { setProp } from "../src/model/splice.ts";
import type { CadModelDoc } from "../src/types.ts";

const base = `// M1, with a comment the form must not lose.\n${readFileSync(new URL("../../features/examples/m1.js", import.meta.url), "utf8")}`;

type Doc = A.Doc<CadModelDoc>;
type Way = "splice" | "recast" | "astring";

/** The form edit, applied the given way to a copy of the document. */
function formEdit(doc: Doc, way: Way): Doc {
  const source = doc.source;
  if (way === "splice") {
    const call = analyze(source).calls.find((c) => c.variable === "fillet1")!;
    const [edit] = setProp(call, "radius", "2");
    return A.change(doc, (d) => A.splice(d, ["source"], edit!.start, edit!.end - edit!.start, edit!.text));
  }
  let printed: string;
  if (way === "recast") {
    const ast = recast.parse(source, { parser: acornParser });
    recast.visit(ast, {
      visitProperty(path) {
        const node = path.node as { key: { name?: string }; value: { value?: unknown; raw?: string } };
        if (node.key.name === "radius" && node.value.value === 1.5) path.get("value").replace(recast.types.builders.literal(2));
        return false;
      },
      visitNode(path) {
        this.traverse(path);
      },
    });
    printed = recast.print(ast).code;
  } else {
    const ast = acornParse(source, { ecmaVersion: "latest", sourceType: "module" });
    const stack: unknown[] = [ast];
    while (stack.length) {
      const node = stack.pop() as Record<string, unknown>;
      if (node["type"] === "Property" && (node["key"] as { name?: string }).name === "radius" && (node["value"] as { value?: unknown }).value === 1.5) node["value"] = { type: "Literal", value: 2, raw: "2" };
      for (const v of Object.values(node)) for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string") stack.push(c);
    }
    printed = generate(ast);
  }
  return A.change(doc, (d) => A.updateText(d, ["source"], printed));
}

/** Concurrent edits by another user, as character splices like typing, with a marker that shows the edit arrived. */
const concurrent: Record<string, { edit: (s: string) => string; marker: string }> = {
  "comment above": { edit: (s) => s.replace("export const defaultParams", "// tuned for the 3D printer\nexport const defaultParams"), marker: "// tuned for the 3D printer" },
  "same call, other argument": {
    edit: (s) => s.replace("edges: [edge(extrude1.end, notch.side.c)]", "edges: [edge(extrude1.end, notch.side.c), edge(extrude1.start, notch.side.c)]"),
    marker: "edge(extrude1.start, notch.side.c)",
  },
  "same argument": { edit: (s) => s.replace("radius: 1.5", "radius: 3"), marker: "radius: 3" },
  "comment in the call": { edit: (s) => s.replace("radius: 1.5 })", "radius: 1.5 /* see drawing */ })"), marker: "/* see drawing */" },
  "other line reformatted": {
    edit: (s) => s.replace("const extrude1 = extrude({ sketch: sketch1, distance: h });", "const extrude1 = extrude({\n    sketch: sketch1,\n    distance: h,\n  });"),
    marker: "\n    sketch: sketch1,\n",
  },
};

function typed(doc: Doc, edit: (s: string) => string): Doc {
  return A.change(doc, (d) => A.updateText(d, ["source"], edit(d.source)));
}

const parses = (s: string) => {
  try {
    analyze(s);
    return true;
  } catch {
    return false;
  }
};

interface Outcome {
  parses: boolean;
  formEdit: boolean;
  concurrentEdit: boolean;
  /** Lines outside the edited call that differ from what each edit alone would have produced. */
  collateral: number;
  /** The merged radius argument. */
  radius: string;
}

function run(way: Way, name: string): Outcome {
  const doc = A.from({ title: "m1", source: base }) as Doc;
  const a = formEdit(A.clone(doc), way);
  const b = typed(A.clone(doc), concurrent[name]!.edit);
  const merged = A.merge(a, b).source;
  // What a perfect merge would contain: B's text with only the radius changed.
  const ideal = concurrent[name]!.edit(base).replace(/radius: 1\.5\b/, "radius: 2");
  const idealLines = new Set(ideal.split("\n"));
  const collateral = merged.split("\n").filter((l) => !idealLines.has(l) && !l.includes("fillet(")).length;
  // The fillet call, also when a printer spreads it over several lines.
  const from = merged.indexOf("fillet(");
  const call = merged.slice(from, merged.indexOf(");", from));
  const radius = /radius: ([^,})]*)/.exec(call)?.[1]?.replace(/\s+/g, " ").trim() ?? "?";
  return {
    parses: parses(merged),
    formEdit: radius.includes("2"),
    concurrentEdit: name === "same argument" ? radius.includes("3") : merged.includes(concurrent[name]!.marker),
    collateral,
    radius,
  };
}

test("form edits merged with concurrent edits", () => {
  const rows: string[] = [];
  const results: Record<string, Record<Way, Outcome>> = {};
  for (const name of Object.keys(concurrent)) {
    results[name] = { splice: run("splice", name), recast: run("recast", name), astring: run("astring", name) };
    for (const way of ["splice", "recast", "astring"] as Way[]) {
      const o = results[name]![way];
      rows.push(`| ${name} | ${way} | ${o.parses ? "yes" : "no"} | ${o.formEdit ? "yes" : "no"} | ${o.concurrentEdit ? "yes" : "no"} | ${o.collateral} | \`${o.radius}\` |`);
    }
  }
  console.log(["| concurrent edit | form edit as | parses | form edit kept | concurrent edit kept | other lines changed | merged radius |", "|---|---|---|---|---|---|---|", ...rows].join("\n"));
  // The editor's way keeps everything except a conflict on the same argument.
  for (const name of Object.keys(concurrent)) {
    const { radius, ...o } = results[name]!.splice;
    if (name !== "same argument") expect(o).toEqual({ parses: true, formEdit: true, concurrentEdit: true, collateral: 0 });
    else expect(radius).toMatch(/^(23|32)$/);
  }
});

test("a cursor survives splices, but not replacing the whole text", () => {
  let doc = A.from({ title: "m1", source: base }) as Doc;
  const at = base.indexOf("fillet(");
  const cursor = A.getCursor(doc, ["source"], at);
  doc = A.change(doc, (d) => A.splice(d, ["source"], 0, 0, "// typed\n"));
  expect(A.getCursorPosition(doc, ["source"], cursor)).toBe(at + "// typed\n".length);
  doc = A.change(doc, (d) => (d.source = `${d.source}`));
  expect(() => A.getCursorPosition(doc, ["source"], cursor)).toThrow();
});
