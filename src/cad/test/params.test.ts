// A model's parameters (research/17-parameters.md): reading defaultParams, main's pattern, the
// derived constants and paramConfig, and editing them with splices that keep the code plain.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { addDerived, addParam, parameters, quantities, removeDerived, removeParam, renameDerived, renameParam, setDefault, type ParamEdit } from "../src/model/params.ts";
import { applyToText } from "../src/model/splice.ts";
import { timeline } from "../src/model/timeline.ts";

const example = (name: string) => readFileSync(new URL(`../../features/examples/${name}.js`, import.meta.url), "utf8");
const read = (source: string) => parameters(source, analyze(source));
function applied(source: string, edit: ParamEdit): string {
  if ("error" in edit) throw new Error(edit.error);
  const out = applyToText(source, edit.edits);
  analyze(out);
  return out;
}

const model = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 8 };
export const paramConfig = { w: { title: "Width", minimum: 10, maximum: 200, multipleOf: 5 }, r: { title: "Corner radius" } };

export default function main({ w, d, h }) {
  const r = w / 4;
  const t = Math.min(h, 3);
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const plate = extrude({ sketch: sketch1, distance: t + r * 0 });
  return { plate };
}
`;

test("parameters, derived parameters and paramConfig are read from the code", () => {
  const p = read(model);
  expect(p.readOnly).toBeUndefined();
  expect(p.params.map((x) => [x.key, x.local, x.value, x.literal])).toEqual([
    ["w", "w", "60", 60],
    ["d", "d", "40", 40],
    ["h", "h", "8", 8],
  ]);
  expect(p.derived.map((d) => [d.name, d.text])).toEqual([
    ["r", "w / 4"],
    ["t", "Math.min(h, 3)"],
  ]);
  expect(p.config).toEqual({ w: { title: "Width", minimum: 10, maximum: 200, multipleOf: 5 }, r: { title: "Corner radius" } });
});

test("derived parameters aren't timeline entries", () => {
  const entries = timeline(model, analyze(model), []).entries;
  expect(entries.map((e) => (e.kind === "feature" ? e.name : "script"))).toEqual(["sketch1", "plate"]);
  // The first statement that isn't a pure const ends them: here a call.
  const scripted = model.replace("const t = Math.min(h, 3);", "const t = helper(h);");
  expect(read(scripted).derived.map((d) => d.name)).toEqual(["r"]);
  expect(timeline(scripted, analyze(scripted), []).entries[0]?.kind).toBe("script");
  // So does an object, which later code could change.
  const object = model.replace("const t = Math.min(h, 3);", "const t = { v: 3 };");
  expect(read(object).derived.map((d) => d.name)).toEqual(["r"]);
});

test("the examples' parameters are editable", () => {
  for (const name of ["m1", "m3", "m4"]) {
    const p = read(example(name));
    expect(p.readOnly, name).toBeUndefined();
    expect(p.params.length, name).toBeGreaterThan(0);
  }
  expect(read(example("m3")).params.find((x) => x.key === "ribs")?.literal).toEqual([30]);
});

test("a parameter is added to defaultParams and to main's pattern, both created if missing", () => {
  expect(applied(model, addParam(model, analyze(model), read(model), "n", "3"))).toContain("export const defaultParams = { w: 60, d: 40, h: 8, n: 3 };");
  expect(applied(model, addParam(model, analyze(model), read(model), "n", "3"))).toContain("export default function main({ w, d, h, n }) {");
  const bare = `import { sketch } from "@patchwork-cad/features";\n\nexport default function main() {\n  return {};\n}\n`;
  const added = applied(bare, addParam(bare, analyze(bare), read(bare), "size", "20"));
  expect(added).toContain("export const defaultParams = { size: 20 };\n\nexport default function main({ size }) {");
  const multiline = model.replace("{ w: 60, d: 40, h: 8 }", "{\n  w: 60,\n  d: 40,\n  h: 8,\n}");
  expect(applied(multiline, addParam(multiline, analyze(multiline), read(multiline), "n", "3"))).toContain("  h: 8,\n  n: 3,\n}");
  expect(addParam(model, analyze(model), read(model), "plate", "1")).toEqual({ error: "plate is already used in the model" });
  expect(addParam(model, analyze(model), read(model), "Math", "1")).toEqual({ error: "Math is already used in the model" });
  expect(addParam(model, analyze(model), read(model), "2x", "1")).toEqual({ error: "2x is not a valid name" });
});

test("a parameter is renamed with its uses, and in paramConfig", () => {
  const out = applied(model, renameParam(analyze(model), read(model), "w", "width"));
  expect(out).toContain("{ width: 60, d: 40, h: 8 }");
  expect(out).toContain("paramConfig = { width: { title");
  expect(out).toContain("main({ width, d, h })");
  expect(out).toContain("const r = width / 4;");
  expect(out).toContain("to: [width, d]");
  // A shorthand property that uses it keeps its key.
  const shorthand = model.replace("return { plate };", "return { plate, w };");
  expect(applied(shorthand, renameParam(analyze(shorthand), read(shorthand), "w", "width"))).toContain("return { plate, w: width };");
  // Read under another name, only the key changes.
  const aliased = model.replace("main({ w, d, h })", "main({ w: wide, d, h })").replace("w / 4", "wide / 4").replace("[w, d]", "[wide, d]");
  const renamed = applied(aliased, renameParam(analyze(aliased), read(aliased), "w", "width"));
  expect(renamed).toContain("main({ width: wide, d, h })");
  expect(renamed).toContain("wide / 4");
  expect(renameParam(analyze(model), read(model), "w", "d")).toEqual({ error: "d is already used in the model" });
});

test("a parameter is removed only when nothing uses it", () => {
  expect(removeParam(analyze(model), read(model), "w")).toEqual({ error: "w is used 2 times in the model" });
  const unused = model.replace("const t = Math.min(h, 3);", "const t = 3;");
  const out = applied(unused, removeParam(analyze(unused), read(unused), "h"));
  expect(out).toContain("{ w: 60, d: 40 }");
  expect(out).toContain("main({ w, d })");
});

test("a default is set, and added for a parameter without one", () => {
  expect(applied(model, setDefault(model, read(model), "w", "30 * 2"))).toContain("{ w: 30 * 2, d: 40, h: 8 }");
  const missing = model.replace("{ w: 60, d: 40, h: 8 }", "{ w: 60, d: 40 }");
  expect(applied(missing, setDefault(missing, read(missing), "h", "5"))).toContain("{ w: 60, d: 40, h: 5 }");
});

test("derived parameters are added after the others, renamed and removed", () => {
  const added = applied(model, addDerived(model, analyze(model), read(model), "half", "w / 2"));
  expect(added).toContain("  const t = Math.min(h, 3);\n  const half = w / 2;\n");
  const renamed = applied(model, renameDerived(analyze(model), read(model), "r", "radius"));
  expect(renamed).toContain("const radius = w / 4;");
  expect(renamed).toContain("t + radius * 0");
  expect(removeDerived(model, analyze(model), read(model), "r")).toEqual({ error: "r is used once in the model" });
  const unused = model.replace("t + r * 0", "t");
  expect(applied(unused, removeDerived(unused, analyze(unused), read(unused), "r"))).not.toContain("const r");
  const none = model.replace("  const r = w / 4;\n  const t = Math.min(h, 3);\n", "").replace("t + r * 0", "h");
  expect(applied(none, addDerived(none, analyze(none), read(none), "r", "w / 4"))).toContain("main({ w, d, h }) {\n  const r = w / 4;\n  const sketch1");
});

test("code the editor can't write is shown read-only", () => {
  expect(read(model.replace("main({ w, d, h })", "main(params)")).readOnly).toMatch(/main takes its parameters as params/);
  expect(read(model.replace("main({ w, d, h })", "main({ w = 1, d, h })")).readOnly).toMatch(/defaults or a rest/);
  expect(read(model.replace("{ w: 60, d: 40, h: 8 }", "Object.fromEntries([])")).readOnly).toMatch(/defaultParams/);
  const p = read(model.replace("main({ w, d, h })", "main(params)"));
  expect(setDefault(model, p, "w", "1")).toEqual({ error: p.readOnly });
});

test("a parameter's quantity is inferred from the arguments it goes into, also through derived ones", () => {
  const q = quantities(analyze(model), read(model));
  expect(q.get("w")).toBe("length");
  expect(q.get("d")).toBe("length");
  expect(q.get("t")).toBe("length");
  expect(q.get("h")).toBe("length");
  const m3 = example("m3");
  const q3 = quantities(analyze(m3), read(m3));
  expect(q3.get("t")).toBe("length");
  expect(q3.get("ribT")).toBe("length");
});
