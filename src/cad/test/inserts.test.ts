// Documents entering a model (research/21, "Dropping, pasting, inserting"): reading drags and
// pastes, the names, kinds and versions of inserted imports and where they go, and the code that
// reads one picked value of a document, as an import or a configuration's link.
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { expect, test } from "vitest";
import { documentsInText, droppedDocuments, dropEffect } from "../src/components/dnd.ts";
import { defaultImport, fittingValues, valuePath, valueUrl } from "../src/components/imports.ts";
import { rowDragUrl } from "../src/components/editor/documents.ts";
import { pickProblem, PICK_LIMITS, type ValueTarget } from "../src/components/editor/inserts.ts";
import { analyze } from "../src/model/analyze.ts";
import { documentId, documentStatements, importName, insertImports, memberExpression, valueReference, type NewImport } from "../src/model/documents.ts";
import { namesIn } from "../src/model/refactor.ts";
import { applyToText } from "../src/model/splice.ts";

const A = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" as AutomergeUrl;
const B = "automerge:3JkKnj5eHUeJSP2sW2Ec7SBrYLmT" as AutomergeUrl;
const ID_A = A.slice("automerge:".length);

/** A drop's data, as a DataTransfer gives it. */
const data = (types: Record<string, string>) => ({ getData: (type: string) => types[type] ?? "" });

test("a drag's documents come from the richest type it has", () => {
  const dnd = JSON.stringify({ source: "sideboard", items: [{ url: A, name: "Dimensions", type: "datagrid" }, { url: B }, { url: A }, { url: "nope" }] });
  expect(droppedDocuments(data({ "text/x-patchwork-dnd": dnd, "text/x-patchwork-urls": JSON.stringify([B]) }))).toEqual([{ url: A, name: "Dimensions", type: "datagrid" }, { url: B }]);
  expect(droppedDocuments(data({ "text/x-patchwork-dnd": "{", "text/x-patchwork-urls": JSON.stringify([B, "x", A]) }))).toEqual([{ url: B }, { url: A }]);
  // The sideboard's web links, one per line.
  expect(droppedDocuments(data({ "text/uri-list": `http://localhost:4173/#doc=${ID_A}\r\nhttp://localhost:4173/#doc=${encodeURIComponent(B)}&tool=x\r\n` }))).toEqual([{ url: A }, { url: B }]);
  expect(droppedDocuments(data({ "text/plain": `${A}/rows/@3/width` }))).toEqual([{ url: `${A}/rows/@3/width` }]);
  expect(droppedDocuments(data({ "text/plain": "a dragged sentence" }))).toEqual([]);
  expect(documentsInText(`see ${A}`)).toEqual([]);
  expect(documentsInText(` ${A} \n#doc=nonsense\n${A}`)).toEqual([A]);
});

test("a drop is accepted with an effect the drag allows", () => {
  expect(["all", "uninitialized", "copy", "copyMove", "copyLink"].map((a) => dropEffect(a as DataTransfer["effectAllowed"]))).toEqual(["copy", "copy", "copy", "copy", "copy"]);
  expect(["move", "link", "linkMove", "none"].map((a) => dropEffect(a as DataTransfer["effectAllowed"]))).toEqual(["move", "link", "link", "none"]);
});

test("an import's name comes from the document's title, as an identifier no name in the model has", () => {
  const taken = new Set(["dims", "plate", "plate2"]);
  expect(importName("Dimensions", taken)).toBe("dimensions");
  expect(importName("Plate thickness (mm)", taken)).toBe("plateThicknessMm");
  expect(importName("Café crème", taken)).toBe("cafeCreme");
  expect(importName("HOLE TABLE", taken)).toBe("holeTABLE");
  expect(importName("3 holes", taken)).toBe("_3Holes");
  expect(importName("class", taken)).toBe("_class");
  expect(importName("日本", taken)).toBe("doc");
  expect(importName("dims", taken)).toBe("dims2");
  expect(importName("Plate", taken)).toBe("plate3");
});

