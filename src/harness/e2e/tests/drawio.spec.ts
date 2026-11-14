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

test.use({ siteModules: { cad: CAD_DIR, drawio: DRAWIO_DIR } });

const shots = process.env["CAD_SHOTS"];

type Diagram = { name: string; extension: string; mimeType: string; content: string };
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

test("a change from elsewhere is loaded into the open editor", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  await createViaMenu(page, "draw.io Diagram");
  const url = docUrl(page);
  const frame = editorFrame(page);
  await expect(frame.locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
  await page.evaluate(
    async ([u, svg]) => (await (window as unknown as { repo: Repo }).repo.find(u!)).change((d) => (d["content"] = svg)),
    [url, boxSvg("From elsewhere", 160, 80)] as const,
  );
  await expect(frame.locator(".geDiagramContainer").getByText("From elsewhere")).toBeVisible({ timeout: 15_000 });
  // Loading it is no change of the editor's: the content stays as it was written.
  await page.waitForTimeout(2000);
  expect((await diagramOf(page, url)).content).toBe(boxSvg("From elsewhere", 160, 80));
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
