/**
 * draw.io diagrams (src/drawio): a new diagram edited in draw.io's own editor, served with the tool
 * and asking no other site for anything, each change saved as a .drawio.svg; a change made elsewhere
 * loaded into the open editor; a version that can't be edited shown as its picture; and a diagram on a
 * CAD model's canvas, which follows it (research/21, "Canvas").
 */
import type { FrameLocator, Page } from "@playwright/test";
import { CAD_DIR, DRAWIO_DIR, createModel, hideSidebars, docUrl, editorView, setModelSource, timelineEntry } from "../cad.ts";
import { drag, sidebarDocuments, type Repo } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu } from "../ui.ts";
import { docPathWith } from "../cad.ts";

test.use({ siteModules: { cad: CAD_DIR, drawio: DRAWIO_DIR } });

const shots = process.env["CAD_SHOTS"];

type Cell = { tag: string; attributes: Record<string, string>; content: string };
type Diagram = { name: string; extension: string; mimeType: string; content: string; pages?: { id: string; cells: Record<string, Cell>; order: string[] }[] };
const diagramOf = (page: Page, url: string) => page.evaluate(async (u) => JSON.parse(JSON.stringify((await (window as unknown as { repo: Repo }).repo.find(u)).doc())) as Diagram, url);
const editorFrame = (page: Page): FrameLocator => page.frameLocator("iframe.drawio-editor");

/** A .drawio.svg of one labelled box, `width` × `height`, its diagram uncompressed. */
const boxSvg = (label: string, width: number, height: number) => {
  const diagram = `<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="${width}" height="${height}" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
  const escaped = diagram.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 2}px" height="${height + 2}px" viewBox="-0.5 -0.5 ${width + 2} ${height + 2}" content="${escaped}"><rect x="0" y="0" width="${width}" height="${height}" fill="#dae8fc" stroke="#6c8ebf"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle">${label}</text></svg>`;
};