const MODEL = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
import dims from "${A}";
// a comment
export const defaultParams = { depth: 5 };
export default function main({ depth }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [dims.w, depth] }) });
  return { sketch1 };
}
`;

const insert = (source: string, imports: NewImport[]) => applyToText(source, insertImports(source, analyze(source).program, imports));

test("an inserted import goes after the last import, or first if there is none, in one edit", () => {
  const lib: NewImport = { specifier: `${B}#h1`, type: undefined, binding: { kind: "namespace", local: "lib" } };
  const logo: NewImport = { specifier: B, type: "text", binding: { kind: "default", local: "logo" } };
  const edits = insertImports(MODEL, analyze(MODEL).program, [lib, logo]);
  expect(edits).toHaveLength(1);
  expect(applyToText(MODEL, edits)).toContain(`import dims from "${A}";\nimport * as lib from "${B}#h1";\nimport logo from "${B}" with { type: "text" };\n// a comment\n`);
  expect(insert("export default function main() {}\n", [logo])).toBe(`import logo from "${B}" with { type: "text" };\nexport default function main() {}\n`);
  expect(insert(`import a from "${A}";`, [logo])).toBe(`import a from "${A}";\nimport logo from "${B}" with { type: "text" };`);
  // A named one joins a statement of the same specifier that has named ones.
  const named = `import { w } from "${A}";\nexport default function main() {}\n`;
  expect(insert(named, [{ specifier: A, type: undefined, binding: { kind: "named", imported: "hole-depth", local: "holeDepth" } }])).toBe(`import { w, "hole-depth" as holeDepth } from "${A}";\nexport default function main() {}\n`);
});

test("Import imports a document in the first way it can as a value, code pinned and the rest following", () => {
  const heads = ["h2", "h1"];
  const file = (extension: string, mimeType: string, content: unknown = new TextEncoder().encode("text")) => ({ "@patchwork": { type: "file" }, name: "f", extension, mimeType, content });
  const of = (value: unknown, url: string = A) => defaultImport(url as AutomergeUrl, value, heads, "x");
  expect(of(file("js", "application/javascript"))).toEqual({ specifier: `${A}#h1|h2`, type: undefined, binding: { kind: "namespace", local: "x" } });
  expect(of(file("json", "application/octet-stream"))).toEqual({ specifier: A, type: undefined, binding: { kind: "default", local: "x" } });
  expect(of({ title: "Dimensions", w: 20 })).toEqual({ specifier: A, type: undefined, binding: { kind: "default", local: "x" } });
  expect(of(file("svg", "image/svg+xml"))).toMatchObject({ specifier: A, type: "text" });
  expect(of(file("md", "text/markdown"))).toMatchObject({ specifier: A, type: "text" });
  expect(of(file("png", "image/png", new Uint8Array([0x89, 0x50, 0xff])))).toMatchObject({ specifier: A, type: "bytes" });
  expect(of(file("stl", "application/octet-stream", new Uint8Array([0xff, 0xfe])))).toMatchObject({ specifier: A, type: "bytes" });
  // A URL with a path names a value: data, following.
  expect(of(5, `${A}/w`)).toEqual({ specifier: `${A}/w`, type: undefined, binding: { kind: "default", local: "x" } });
  // A pinned URL stays as it is.
  expect(of(file("js", "text/javascript"), `${A}#h3`)).toMatchObject({ specifier: `${A}#h3` });
  expect(of({ "@patchwork": { type: "cad-model" }, content: "", mimeType: "application/javascript" })).toBeUndefined();
  // A module the model imports already, pinned or not, is the same module: it isn't imported again.
  const pinned = of(file("js", "application/javascript"))!;
  const statements = documentStatements(`import * as lib from "${A}";`, analyze(`import * as lib from "${A}";`).program);
  expect(statements.some((s) => s.id === documentId(pinned.specifier, pinned.type))).toBe(true);
});

