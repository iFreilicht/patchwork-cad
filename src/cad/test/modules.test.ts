// Modules evaluated without import() (research/08, "Evaluation without import()"): what they export
// and import, as ES modules would, and where an error in them is.
import { expect, test } from "vitest";
import { dataNamespace, evaluate, fileNamespace, lineFromStack, type Namespace } from "../src/kernel/modules.ts";
import { prepare, prepareImported } from "../src/kernel/prepare.ts";

/** Evaluates `source` as an imported JS document, with the documents it imports by their specifiers. */
const module = (source: string, modules: Record<string, Namespace> = {}) => evaluate(prepareImported(source, (specifier) => specifier), "cad-document", (key) => modules[key]!);

test("every kind of export is in the namespace", async () => {
  const source = [
    `export const a = 1, { b, c: [d, ...e] } = { b: 2, c: [3, 4, 5] };`,
    `export function f() { return "f"; }`,
    `export class C {}`,
    `const g = 7;`,
    `export { g as h, g };`,
    `export default (a + 1) * 10;`,
    `export * from "automerge:star";`,
    `export * as all from "automerge:star";`,
    `export { x as y, default as z } from "automerge:star";`,
  ].join("\n");
  const star = { x: "x", w: "w", default: "star default" };
  const ns = await module(source, { "automerge:star": star });
  expect({ ...ns }).toEqual({ x: "x", w: "w", a: 1, b: 2, d: 3, e: [4, 5], f: ns["f"], C: ns["C"], h: 7, g: 7, default: 20, all: star, y: "x", z: "star default" });
  expect((ns["f"] as () => string)()).toBe("f");
});

test("a default function or class keeps its name in the module; an anonymous one is a value", async () => {
  expect(await module(`export default function main() { return typeof main; }`).then((ns) => (ns["default"] as () => string)())).toBe("function");
  expect(typeof (await module(`export default class {}`))["default"]).toBe("function");
  expect(await module(`export default function () { return 1; }\n(0);`).then((ns) => (ns["default"] as () => number)())).toBe(1);
});

test("exports are live and imports are bound before the first statement, as in a module", async () => {
  const ns = await module(`export let n = 1;\nexport const bump = () => n++;\nexport const early = value;\nimport { value } from "automerge:v";\n`, { "automerge:v": { value: 5 } });
  (ns["bump"] as () => void)();
  expect(ns["n"]).toBe(2);
  expect(ns["early"]).toBe(5);
});

test("an import of a name the document doesn't export fails before any statement runs", async () => {
  const ran: string[] = [];
  (globalThis as Record<string, unknown>)["ranProbe"] = ran;
  await expect(module(`globalThis.ranProbe.push("ran");\nimport { missing } from "automerge:v";\n`, { "automerge:v": { other: 1 } })).rejects.toThrow(SyntaxError);
  expect(ran).toEqual([]);
});

test("an error's line is the model's, also when it is thrown in an imported document", async () => {
  const lib = await module(`export const fail = () => {\n  throw new Error("from the library");\n};\n`);
  const code = prepare(`import { fail } from "automerge:lib";\nexport const defaultParams = {};\nexport default function main() {\n  return fail();\n}\n`, (specifier) => specifier);
  const model = await evaluate(code, "cad-model", () => lib);
  let stack: unknown;
  try {
    (model["default"] as () => void)();
  } catch (error) {
    stack = (error as Error).stack;
  }
  expect(lineFromStack(stack)).toBe(4);
});

test("a data document's namespace has its keys, with the whole document as its default; as JSON, only the default", () => {
  const ns = dataNamespace({ hole_diameter: 8, "hole-depth": 3, default: 1, nested: { a: [1] } });
  expect({ ...ns }).toEqual({ default: { hole_diameter: 8, "hole-depth": 3, default: 1, nested: { a: [1] } }, hole_diameter: 8, "hole-depth": 3, nested: { a: [1] } });
  expect(dataNamespace(42)["default"]).toBe(42);
  expect(Object.keys(dataNamespace({ a: 1 }, true))).toEqual(["default"]);
  expect(fileNamespace('a "quoted"\nline')["default"]).toBe('a "quoted"\nline');
});

test("the model's line is found in each browser's stack format", () => {
  const encoded = "export%20default%20(async%20function%20(__cadImport%2C%20__cadExport)%20%7B%22use%20strict%22%3B";
  const stacks = {
    firefox: "fail@cad-document-2.js:2:9\nmain@cad-model-7.js:4:10\n",
    chromium: "Error: from the library\n    at fail (cad-document-2.js:2:9)\n    at Object.main (cad-model-7.js:4:10)",
    // WebKit keeps the first 1000 or so characters of a URL.
    webkit: `fail@data:text/javascript;name=cad-document-2.js;charset=utf-8,${encoded}xx:2:9\nmain@data:text/javascript;name=cad-model-7.js;charset=utf-8,${encoded}${"x".repeat(900)}:4:10\n@blob:null/8412c11e:8:14`,
  };
  for (const stack of Object.values(stacks)) expect(lineFromStack(stack)).toBe(4);
  expect(lineFromStack("fail@cad-document-2.js:2:9\n")).toBeUndefined();
});
