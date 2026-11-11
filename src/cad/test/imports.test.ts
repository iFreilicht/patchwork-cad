// Imports of documents in model code (research/02, "Verdict: imports in code"): data documents
// and JS files, read from the repo, pinned by heads or following their document.
import { initSubduction, Repo, stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { beforeAll, expect, test, vi } from "vitest";
import { createImports, moduleOf } from "../src/components/imports.ts";
import { dataModule, documentImports } from "../src/kernel/imports.ts";
import { prepare, prepareImported, PrepareError } from "../src/kernel/prepare.ts";

beforeAll(() => initSubduction());

const load = (code: string) => import(`data:text/javascript,${encodeURIComponent(code)}`) as Promise<Record<string, unknown>>;

test("a data document is a module of its keys, with the whole document as its default", async () => {
  const module = await load(dataModule({ hole_diameter: 8, "hole-depth": 3, default: 1, nested: { a: [1] } }));
  expect(module["hole_diameter"]).toBe(8);
  expect(module["hole-depth"]).toBe(3);
  expect(module["nested"]).toEqual({ a: [1] });
  expect(module["default"]).toEqual({ hole_diameter: 8, "hole-depth": 3, default: 1, nested: { a: [1] } });
  expect((await load(dataModule(42)))["default"]).toBe(42);
});

test("a document is JS, data or a problem by its content and type", () => {
  expect(moduleOf({ content: "export const a = 1;", mimeType: "application/javascript" })).toEqual({ kind: "js", code: "export const a = 1;" });
  expect(moduleOf({ content: '{"a":1}', mimeType: "application/json" })).toEqual({ kind: "data", value: { a: 1 } });
  expect(moduleOf({ width: 3, "@patchwork": { type: "sheet" } })).toEqual({ kind: "data", value: { width: 3, "@patchwork": { type: "sheet" } } });
  expect(moduleOf(5)).toEqual({ kind: "data", value: 5 });
  expect(moduleOf({ content: "x", mimeType: "text/markdown" })).toMatchObject({ kind: "problem", problem: /text\/markdown/ });
  expect(moduleOf({ content: "", mimeType: "application/javascript", "@patchwork": { type: "cad-model" } })).toMatchObject({ kind: "problem", problem: /models can't be imported/ });
  expect(moduleOf(undefined)).toMatchObject({ kind: "problem" });
});

test("a document's specifier becomes its module's URL, and every line stays where it was", () => {
  const source = `import { sketch } from "@patchwork-cad/features";\nimport { hole_diameter } from "automerge:abc";\nexport { a } from "automerge:def";\nexport default function main() {}\n`;
  expect(documentImports(source)).toEqual(["automerge:abc", "automerge:def"]);
  const out = prepare(source, (specifier) => `blob:${specifier.slice("automerge:".length)}`);
  expect(out.split("\n")).toHaveLength(source.split("\n").length);
  expect(out).toContain(`import { hole_diameter } from "blob:abc";`);
  expect(out).toContain(`export { a } from "blob:def";`);
});

test("an import that can't be resolved is an import error on its line", () => {
  const source = `export const defaultParams = {};\nimport { d } from "automerge:abc";\n`;
  const error = (() => {
    try {
      prepare(source, () => {
        throw new Error("it isn't there");
      });
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  expect(error).toBeInstanceOf(PrepareError);
  expect(error).toMatchObject({ kind: "import", line: 2, message: "automerge:abc can't be imported: it isn't there" });
  expect(() => prepare(`import x from "https://example.com/x.js";\n`)).toThrow(/automerge: URLs/);
});

test("an imported JS document gets provided modules, but its feature calls aren't named", () => {
  const code = `import { extrude } from "@patchwork-cad/features";\nimport { d } from "automerge:abc";\nexport const plate = (s) => extrude({ sketch: s, distance: d });\n`;
  const out = prepareImported(code, () => "blob:abc");
  expect(out).toContain(`const extrude = globalThis.patchworkCadFeatures["extrude"];`);
  expect(out).toContain(`import { d } from "blob:abc";`);
  expect(out).toContain("extrude({ sketch: s, distance: d });");
});

test("imports are read through imported JS; a pinned one keeps its version, a followed one reports changes", async () => {
  const repo = new Repo();
  (globalThis as { repo?: Repo }).repo = repo;
  try {
    const data = repo.create<{ hole_diameter: number }>({ hole_diameter: 8 });
    const lib = repo.create({ content: `import { hole_diameter } from "${data.url}";\nexport const r = hole_diameter / 2;\n`, mimeType: "application/javascript" });
    const pinned = stringifyAutomergeUrl({ documentId: data.documentId, heads: data.heads() });
    const onChange = vi.fn();
    const imports = createImports(onChange);
    const { imports: read, key } = await imports.read(`import { r } from "${lib.url}";\nimport { hole_diameter as old } from "${pinned}";\nimport x from "automerge:nope";\n`);
    expect(read[lib.url]).toMatchObject({ kind: "js" });
    expect(read[data.url]).toEqual({ kind: "data", value: { hole_diameter: 8 } });
    expect(read[pinned]).toEqual({ kind: "data", value: { hole_diameter: 8 } });
    expect(read["automerge:nope"]).toMatchObject({ kind: "problem", problem: /valid automerge URL/ });
    const path = `${data.url}/hole_diameter`;
    expect((await imports.read(`import d from "${path}";\n`)).imports[path]).toEqual({ kind: "data", value: 8 });

    data.change((d) => (d.hole_diameter = 10));
    expect(onChange).toHaveBeenCalled();
    const { imports: again, key: changed } = await imports.read(`import { r } from "${lib.url}";\nimport { hole_diameter as old } from "${pinned}";\n`);
    expect(again[data.url]).toEqual({ kind: "data", value: { hole_diameter: 10 } });
    expect(again[pinned]).toEqual({ kind: "data", value: { hole_diameter: 8 } });
    expect(changed).not.toBe(key);
    // Unchanged documents are the modules made before, and the same key.
    const twice = await imports.read(`import { r } from "${lib.url}";\n`);
    expect((await imports.read(`import { r } from "${lib.url}";\n`)).imports[data.url]).toBe(twice.imports[data.url]);
    expect((await imports.read(`import { r } from "${lib.url}";\n`)).key).toBe(twice.key);
    imports.dispose();
  } finally {
    delete (globalThis as { repo?: Repo }).repo;
  }
});
