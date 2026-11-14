// A diagram as the document keeps it (src/diagram.ts): draw.io's XML from records, and records applied
// with as few changes as there are differences, so that concurrent edits of two users merge.
import { save } from "@automerge/automerge";
import { initSubduction, Repo } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { applyPages, diagramXml, type CellRecord, type PageRecord } from "../src/diagram.ts";

beforeAll(() => initSubduction());

const box = (id: string, x: number, style = "rounded=0;"): CellRecord => ({ tag: "mxCell", attributes: { id, value: id.toUpperCase(), style, vertex: "1", parent: "1" }, content: `<mxGeometry x="${x}" y="40" width="120" height="60" as="geometry"/>` });
const page = (cells: CellRecord[], id = "p1"): PageRecord => ({
  id,
  name: "Page-1",
  model: { grid: "1" },
  cells: Object.fromEntries([{ tag: "mxCell", attributes: { id: "0" }, content: "" }, { tag: "mxCell", attributes: { id: "1", parent: "0" }, content: "" }, ...cells].map((c) => [c.attributes["id"]!, c])),
  order: ["0", "1", ...cells.map((c) => c.attributes["id"]!)],
});

test("draw.io's XML has the cells in their order, user objects around their mxCell, and attributes sorted and escaped", () => {
  const p = page([box("a", 40), { tag: "object", attributes: { id: "b", label: 'Say "hi" & <go>' }, cell: { style: "", vertex: "1", parent: "1" }, content: '<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/>' }]);
  expect(diagramXml([p])).toBe(
    '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel grid="1"><root><mxCell id="0"></mxCell><mxCell id="1" parent="0"></mxCell>' +
      '<mxCell id="a" parent="1" style="rounded=0;" value="A" vertex="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
      '<object id="b" label="Say &quot;hi&quot; &amp; &lt;go&gt;"><mxCell parent="1" style="" vertex="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></object>' +
      "</root></mxGraphModel></diagram></mxfile>",
  );
});

test("applying pages writes only what differs: a moved cell's content, a restyled cell's style, added and removed cells in place", () => {
  const doc: { pages?: PageRecord[] } = {};
  applyPages(doc, [page([box("a", 40), box("b", 200), box("c", 400)])]);
  const before = doc.pages![0]!;
  const keepA = before.cells["a"]!;
  applyPages(doc, [page([box("a", 50), box("b", 200, "rounded=1;"), box("d", 600)])]);
  const after = doc.pages![0]!;
  // The same objects, changed in place.
  expect(after).toBe(before);
  expect(after.cells["a"]).toBe(keepA);
  expect(after.cells["a"]!.content).toContain('x="50"');
  expect(after.cells["b"]!.attributes["style"]).toBe("rounded=1;");
  expect(after.cells["c"]).toBeUndefined();
  expect(after.order).toEqual(["0", "1", "a", "b", "d"]);
  // A cell brought to the front reorders them.
  applyPages(doc, [{ ...page([box("b", 200, "rounded=1;"), box("d", 600), box("a", 50)]) }]);
  expect(doc.pages![0]!.order).toEqual(["0", "1", "b", "d", "a"]);
});

test("pages are added, removed and renamed", () => {
  const doc: { pages?: PageRecord[] } = {};
  applyPages(doc, [page([box("a", 40)]), page([], "p2")]);
  applyPages(doc, [{ ...page([box("a", 40)]), name: "Front" }]);
  expect(doc.pages!.map((p) => [p.id, p.name])).toEqual([["p1", "Front"]]);
});

test("two users' concurrent edits merge: other cells, and other properties of the same cell", () => {
  const a = new Repo().create<{ pages?: PageRecord[] }>({});
  a.change((d) => applyPages(d, [page([box("x", 40), box("y", 200)])]));
  const b = new Repo().import<{ pages?: PageRecord[] }>(save(a.doc()));
  // A moves x and adds z; B restyles x and moves y.
  a.change((d) => applyPages(d, [page([box("x", 90), box("y", 200), box("z", 600)])]));
  b.change((d) => applyPages(d, [page([box("x", 40, "fillColor=red;"), box("y", 300)])]));
  a.merge(b);
  const merged = a.doc().pages![0]!;
  expect(merged.cells["x"]!.content).toContain('x="90"');
  expect(merged.cells["x"]!.attributes["style"]).toBe("fillColor=red;");
  expect(merged.cells["y"]!.content).toContain('x="300"');
  expect(merged.order).toEqual(["0", "1", "x", "y", "z"]);
});

test("an editor's changes are applied as changes: a snapshot older than others' changes doesn't take them back", async () => {
  const { applyChanges } = await import("../src/diagram.ts");
  const shown = [page([box("x", 40), box("y", 200)])];
  const doc: { pages?: PageRecord[] } = JSON.parse(JSON.stringify({ pages: shown }));
  // Meanwhile another user recoloured x, added w and removed y; this editor moved x and added v, without knowing.
  doc.pages![0]!.cells["x"]!.attributes["style"] = "fillColor=red;";
  doc.pages![0]!.cells["w"] = box("w", 900);
  doc.pages![0]!.order.push("w");
  delete doc.pages![0]!.cells["y"];
  doc.pages![0]!.order.splice(doc.pages![0]!.order.indexOf("y"), 1);
  applyChanges(doc, shown, [page([box("x", 90), box("y", 200), box("v", 700)])]);
  const p = doc.pages![0]!;
  expect(p.cells["x"]!.content).toContain('x="90"');
  expect(p.cells["x"]!.attributes["style"]).toBe("fillColor=red;");
  expect(p.cells["y"]).toBeUndefined();
  expect(Object.keys(p.cells).sort()).toEqual(["0", "1", "v", "w", "x"]);
  expect(p.order).toEqual(["0", "1", "x", "v", "w"]);
});

test("a cell brought to the front moves in the order, and cells others added stay in it", async () => {
  const { applyChanges } = await import("../src/diagram.ts");
  const shown = [page([box("a", 0), box("b", 0), box("c", 0)])];
  const doc: { pages?: PageRecord[] } = JSON.parse(JSON.stringify({ pages: shown }));
  doc.pages![0]!.order.push("z");
  doc.pages![0]!.cells["z"] = box("z", 0);
  applyChanges(doc, shown, [page([box("b", 0), box("c", 0), box("a", 0)])]);
  expect(doc.pages![0]!.order).toEqual(["0", "1", "b", "c", "a", "z"]);
});

test("a new diagram's pages are the empty diagram's, so that every editor starts from the same page", async () => {
  const { emptyPages } = await import("../src/diagram.ts");
  const { EMPTY_DIAGRAM } = await import("../src/svg.ts");
  expect(diagramXml(emptyPages())).toBe(EMPTY_DIAGRAM.replace('<mxCell id="0"/>', '<mxCell id="0"></mxCell>').replace('<mxCell id="1" parent="0"/>', '<mxCell id="1" parent="0"></mxCell>'));
});