test("a picked value is read by a named import, an import of its path, or a member expression of an import there is", () => {
  const analysis = analyze(MODEL);
  const statements = documentStatements(MODEL, analysis.program);
  const taken = namesIn(analysis);
  const ref = (doc: string, path: (string | number)[], file = false) => valueReference(statements, taken, doc, path, file ? undefined : valueUrl(doc as AutomergeUrl, path), "Sizes");
  // The model imports A whole: a member expression of that, with brackets where a key isn't an identifier.
  expect(ref(A, ["rows", 3, "hole depth"])).toEqual({ expression: 'dims.rows[3]["hole depth"]', imports: [], id: A });
  // A top-level key of B: a named import, with `as` where its name is taken or isn't an identifier.
  expect(ref(B, ["width"])).toEqual({ expression: "width", imports: [{ specifier: B, type: undefined, binding: { kind: "named", imported: "width", local: "width" } }], id: B });
  expect(ref(B, ["depth"]).imports[0]!.binding).toEqual({ kind: "named", imported: "depth", local: "depth2" });
  expect(ref(B, ["hole-depth"]).imports[0]!.binding).toEqual({ kind: "named", imported: "hole-depth", local: "holeDepth" });
  // A deeper value: a default import of its URL with the path.
  expect(ref(B, ["rows", 3, "width"])).toEqual({ expression: "width", imports: [{ specifier: `${B}/rows/@3/width`, type: undefined, binding: { kind: "default", local: "width" } }], id: `${B}/rows/@3/width` });
  expect(ref(B, ["rows", 0]).imports[0]!.binding).toEqual({ kind: "default", local: "rows0" });
  // A file's content isn't addressed by paths: the whole file is imported, read by a member expression.
  expect(ref(B, ["rows", 0], true)).toEqual({ expression: "sizes.rows[0]", imports: [{ specifier: B, type: undefined, binding: { kind: "default", local: "sizes" } }], id: B });
  // `default` is no named export of a data module.
  expect(ref(B, ["default"]).imports[0]!.specifier).toBe(`${B}/default`);
  // Imports there are: a named one reads its key, a pinned one keeps its version for a new one, an import of the path is the value.
  const more = `import { rows } from "${B}#h1";\nimport w from "${B}/rows/@3/width";\n`;
  const s2 = documentStatements(more, analyze(more).program);
  const t2 = namesIn(analyze(more));
  expect(valueReference(s2, t2, B, ["rows", 1, "a b"], valueUrl(B, ["rows", 1, "a b"]), "x").expression).toBe('rows[1]["a b"]');
  expect(valueReference(s2, t2, B, ["rows", 3, "width"], valueUrl(B, ["rows", 3, "width"]), "x")).toEqual({ expression: "w", imports: [], id: `${B}/rows/@3/width` });
  expect(valueReference(s2, t2, B, ["depth"], valueUrl(B, ["depth"]), "x").imports).toEqual([{ specifier: `${B}#h1`, type: undefined, binding: { kind: "named", imported: "depth", local: "depth" } }]);
  // Written into the code, the named import joins the statement there is.
  const written = applyToText(more, insertImports(more, analyze(more).program, valueReference(s2, t2, B, ["depth"], undefined, "x").imports));
  expect(written).toContain(`import { rows, depth } from "${B}#h1";`);
  expect(memberExpression("d", ["a", 0, "b-c", "$d"])).toBe('d.a[0]["b-c"].$d');
});

test("a JS file's value is an export: a member of its namespace import, else a named import at the version given", () => {
  const lib = `import * as lib from "${A}#h1";\nimport * as data from "${B}";\n`;
  const s = documentStatements(lib, analyze(lib).program);
  const t = namesIn(analyze(lib));
  const js = (doc: string, path: (string | number)[]) => valueReference(s, t, doc, path, undefined, "Lib", true);
  expect(js(A, ["hole_diameter"])).toEqual({ expression: "lib.hole_diameter", imports: [], id: A });
  expect(js(`${A}#h2`, ["sizes", 0])).toEqual({ expression: "lib.sizes[0]", imports: [], id: A });
  // Not imported yet: the export by name, pinned as given, also for a deeper value; the default export by a default import.
  const none = new Set<string>();
  expect(valueReference([], none, `${B}#h3`, ["sizes", "w"], undefined, "Lib", true)).toEqual({ expression: "sizes.w", imports: [{ specifier: `${B}#h3`, type: undefined, binding: { kind: "named", imported: "sizes", local: "sizes" } }], id: B });
  expect(valueReference([], none, `${B}#h3`, ["default", "w"], undefined, "Lib", true)).toEqual({ expression: "lib.w", imports: [{ specifier: `${B}#h3`, type: undefined, binding: { kind: "default", local: "lib" } }], id: B });
  // A data document's namespace: its keys are members, anything else is read through its default.
  expect(valueReference(s, t, B, ["w"], valueUrl(B, ["w"]), "x").expression).toBe("data.w");
  expect(valueReference(s, t, B, ["default", "w"], valueUrl(B, ["default", "w"]), "x").expression).toBe("data.default.default.w");
});

test("a value's URL is automerge-repo's path syntax, and reads back", () => {
  expect(valueUrl(A, ["rows", 3, "width"])).toBe(`${A}/rows/@3/width`);
  const odd = ["a/b", "@at", "hole depth", 0];
  const url = valueUrl(A, odd);
  expect(url).toBe(`${A}/a%2Fb/%5C%40at/hole%20depth/@0`);
  expect(valuePath(url)).toEqual(odd);
  expect(valuePath(`${A}#h1`)).toEqual([]);
  expect(valuePath(`${A}/content/[2@abc-4@abc]`)).toBeUndefined();
});

