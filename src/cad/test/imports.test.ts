// Imports of documents in model code (research/02, "Verdict: imports in code"; research/21, "Files
// as modules"): data documents, JS files and files as text or bytes, read from the repo, pinned by
// heads or following their document.
import { ImmutableString, initSubduction, Repo, stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { beforeAll, expect, test, vi } from "vitest";
import { createImports, fileBytes, fileKind, fileText, importKinds, isFile, moduleOf } from "../src/components/imports.ts";
import { dataModule, documentImports, moduleKey, textModule } from "../src/kernel/imports.ts";
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
  expect(documentImports(source)).toEqual([
    { specifier: "automerge:abc", type: undefined },
    { specifier: "automerge:def", type: undefined },
  ]);
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

test("what a file is: its MIME type, else its extension, and its content as text or bytes", () => {
  expect(fileKind({ content: "", mimeType: "text/javascript" })).toBe("js");
  expect(fileKind({ content: "", mimeType: "application/json; charset=utf-8" })).toBe("json");
  expect(fileKind({ content: "", mimeType: "image/svg+xml" })).toBe("svg");
  expect(fileKind({ content: "", mimeType: "image/png", extension: "json" })).toBe("image");
  expect(fileKind({ content: "", mimeType: "text/markdown", extension: "js" })).toBe("other");
  // The sidebar's type for what the browser doesn't know, the file tool's default, and none: the extension says.
  expect(fileKind({ content: "", mimeType: "application/octet-stream", extension: "js" })).toBe("js");
  expect(fileKind({ content: "", mimeType: "text/plain", extension: ".JSON" })).toBe("json");
  expect(fileKind({ content: "", extension: "png" })).toBe("image");
  expect(fileKind({ content: "", mimeType: "application/octet-stream", extension: "stl" })).toBe("other");

  const utf8 = new TextEncoder().encode("Grüße");
  expect(fileText({ content: "a" })).toBe("a");
  expect(fileText({ content: new ImmutableString("b") })).toBe("b");
  expect(fileText({ content: utf8 })).toBe("Grüße");
  expect(fileText({ content: new Uint8Array([0xff, 0xfe, 0x00]) })).toBeUndefined();
  expect(fileBytes({ content: "Grüße" })).toEqual(utf8);
  expect(fileBytes({ content: new ImmutableString("Grüße") })).toEqual(utf8);
  expect(fileBytes({ content: utf8 })).toBe(utf8);
});

test("a file is a document of the file datatype, a CAD model, one without a datatype with a file's content and MIME type, or one of another datatype with an extension too", () => {
  expect(isFile({ "@patchwork": { type: "file" }, content: new Uint8Array(), mimeType: "application/octet-stream" })).toBe(true);
  expect(isFile({ "@patchwork": { type: "cad-model" }, content: "", mimeType: "application/javascript" })).toBe(true);
  expect(isFile({ content: "export const a = 1;", mimeType: "application/javascript" })).toBe(true);
  // A draw.io diagram (src/drawio), a .drawio.svg file of a datatype of its own.
  const diagram = { "@patchwork": { type: "drawio" }, name: "Bracket", extension: "drawio.svg", mimeType: "image/svg+xml", content: "<svg/>" };
  expect(isFile(diagram)).toBe(true);
  expect(isFile(diagram) && fileKind(diagram)).toBe("svg");
  // Data that happens to have a `content` key.
  expect(isFile({ content: "Hello", title: "Note" })).toBe(false);
  expect(isFile({ "@patchwork": { type: "sheet" }, content: "a", mimeType: "text/plain" })).toBe(false);
  expect(isFile({ content: { a: 1 }, mimeType: "text/plain" })).toBe(false);
  expect(importKinds({ content: "Hello", title: "Note" })).toEqual(["data"]);
  expect(moduleOf({ content: "Hello", w: 3 })).toEqual({ kind: "data", value: { content: "Hello", w: 3 } });
});

test("a file is code, data, text or bytes as its attribute asks, where its kind allows", () => {
  const js = { content: new TextEncoder().encode("export const a = 1;"), mimeType: "application/octet-stream", extension: "js" };
  const json = { content: new TextEncoder().encode('{"a":1}'), mimeType: "application/octet-stream", extension: "json" };
  const png = { content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png", extension: "png" };
  const svg = { content: "<svg/>", mimeType: "image/svg+xml", extension: "svg" };
  // Uploaded through the sidebar, as bytes with a generic type, JS and JSON still import without an attribute.
  expect(moduleOf(js)).toEqual({ kind: "js", code: "export const a = 1;" });
  expect(moduleOf(json)).toEqual({ kind: "data", value: { a: 1 } });
  expect(moduleOf(json, "json")).toEqual({ kind: "data", value: { a: 1 }, json: true });
  expect(moduleOf({ width: 3 }, "json")).toEqual({ kind: "data", value: { width: 3 }, json: true });
  expect(moduleOf(js, "text")).toEqual({ kind: "text", text: "export const a = 1;" });
  expect(moduleOf(svg, "text")).toEqual({ kind: "text", text: "<svg/>" });
  expect(moduleOf(svg, "bytes", "automerge:x#h")).toEqual({ kind: "bytes", bytes: new TextEncoder().encode("<svg/>"), id: "automerge:x#h" });
  expect(moduleOf(png, "bytes", "id")).toMatchObject({ kind: "bytes", bytes: png.content });
  // Without the attribute it needs, a file is an error that names the way out.
  expect(moduleOf(svg)).toMatchObject({ kind: "problem", problem: /image\/svg\+xml.*with \{ type: "text" \} or with \{ type: "bytes" \}/ });
  expect(moduleOf(png)).toMatchObject({ kind: "problem", problem: /with \{ type: "bytes" \}$/ });
  expect(moduleOf(png, "text")).toMatchObject({ kind: "problem", problem: /can't be imported with \{ type: "text" \}/ });
  expect(moduleOf(js, "json")).toMatchObject({ kind: "problem", problem: /with \{ type: "json" \}/ });
  expect(moduleOf({ content: new Uint8Array([0xff]), mimeType: "application/octet-stream" }, "text")).toMatchObject({ kind: "problem", problem: /isn't text/ });
  expect(moduleOf({ width: 3 }, "bytes")).toMatchObject({ kind: "problem", problem: /isn't a file/ });
  expect(importKinds(js)).toEqual(["code", "text", "bytes"]);
  expect(importKinds(json)).toEqual(["data", "text", "bytes"]);
  expect(importKinds(png)).toEqual(["bytes"]);
  expect(importKinds(svg)).toEqual(["text", "bytes"]);
  expect(importKinds({ content: new Uint8Array([0xff]), mimeType: "application/octet-stream" })).toEqual(["bytes"]);
  expect(importKinds({ width: 3 })).toEqual(["data"]);
});

test("attributes: the specifier and the attribute become the module's URL, and every line stays where it was", () => {
  const source = `import logo from "automerge:abc" with { type: "text" };\nimport label from "automerge:abc" with {\n  type: "bytes"\n};\nimport data from "automerge:def" with { type: "json" };\nexport * from "automerge:ghi" with { type: "text" };\nexport default function main() {}\n`;
  expect(documentImports(source)).toEqual([
    { specifier: "automerge:abc", type: "text" },
    { specifier: "automerge:abc", type: "bytes" },
    { specifier: "automerge:def", type: "json" },
    { specifier: "automerge:ghi", type: "text" },
  ]);
  const out = prepare(source, (specifier, type) => `blob:${moduleKey(specifier, type).replace(/\W/g, "")}`);
  expect(out.split("\n")).toHaveLength(source.split("\n").length);
  expect(out.split("\n").slice(0, 6)).toEqual([`import logo from "blob:automergeabcwithtext";`, `import label from "blob:automergeabcwithbytes"`, "", ";", `import data from "blob:automergedefwithjson";`, `export * from "blob:automergeghiwithtext";`]);
  const error = (code: string) => {
    try {
      prepare(code, () => "blob:x");
    } catch (e) {
      return e;
    }
    return undefined;
  };
  expect(error(`export const a = 1;\nimport x from "automerge:abc" with { type: "css" };\n`)).toMatchObject({ kind: "import", line: 2, message: /automerge:abc can't be imported: the type "css" isn't supported, only \{ type: "text" \}, \{ type: "bytes" \}, \{ type: "json" \}/ });
  expect(error(`import x from "automerge:abc" with { mode: "text" };\n`)).toMatchObject({ kind: "import", line: 1, message: /the attribute mode isn't supported/ });
  expect(error(`import x from "replicad" with { type: "json" };\n`)).toMatchObject({ kind: "import", line: 1 });
});

test("text and JSON modules: the text, and only the default export", async () => {
  expect((await load(textModule('a "quoted"\nline')))["default"]).toBe('a "quoted"\nline');
  const json = await load(dataModule({ a: 1 }, true));
  expect(Object.keys(json)).toEqual(["default"]);
});

test("a document imported as several kinds is a module of each; locks read followed documents at their versions", async () => {
  const repo = new Repo();
  (globalThis as { repo?: Repo }).repo = repo;
  try {
    const file = repo.create({ content: new TextEncoder().encode("one"), mimeType: "text/plain", extension: "txt", name: "note" });
    const before = file.heads();
    file.change((d) => (d.content = new TextEncoder().encode("two")));
    const imports = createImports(() => {});
    const source = `import a from "${file.url}" with { type: "text" };\nimport b from "${file.url}" with { type: "bytes" };\n`;
    const latest = await imports.read(source);
    expect(latest.imports[moduleKey(file.url, "text")]).toEqual({ kind: "text", text: "two" });
    expect(latest.imports[moduleKey(file.url, "bytes")]).toMatchObject({ kind: "bytes", id: `${file.url}#${file.heads().join("|")}` });
    expect(latest.documents.map((d) => [d.key, d.heads])).toEqual([
      [moduleKey(file.url, "text"), file.heads()],
      [moduleKey(file.url, "bytes"), file.heads()],
    ]);
    const locked = await imports.read(source, { [file.url]: before });
    expect(locked.imports[moduleKey(file.url, "text")]).toEqual({ kind: "text", text: "one" });
    expect(locked.key).not.toBe(latest.key);
    expect(imports.has(file.url, before)).toBe(true);
    expect(imports.has(file.url, ["2ZpxcJvGYuEcyRaZUAgfQMTVkZz6HTaLMLtrmn4sDmDw" as never] as never)).toBe(false);
    imports.dispose();
  } finally {
    delete (globalThis as { repo?: Repo }).repo;
  }
});
