import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { prepare } from "../src/kernel/prepare.ts";

const example = (name: string) => readFileSync(new URL(`../../features/examples/${name}.js`, import.meta.url), "utf8");

test("feature calls get their names and lines, without moving any line", () => {
  const source = example("m1");
  const out = prepare(source);
  expect(out.split("\n")).toHaveLength(source.split("\n").length);
  expect(out).toContain(`const extrude1 = extrude({ sketch: sketch1, distance: h }, { name: "extrude1", line: 9, variable: true });`);
  expect(out).toContain(`const sketch = globalThis.patchworkCadFeatures["sketch"];`);
});

test("features in loops get only their line; an explicit second argument keeps its name", () => {
  const out = prepare(example("m3"));
  expect(out).toContain(`const rib = sketch({ plane: plane("YZ", x - ribT / 2), profile }, { line: 15 });`);
  expect(out).toContain("{ line: 16, ...({ name: `rib${i}` })}");
});

test("derived parameters report their values on their own line, also without a semicolon", () => {
  const source = `import { sketch } from "@patchwork-cad/features";\nexport const defaultParams = { w: 60 };\nexport default function main({ w }) {\n  const r = w / 4;\n  const t = Math.min(w, 3)\n  return {};\n}\n`;
  const out = prepare(source);
  expect(out.split("\n")).toHaveLength(source.split("\n").length);
  expect(out).toContain(`const r = w / 4;; globalThis.patchworkCadDerived?.("r", r);`);
  expect(out).toContain(`const t = Math.min(w, 3); globalThis.patchworkCadDerived?.("t", t);`);
  const values: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>)["patchworkCadDerived"] = (name: string, value: unknown) => (values[name] = value);
  new Function("w", out.split("\n").slice(3, 5).join("\n"))(60);
  expect(values).toEqual({ r: 15, t: 3 });
});