test("a picker finds the numbers a field takes deep in a document, within limits, and says only then that there is none", () => {
  const isNumber = (v: unknown) => typeof v === "number";
  const doc = { title: "Deep", a: { b: [{ c: "x" }, { c: 7 }] }, d: 2 };
  expect(fittingValues(doc, isNumber, PICK_LIMITS)).toEqual({ paths: [["a", "b", 1, "c"], ["d"]], complete: true });
  expect(fittingValues({ title: "Words", a: ["x", { y: "z" }] }, isNumber, PICK_LIMITS)).toEqual({ paths: [], complete: true });
  // Over the limits, finding none proves nothing.
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i < 55 ? "x" : 1]));
  expect(fittingValues(wide, isNumber, PICK_LIMITS)).toEqual({ paths: [], complete: false });
  expect(fittingValues({ a: { b: { c: 1 } } }, isNumber, { keys: 50, nodes: 3, paths: 20 })).toEqual({ paths: [], complete: false });
  expect(fittingValues([1, 2, 3], isNumber, { keys: 50, nodes: 100, paths: 2 })).toEqual({ paths: [[0], [1]], complete: false });
});

test("why nothing can be picked for a field, each case in its own words", () => {
  const argument: ValueTarget = { kind: "argument", feature: "extrude1", param: "distance", label: "Distance" };
  const override: ValueTarget = { kind: "override", configuration: "c1", name: "Wide", key: "w" };
  const ready = (value: unknown) => ({ status: "ready" as const, value });
  const file = (extension: string, mimeType: string, text = "x") => ({ "@patchwork": { type: "file" }, extension, mimeType, content: new TextEncoder().encode(text) });
  const none = { paths: [], complete: true };
  expect(pickProblem("Words", ready({ a: "x" }), argument, none)).toBe("Words has no number to use for Distance of extrude1.");
  expect(pickProblem("Words", ready({ a: "x" }), argument, { paths: [], complete: false })).toBeUndefined();
  expect(pickProblem("Sizes", ready({ a: 1 }), override, { paths: [["a"]], complete: true })).toBeUndefined();
  expect(pickProblem("Sizes", { status: "loading", value: undefined }, argument, undefined)).toBe("Sizes is still loading.");
  expect(pickProblem("Sizes", { status: "unavailable", value: undefined, problem: "it can't be found" }, argument, undefined)).toBe("Sizes can't be loaded: it can't be found.");
  expect(pickProblem("Plate", ready({ "@patchwork": { type: "cad-model" }, content: "", mimeType: "application/javascript" }), argument, undefined)).toBe("Plate is a CAD model, which has no number to use for Distance of extrude1.");
  // A JS file's numbers are its exports, searched as data once it ran; a configuration can't link into it.
  expect(pickProblem("lib.js", ready(file("js", "application/javascript")), argument, undefined)).toBeUndefined();
  expect(pickProblem("lib.js", ready(file("js", "application/javascript")), argument, none)).toBe("lib.js has no number to use for Distance of extrude1.");
  expect(pickProblem("lib.js", ready(file("js", "application/javascript")), override, undefined)).toBe("lib.js is a file, and w in Wide can only link to a number in a data document.");
  expect(pickProblem("notes.md", ready(file("md", "text/markdown")), { kind: "default", key: "w" }, undefined)).toBe("notes.md is a text file, which has no number to use for the default of w.");
  expect(pickProblem("dims.json", ready(file("json", "application/json", '{"w":1}')), override, { paths: [["w"]], complete: true })).toBe("dims.json is a file, and w in Wide can only link to a number in a data document.");
  expect(pickProblem("dims.json", ready(file("json", "application/json", '{"w":1}')), argument, { paths: [["w"]], complete: true })).toBeUndefined();
});

test("a document row drags its document as the model reads it now, without heads", () => {
  expect(rowDragUrl({ role: "import", specifier: `${A}#h1|h2` })).toBe(A);
  expect(rowDragUrl({ role: "import", specifier: `${A}/rows/@0/width` })).toBe(`${A}/rows/@0/width`);
  expect(rowDragUrl({ role: "indirect", specifier: `${B}#h1` })).toBe(B);
  // A linked value's document, whose values a drop on a field offers.
  expect(rowDragUrl({ role: "link", specifier: `${A}/rows/@1/width` })).toBe(A);
  expect(rowDragUrl({ role: "import", specifier: "automerge:nope" })).toBeUndefined();
});
