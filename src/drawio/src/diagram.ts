/**
 * A diagram as the document keeps it, so that collaborators' edits merge per shape and per property,
 * as tldraw's records do: each page's cells as records keyed by their id, in an order of their own,
 * each cell's element attributes as a map, and what is inside it (its geometry) as one value. One user
 * moving a shape while another recolours it keeps both; two moving it keep one. draw.io's own XML is
 * read and written from these, so that the editor is told only what changed (`merge`).
 */

/** One cell: its element (`mxCell`, or a user object such as `object` around one), the attributes of both, and its children as XML. */
export interface CellRecord {
  tag: string;
  attributes: Record<string, string>;
  /** The attributes of the `mxCell` inside a user object. */
  cell?: Record<string, string>;
  /** The XML of the cell's children, e.g. its `mxGeometry`. */
  content: string;
}

export interface PageRecord {
  id: string;
  name: string;
  /** The `mxGraphModel`'s attributes (grid, page size, background), without the view's scroll. */
  model: Record<string, string>;
  cells: Record<string, CellRecord>;
  /** The cells' ids in drawing order. */
  order: string[];
}

/**
 * The pages of a new diagram, as EMPTY_DIAGRAM (svg.ts) has them: one page with draw.io's two root
 * cells, under a fixed id, which every editor of the diagram starts from. Without it, each editor
 * would make up a page of its own, and their first saves would make two.
 */
export const emptyPages = (): PageRecord[] => [
  {
    id: "page-1",
    name: "Page-1",
    model: {},
    cells: { "0": { tag: "mxCell", attributes: { id: "0" }, content: "" }, "1": { tag: "mxCell", attributes: { id: "1", parent: "0" }, content: "" } },
    order: ["0", "1"],
  },
];

/** The `mxGraphModel` attributes that are the editor's scroll position, not the diagram's. */
const VIEW_ATTRIBUTES = new Set(["dx", "dy"]);

const attributesOf = (element: Element): Record<string, string> => Object.fromEntries([...element.attributes].map((a) => [a.name, a.value]));

/**
 * The pages of draw.io's XML (`mxfile`, or one `mxGraphModel`), as records; undefined if a page is
 * compressed, as an exported file's are, which the editor reads but this doesn't.
 */
export function parseDiagram(xml: string): PageRecord[] | undefined {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  if (dom.querySelector("parsererror")) return undefined;
  const root = dom.documentElement;
  const diagrams = root.localName === "mxfile" ? [...root.children].filter((e) => e.localName === "diagram") : [root];
  const pages: PageRecord[] = [];
  for (const diagram of diagrams) {
    const model = diagram.localName === "mxGraphModel" ? diagram : [...diagram.children].find((e) => e.localName === "mxGraphModel");
    if (!model) return undefined;
    const page: PageRecord = { id: diagram.getAttribute("id") ?? "page", name: diagram.getAttribute("name") ?? "Page", model: {}, cells: {}, order: [] };
    for (const [name, value] of Object.entries(attributesOf(model))) if (!VIEW_ATTRIBUTES.has(name)) page.model[name] = value;
    const cells = [...model.children].find((e) => e.localName === "root");
    for (const element of cells ? [...cells.children] : []) {
      const id = element.getAttribute("id");
      if (!id) continue;
      const inner = element.localName === "mxCell" ? undefined : [...element.children].find((e) => e.localName === "mxCell");
      const holder = inner ?? element;
      const record: CellRecord = { tag: element.localName, attributes: attributesOf(element), content: [...holder.children].map((c) => new XMLSerializer().serializeToString(c)).join("") };
      if (inner) record.cell = attributesOf(inner);
      page.cells[id] = record;
      page.order.push(id);
    }
    pages.push(page);
  }
  return pages;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;");
// Sorted, so that the same pages are the same XML, however their attributes came in.
const attributes = (map: Record<string, string>) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => ` ${name}="${escape(value)}"`).join("");

/** draw.io's XML of the pages, as an `mxfile` the editor loads or merges. */
export function diagramXml(pages: readonly PageRecord[]): string {
  const page = (p: PageRecord) => {
    const cells = p.order.flatMap((id) => {
      const c = p.cells[id];
      if (!c) return [];
      return [c.cell ? `<${c.tag}${attributes(c.attributes)}><mxCell${attributes(c.cell)}>${c.content}</mxCell></${c.tag}>` : `<${c.tag}${attributes(c.attributes)}>${c.content}</${c.tag}>`];
    });
    return `<diagram id="${escape(p.id)}" name="${escape(p.name)}"><mxGraphModel${attributes(p.model)}><root>${cells.join("")}</root></mxGraphModel></diagram>`;
  };
  return `<mxfile>${pages.map(page).join("")}</mxfile>`;
}