test("a new diagram is edited in draw.io's editor, and each change is saved as a .drawio.svg", async ({ users }, info) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  await createViaMenu(page, "draw.io Diagram");
  const url = docUrl(page);
  expect(await diagramOf(page, url)).toMatchObject({ name: "Untitled diagram", extension: "drawio.svg", mimeType: "image/svg+xml" });

  // draw.io's editor, from the tool's own files: the egress fixture fails the test on any request to another site.
  const frame = editorFrame(page);
  await expect(frame.locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
  // A shape of the General palette, clicked, is added to the diagram. draw.io collapses its shapes in a narrow view.
  await hideSidebars(page);
  const shapes = frame.locator(".geSidebarContainer a.geItem");
  await expect(async () => {
    if (!(await shapes.first().isVisible())) await frame.getByTitle(/^Shapes/).first().click();
    await expect(shapes.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await shapes.first().click();
  await expect.poll(async () => (await diagramOf(page, url)).content, { timeout: 15_000 }).toMatch(/<(rect|path|ellipse)\b/);
  const { content } = await diagramOf(page, url);
  expect(content).toMatch(/^<svg [^>]*content="&lt;mxfile/);
  if (shots) await page.screenshot({ path: `${shots}/drawio-editor-${info.project.name}.png` });

  // A second shape: saved again.
  const before = content;
  await shapes.nth(4).click();
  await expect.poll(async () => (await diagramOf(page, url)).content, { timeout: 15_000 }).not.toBe(before);
});

test("a change from elsewhere is merged into the open editor", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  await createViaMenu(page, "draw.io Diagram");
  const url = docUrl(page);
  const frame = editorFrame(page);
  await expect(frame.locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
  // Another tab adds a cell to the diagram's records, as a collaborator's editor does.
  await page.evaluate(async (u) => {
    const handle = await (window as unknown as { repo: Repo }).repo.find(u);
    handle.change((d) => {
      const p = (d as { pages: { cells: Record<string, unknown>; order: string[] }[] }).pages[0]!;
      p.cells["ext"] = { tag: "mxCell", attributes: { id: "ext", value: "From elsewhere", style: "rounded=0;whiteSpace=wrap;html=1;", vertex: "1", parent: "1" }, content: '<mxGeometry x="40" y="40" width="160" height="80" as="geometry"/>' };
      p.order.push("ext");
    });
  }, url);
  await expect(frame.locator(".geDiagramContainer").getByText("From elsewhere")).toBeVisible({ timeout: 15_000 });
  // The SVG follows: the editor exports it again.
  await expect.poll(async () => (await diagramOf(page, url)).content, { timeout: 15_000 }).toContain("From elsewhere");
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });

  test("the editor is light or dark as Patchwork is, and the diagram's SVG the same either way", async ({ users }, info) => {
    const [a] = await users(1);
    const page = a!.page;
    await bootToFrame(page);
    await createViaMenu(page, "draw.io Diagram");
    const url = docUrl(page);
    const frame = editorFrame(page);
    await expect(frame.locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
    const dark = frame.locator(".geEditor.geDarkMode");
    await expect(dark).toHaveCount(1);
    const box = { tag: "mxCell", attributes: { id: "box", value: "Box", style: "rounded=0;whiteSpace=wrap;html=1;", vertex: "1", parent: "1" }, content: '<mxGeometry x="40" y="40" width="160" height="80" as="geometry"/>' };
    const setBox = (present: boolean) =>
      page.evaluate(
        async ([u, cell, add]) => {
          const handle = await (window as unknown as { repo: Repo }).repo.find(u!);
          handle.change((d) => {
            const p = (d as { pages: { cells: Record<string, unknown>; order: string[] }[] }).pages[0]!;
            if (add) {
              p.cells["box"] = cell;
              p.order.push("box");
            } else {
              delete p.cells["box"];
              p.order.splice(p.order.indexOf("box"), 1);
            }
          });
        },
        [url, box, present] as const,
      );
    const content = async () => (await diagramOf(page, url)).content;
    await setBox(true);
    await expect.poll(content, { timeout: 15_000 }).toContain('data-cell-id="box"');
    const inDark = await content();
    if (shots) await page.screenshot({ path: `${shots}/drawio-dark-${info.project.name}.png` });

    // The browser turns light, and Patchwork's theme with it: the editor follows, without reloading.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(dark).toHaveCount(0, { timeout: 10_000 });
    await expect(frame.locator(".geDiagramContainer").getByText("Box")).toBeVisible();
    // The same diagram exported in light mode is the same file.
    await setBox(false);
    await expect.poll(content, { timeout: 15_000 }).not.toContain('data-cell-id="box"');
    await setBox(true);
    await expect.poll(content, { timeout: 15_000 }).toContain('data-cell-id="box"');
    expect(await content()).toBe(inDark);
  });
});

test("a version that can't be edited is shown as its picture", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, { box: { data: { "@patchwork": { type: "drawio" }, name: "Box", extension: "drawio.svg", mimeType: "image/svg+xml", content: boxSvg("Pinned", 120, 60) } } });
  const pictured = await page.evaluate(async (u) => {
    const handle = await (window as unknown as { repo: Repo }).repo.find(u);
    const view = document.createElement("patchwork-view");
    view.style.cssText = "display:block;position:fixed;left:0;top:0;width:400px;height:300px";
    view.setAttribute("doc-url", `${u}#${handle.heads().join("|")}`);
    view.setAttribute("tool-id", "drawio");
    document.querySelector("repo-provider")!.append(view);
    for (let i = 0; i < 100 && !view.querySelector(".drawio-picture, .drawio-editor"); i++) await new Promise((r) => setTimeout(r, 100));
    return { picture: !!view.querySelector("img.drawio-picture"), editor: !!view.querySelector(".drawio-editor") };
  }, docs["box"]!);
  expect(pictured).toEqual({ picture: true, editor: false });
});

test("a diagram on a CAD model's canvas follows it", async ({ users }, info) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, { "Bracket sketch": { data: { "@patchwork": { type: "drawio" }, name: "Bracket sketch", extension: "drawio.svg", mimeType: "image/svg+xml", content: boxSvg("Wide", 200, 100) } } });
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 5 });
  return { plate: extrude1 };
}
`, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });

  // Dropped in the view, it is an SVG file: Canvas is offered.
  const stage = (await page.locator(".cad-editor__stage").boundingBox())!;
  await drag(page, "Bracket sketch", { x: stage.x + 40, y: stage.y + 40 });
  await page.locator(".cad-editor__dialog").getByRole("radiogroup", { name: "Use as" }).getByText("Canvas", { exact: true }).click();
  const viewer = page.locator(".cad-model__viewer").first();
  const aspect = () =>
    viewer.evaluate((el) => {
      const c = (el as unknown as { cadViewer: { canvases(): { world: number[][] }[] } }).cadViewer.canvases()[0];
      if (!c) return undefined;
      const [p0, p1, , p3] = c.world as [number[], number[], number[], number[]];
      return Math.round((Math.hypot(...p3.map((v, i) => v - p0[i]!)) / Math.hypot(...p1.map((v, i) => v - p0[i]!))) * 100) / 100;
    });
  await expect.poll(aspect, { timeout: 30_000 }).toBe(0.5);
  // On XY under the plate, as a new canvas lies: drawn through the model, to be seen.
  await page.locator(".cad-editor__dialog").getByLabel("through the model").check();
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: `${shots}/drawio-canvas-${info.project.name}.png` });

  // The diagram changes, as an edit in draw.io saves it: the canvas shows the new picture.
  await page.evaluate(
    async ([u, svg]) => (await (window as unknown as { repo: Repo }).repo.find(u!)).change((d) => (d["content"] = svg)),
    [docs["Bracket sketch"]!, boxSvg("Square", 100, 100)] as const,
  );
  await expect.poll(aspect, { timeout: 30_000 }).toBe(1);
});

/** Runs `fn` with draw.io's editor of the page's diagram, through its plugin API, as the tool reaches it. */
async function inEditor<T>(page: Page, fn: string): Promise<T> {
  const frame = page.frames().find((f) => f.url().includes("/drawio/index.html"));
  if (!frame) throw new Error("no draw.io editor on the page");
  return frame.evaluate((body) => {
    let ui: unknown;
    (window as unknown as { Draw: { loadPlugin(cb: (u: unknown) => void): void } }).Draw.loadPlugin((u) => (ui = u));
    return new Function("ui", body)(ui) as T;
  }, fn);
}

/** Two users with the same new diagram open, each in the draw.io tool. */
async function twoEditors(users: (n: number) => Promise<{ page: Page }[]>) {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createViaMenu(a.page, "draw.io Diagram");
  await bootToFrame(b.page, docPathWith(a.page));
  for (const p of [a.page, b.page]) await expect(editorFrame(p).locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
  return { a: a.page, b: b.page, url: docUrl(a.page) };
}

const labels = (page: Page) => inEditor<string[]>(page, "const m = ui.editor.graph.model; return Object.values(m.cells).filter((c) => c.vertex).map((c) => c.value).sort();");

test("two users' edits at once merge per shape, and per property of the same shape", async ({ users }) => {
  const { a, b, url } = await twoEditors(users);
  // Each adds a shape at the same time.
  await Promise.all([
    inEditor(a, 'const g = ui.editor.graph; g.insertVertex(g.getDefaultParent(), "fromA", "From A", 20, 20, 120, 60);'),
    inEditor(b, 'const g = ui.editor.graph; g.insertVertex(g.getDefaultParent(), "fromB", "From B", 220, 20, 120, 60);'),
  ]);
  for (const p of [a, b]) await expect.poll(() => labels(p), { timeout: 20_000 }).toEqual(["From A", "From B"]);
  await expect.poll(async () => Object.keys((await diagramOf(a, url)).pages?.[0]?.cells ?? {}).sort(), { timeout: 20_000 }).toEqual(["0", "1", "fromA", "fromB"]);

  // One moves A's shape while the other colours it: both stay.
  await Promise.all([
    inEditor(a, 'const g = ui.editor.graph; g.moveCells([g.model.getCell("fromA")], 0, 100);'),
    inEditor(b, 'const g = ui.editor.graph; g.setCellStyles("fillColor", "#ffcc00", [g.model.getCell("fromA")]);'),
  ]);
  const shape = (p: Page) => inEditor<[number, string]>(p, 'const c = ui.editor.graph.model.getCell("fromA"); return [c.geometry.y, c.style];');
  for (const p of [a, b]) await expect.poll(() => shape(p), { timeout: 20_000 }).toEqual([120, expect.stringContaining("fillColor=#ffcc00")]);

  // Both move B's shape: one move stays, the same in both editors and the document.
  await Promise.all([
    inEditor(a, 'const g = ui.editor.graph; g.moveCells([g.model.getCell("fromB")], 0, 50);'),
    inEditor(b, 'const g = ui.editor.graph; g.moveCells([g.model.getCell("fromB")], 0, 200);'),
  ]);
  const y = (p: Page) => inEditor<number>(p, 'return ui.editor.graph.model.getCell("fromB").geometry.y;');
  const stored = async () => /\by="(\d+)"/.exec((await diagramOf(a, url)).pages?.[0]?.cells["fromB"]?.content ?? "")?.[1];
  const agreed = async () => {
    const all = [await y(a), await y(b), Number(await stored())];
    return all.every((v) => v === all[0]) ? all[0] : all;
  };
  await expect.poll(agreed, { timeout: 20_000 }).toEqual(expect.any(Number));
  expect([70, 220]).toContain(await agreed());
  // Neither editor reloaded: the move is still the first user's to undo.
  expect(await inEditor<number>(a, "return ui.editor.undoManager.history.length;")).toBeGreaterThan(0);
});

test("collaborators see each other's pointer, with their name, and selection in their colour", async ({ users }, info) => {
  const { a, b } = await twoEditors(users);
  await inEditor(a, 'const g = ui.editor.graph; g.insertVertex(g.getDefaultParent(), "shared", "Shared", 120, 80, 160, 80);');
  await expect.poll(() => labels(b), { timeout: 20_000 }).toEqual(["Shared"]);
  // The first user points into the diagram and selects the shape.
  const box = (await a.locator("iframe.drawio-editor").boundingBox())!;
  await a.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 5 });
  await inEditor(a, 'const g = ui.editor.graph; g.setSelectionCell(g.model.getCell("shared"));');
  const peerCursor = editorFrame(b).locator(".patchwork-peer-cursor");
  await expect(peerCursor).toHaveCount(1, { timeout: 15_000 });
  // Their selection: draw.io's own highlight of the cell, in their colour.
  await expect.poll(() => inEditor<number>(b, 'return [...ui.editor.graph.container.querySelectorAll("[stroke]")].filter((p) => p.getAttribute("stroke") !== "none" && p.getAttribute("stroke-width") === "3").length;'), { timeout: 15_000 }).toBeGreaterThan(0);
  if (shots) await b.screenshot({ path: `${shots}/drawio-presence-${info.project.name}.png` });
  // Gone when they leave.
  await a.close();
  await expect(peerCursor).toHaveCount(0, { timeout: 30_000 });
});

test.describe("embedded documents", () => {
  // codemirror-base's presence() bug, as in concurrent-edits.spec.ts: the embedded markdown editor reconfigures its presence.
  test.use({ pageErrorsAllowed: ["RangeError: Field is not present in this state"] });

  test("a document dropped in from the sidebar is a cell that shows it, which takes the pointer while it is selected; the SVG has its title", async ({ users }, info) => {
    const [a] = await users(1);
    const page = a!.page;
    await bootToFrame(page);
    const notes = "# Bracket notes\n\n- fillet the top edges\n";
    const docs = await sidebarDocuments(page, { "Bracket notes": { data: { "@patchwork": { type: "markdown" }, content: notes } } });
    await createViaMenu(page, "draw.io Diagram");
    const url = docUrl(page);
    await expect(editorFrame(page).locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
    const box = (await editorFrame(page).locator(".geDiagramContainer").boundingBox())!;
    await drag(page, "Bracket notes", { x: box.x + box.width * 0.6, y: box.y + box.height * 0.4 });

    // A cell that names the document, titled by it, shown in Patchwork's embed frame.
    await expect.poll(async () => Object.values((await diagramOf(page, url)).pages?.[0]?.cells ?? {}).flatMap((c) => (c.attributes["patchworkUrl"] ? [[c.tag, c.attributes["label"], c.attributes["patchworkUrl"]]] : [])), { timeout: 20_000 }).toEqual([["object", "Bracket notes", docs["Bracket notes"]]]);
    const frame = page.locator("patchwork-view.drawio-embed");
    await expect(frame).toHaveAttribute("doc-url", docs["Bracket notes"]!);
    const line = frame.locator(".cm-line", { hasText: "fillet the top edges" });
    await expect(line).toBeVisible({ timeout: 20_000 });
    // Everything else reads its title in the SVG.
    await expect.poll(async () => (await diagramOf(page, url)).content, { timeout: 20_000 }).toContain(">Bracket notes<");

    // Deselected, a click on it selects the cell, as any other; selected, the document takes the next click and typing; Escape leaves it.
    const at = (await frame.boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height - 20);
    await expect.poll(() => inEditor<number>(page, "return ui.editor.graph.getSelectionCells().length;")).toBe(0);
    await expect(frame).not.toHaveClass(/drawio-embed--active/);
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect.poll(() => inEditor<number>(page, "return ui.editor.graph.getSelectionCells().length;")).toBe(1);
    await expect(frame).toHaveClass(/drawio-embed--active/);
    await line.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and the bottom");
    const markdown = () => page.evaluate(async (u) => String(((await (window as unknown as { repo: Repo }).repo.find(u)).doc() as { content: string }).content), docs["Bracket notes"]!);
    await expect.poll(markdown).toContain("fillet the top edges and the bottom");
    if (shots) await page.screenshot({ path: `${shots}/drawio-embed-${info.project.name}.png` });
    await expect.poll(() => inEditor<number>(page, "return ui.editor.graph.getSelectionCells().length;")).toBe(1);
    await page.keyboard.press("Escape");
    await expect(frame).not.toHaveClass(/drawio-embed--active/);
    await expect.poll(() => inEditor<number>(page, "return ui.editor.graph.getSelectionCells().length;")).toBe(0);
  });
});
