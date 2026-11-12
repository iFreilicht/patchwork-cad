// The documents a model imports, as its code has them (research/21, "The documents list"): the
// splices of Pin, Follow, Update, As, replacing, removing and renaming an import, and what uses it.
import { expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { documentStatements, follow, pin, removeStatement, renameImport, replaceDocument, setType, usedAnywhere, usersOf } from "../src/model/documents.ts";
import { applyToText } from "../src/model/splice.ts";
import { timeline } from "../src/model/timeline.ts";

const A = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG";
const B = "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa";

const MODEL = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
import settings from "${A}";
import { width } from '${A}';
import logo from "${B}" with { type: "text" };
import label from "${B}#h2|h1" with {
  type: "bytes"
};
export const defaultParams = { depth: settings.depth };
export default function main({ depth }) {
  const w = width * 2;
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, depth] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: settings.height });
  const extrude2 = extrude({ sketch: sketch1, distance: 1 });
  return { extrude1, extrude2, logo };
}
`;

const edit = (source: string, f: (s: ReturnType<typeof documentStatements>) => { start: number; end: number; text: string }[]) => applyToText(source, f(documentStatements(source, analyze(source).program)));

test("each import of a document is a statement of its module, named by its URL without heads and its type", () => {
  const statements = documentStatements(MODEL, analyze(MODEL).program);
  expect(statements.map((s) => [s.id, s.line, s.name, s.named])).toEqual([
    [A, 2, "settings", []],
    [A, 3, undefined, [{ imported: "width", local: "width" }]],
    [`${B} with text`, 4, "logo", []],
    [`${B} with bytes`, 5, "label", []],
  ]);
});

test("Pin, Follow and Update splice the specifier of every statement of the module, in its own quotes", () => {
  const pinned = edit(MODEL, (s) => pin(MODEL, s, A, ["x2", "x1"]));
  expect(pinned).toContain(`import settings from "${A}#x1|x2";`);
  expect(pinned).toContain(`import { width } from '${A}#x1|x2';`);
  expect(pinned.split("\n").length).toBe(MODEL.split("\n").length);
  expect(edit(pinned, (s) => follow(pinned, s, A))).toBe(MODEL);
  // Update: a pinned module gets the document's current heads.
  expect(edit(MODEL, (s) => pin(MODEL, s, `${B} with bytes`, ["h3"]))).toContain(`import label from "${B}#h3" with {`);
  // The text import of the same document is another module.
  expect(edit(MODEL, (s) => follow(MODEL, s, `${B} with bytes`))).toContain(`import logo from "${B}" with { type: "text" };`);
});

test("As rewrites only the attribute; replacing the document only the specifier", () => {
  const asBytes = edit(MODEL, (s) => setType(s, `${B} with text`, "bytes"));
  expect(asBytes).toContain(`import logo from "${B}" with { type: "bytes" };`);
  expect(edit(MODEL, (s) => setType(s, A, "json"))).toContain(`import settings from "${A}" with { type: "json" };`);
  expect(edit(MODEL, (s) => setType(s, `${B} with bytes`, undefined))).toContain(`import label from "${B}#h2|h1";\nexport const defaultParams`);
  expect(edit(MODEL, (s) => replaceDocument(MODEL, s, `${B} with text`, `${A}/logo`))).toContain(`import logo from "${A}/logo" with { type: "text" };`);
});

test("what uses an import: features directly or through derived values, the parameters, and anything for removing it", () => {
  const analysis = analyze(MODEL);
  const tl = timeline(MODEL, analysis, []);
  const statements = documentStatements(MODEL, analysis.program);
  const names = (r: { entries: number[]; params: boolean }) => ({ entries: r.entries.map((i) => (tl.entries[i]?.kind === "feature" ? tl.entries[i].name : "script")), params: r.params });
  expect(names(usersOf(analysis, tl, statements.filter((s) => s.id === A)))).toEqual({ entries: ["sketch1", "extrude1"], params: true });
  expect(names(usersOf(analysis, tl, statements.filter((s) => s.id === `${B} with bytes`)))).toEqual({ entries: [], params: false });
  expect(usedAnywhere(analysis.program, statements[2]!)).toBe(true);
  expect(usedAnywhere(analysis.program, statements[3]!)).toBe(false);
  const removed = applyToText(MODEL, removeStatement(MODEL, statements[3]!));
  expect(removed).not.toContain("label");
  expect(removed).toContain(`import logo from "${B}" with { type: "text" };\nexport const defaultParams`);
});

test("renaming an import renames its uses, keeps shorthand keys and exported names, and refuses names in use", () => {
  const analysis = analyze(MODEL);
  const [settings, , logo] = documentStatements(MODEL, analysis.program);
  const r = renameImport(analysis, logo!, "badge");
  if ("error" in r) throw new Error(r.error);
  const out = applyToText(MODEL, r.edits);
  expect(out).toContain(`import badge from "${B}" with { type: "text" };`);
  expect(out).toContain("return { extrude1, extrude2, logo: badge };");
  const s = renameImport(analysis, settings!, "config");
  if ("error" in s) throw new Error(s.error);
  expect(applyToText(MODEL, s.edits)).toContain("export const defaultParams = { depth: config.depth };");
  expect(applyToText(MODEL, s.edits)).toContain("distance: config.height");
  expect(renameImport(analysis, logo!, "width")).toEqual({ error: "width is already used in the model" });
  expect(renameImport(analysis, logo!, "1x")).toEqual({ error: "1x is not a valid name" });
  const exported = `import a from "${A}";\nexport { a };\n`;
  const e = renameImport(analyze(exported), documentStatements(exported, analyze(exported).program)[0]!, "b");
  if ("error" in e) throw new Error(e.error);
  expect(applyToText(exported, e.edits)).toBe(`import b from "${A}";\nexport { b as a };\n`);
});