/** Sets `into`'s keys to `from`'s, key by key, removing the others: only changed keys are written. */
function updateMap(into: Record<string, string>, from: Record<string, string>): void {
  for (const key of Object.keys(into)) if (!(key in from)) delete into[key];
  for (const [key, value] of Object.entries(from)) if (into[key] !== value) into[key] = value;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Updates the order `into` to `from`: removed and added ids where they are, the whole list only if existing cells changed places. */
function updateOrder(into: string[], from: readonly string[]): void {
  const keep = new Set(from);
  for (let i = into.length - 1; i >= 0; i--) if (!keep.has(into[i]!)) into.splice(i, 1);
  const existing = new Set(into);
  const common = from.filter((id) => existing.has(id));
  if (common.some((id, i) => into[i] !== id)) {
    into.splice(0, into.length, ...from);
    return;
  }
  from.forEach((id, i) => {
    if (into[i] !== id) into.splice(i, 0, id);
  });
}

/**
 * Makes the document's pages those of `pages` with as few changes as there are differences, inside a
 * `change` of the document: so that a concurrent change of another cell, or of another property of
 * the same cell, merges with it.
 */
export function applyPages(doc: { pages?: PageRecord[] }, pages: readonly PageRecord[]): void {
  if (!doc.pages) doc.pages = [];
  const list = doc.pages;
  const ids = new Set(pages.map((p) => p.id));
  for (let i = list.length - 1; i >= 0; i--) if (!ids.has(list[i]!.id)) list.splice(i, 1);
  pages.forEach((page, i) => {
    let at = list.findIndex((p) => p.id === page.id);
    if (at < 0) {
      list.splice(i, 0, copy(page));
      return;
    }
    if (at !== i) {
      // Moved among the pages: taken out and put in again, as pages are rarely reordered.
      const [moved] = list.splice(at, 1);
      list.splice(i, 0, copy(moved!));
      at = i;
    }
    const into = list[at]!;
    if (into.name !== page.name) into.name = page.name;
    updateMap(into.model, page.model);
    for (const id of Object.keys(into.cells)) if (!(id in page.cells)) delete into.cells[id];
    for (const [id, cell] of Object.entries(page.cells)) {
      const old = into.cells[id];
      if (!old || old.tag !== cell.tag || !old.cell !== !cell.cell) {
        into.cells[id] = copy(cell);
        continue;
      }
      updateMap(old.attributes, cell.attributes);
      if (old.cell && cell.cell) updateMap(old.cell, cell.cell);
      if (old.content !== cell.content) old.content = cell.content;
    }
    updateOrder(into.order, page.order);
  });
}

/** Applies to `into` the changes from `from` to `to` of one map: set and removed keys. */
function changeMap(into: Record<string, string>, from: Record<string, string>, to: Record<string, string>): void {
  for (const key of Object.keys(from)) if (!(key in to) && key in into) delete into[key];
  for (const [key, value] of Object.entries(to)) if (from[key] !== value && into[key] !== value) into[key] = value;
}

/**
 * Applies to the order `into` the changes from `from` to `to`: removed ids out, added ids in after
 * the cell before them, and cells that changed places moved, with the cells others added meanwhile
 * kept where they are.
 */
function changeOrder(into: string[], from: readonly string[], to: readonly string[]): void {
  const removed = new Set(from.filter((id) => !to.includes(id)));
  for (let i = into.length - 1; i >= 0; i--) if (removed.has(into[i]!)) into.splice(i, 1);
  const before = new Set(from);
  // Cells that changed places: the ids both orders have, in another relative order.
  const common = to.filter((id) => before.has(id));
  const was = from.filter((id) => common.includes(id));
  if (common.some((id, i) => was[i] !== id)) {
    const slots = into.flatMap((id, i) => (common.includes(id) ? [i] : []));
    const placed = common.filter((id) => into.includes(id));
    slots.forEach((slot, i) => {
      if (into[slot] !== placed[i]) into[slot] = placed[i]!;
    });
  }
  to.forEach((id, i) => {
    if (before.has(id) || into.includes(id)) return;
    // After the cell before it in `to` that the list has, else at the start.
    let after = -1;
    for (let j = i - 1; j >= 0 && after < 0; j--) after = into.indexOf(to[j]!);
    into.splice(after + 1, 0, id);
  });
}

/**
 * Applies to the document the changes from `from`, the pages the editor showed, to `to`, the pages
 * it shows now, inside a `change` of the document: only what this editor changed, so that changes
 * others made meanwhile, which the document has and `to` may not yet, stay. An editor's snapshot can
 * predate a merge of others' changes that is on its way to it.
 */
export function applyChanges(doc: { pages?: PageRecord[] }, from: readonly PageRecord[], to: readonly PageRecord[]): void {
  if (!doc.pages) doc.pages = [];
  const list = doc.pages;
  const old = new Map(from.map((p) => [p.id, p]));
  const now = new Set(to.map((p) => p.id));
  for (const p of from) {
    if (now.has(p.id)) continue;
    const at = list.findIndex((x) => x.id === p.id);
    if (at >= 0) list.splice(at, 1);
  }
  to.forEach((page, i) => {
    const was = old.get(page.id);
    const into = list.find((p) => p.id === page.id);
    if (!was || !into) {
      if (!into) list.splice(Math.min(i, list.length), 0, copy(page));
      return;
    }
    if (was.name !== page.name && into.name !== page.name) into.name = page.name;
    changeMap(into.model, was.model, page.model);
    for (const id of Object.keys(was.cells)) if (!(id in page.cells)) delete into.cells[id];
    for (const [id, cell] of Object.entries(page.cells)) {
      const before = was.cells[id];
      const target = into.cells[id];
      if (!before || !target || before.tag !== cell.tag || !before.cell !== !cell.cell) {
        if (JSON.stringify(before) !== JSON.stringify(cell)) into.cells[id] = copy(cell);
        continue;
      }
      changeMap(target.attributes, before.attributes, cell.attributes);
      if (target.cell && before.cell && cell.cell) changeMap(target.cell, before.cell, cell.cell);
      if (before.content !== cell.content && target.content !== cell.content) target.content = cell.content;
    }
    changeOrder(into.order, was.order, page.order);
  });
}

