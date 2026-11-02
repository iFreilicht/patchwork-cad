/**
 * Copies (`move`): their faces and edges are named by the copy, `move1.extrude1.end`, so that picks,
 * hovers and collaborators' highlights on a copy stay on the copy and don't reach the original.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, createModel, docPathWith, editorView, entities, hideSidebars, modelSource, pickNear, setModelSource, timelineEntry, toolbarButton, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const SOURCE = `import { sketch, plane, rect, extrude, move } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [60, 40] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 8 });
  const move1 = move({ body: extrude1, z: 30 });
  return [extrude1, move1];
}
`;

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
interface Hook {
  cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; highlighted(style: "peer"): Entity[] };
}
const returned = async (page: Page) => /return (.*);/.exec(await modelSource(page))?.[1];

async function open(page: Page, path?: string) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await bootToFrame(page, path);
  if (!path) await createModel(page);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  if (!path) await setModelSource(page, SOURCE);
  await expect(timelineEntry(page, "move1")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
}

/** Moves the pointer onto a face of `body` that it reaches. */
async function hoverFaceOf(page: Page, body: string): Promise<Entity> {
  for (const face of (await entities(page, "face")).filter((e) => e.body === body)) {
    const point = await viewer(page).evaluate((el, e) => (el as unknown as Hook).cadViewer.screenPoint(e), face);
    if (!point) continue;
    await page.mouse.move(point.x, point.y);
    if ((await viewer(page).getAttribute("data-hovered")) === `${face.body}:face:${face.index}`) return face;
  }
  throw new Error(`no face of ${body} to hover`);
}

test("a chamfer on a copy works on the copy, and leaves the original and the return alone", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);

  // Hovering a face of the copy marks the move, which made it, not the extrusion.
  await hoverFaceOf(page, "move1");
  await expect(timelineEntry(page, "move1")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "extrude1")).not.toHaveAttribute("data-cross-hover", "true");
  await page.mouse.move(0, 0);

  await toolbarButton(page, "Chamfer").click();
  await expect.poll(() => modelSource(page)).toContain("const chamfer1 = chamfer({ body: move1, edges: [], distance: 1 });");
  await pickNear(page, "edge", [60, 20, 38], "move1");
  await expect.poll(() => modelSource(page)).toMatch(/chamfer\(\{ body: move1, edges: \[edge\(move1\.extrude1\.(end|side\.\w+), move1\.extrude1\.(end|side\.\w+)\)\], distance: 1 \}\)/);
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
  expect(await returned(page)).toBe("[extrude1, chamfer1]");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  if (shots) await page.screenshot({ path: `${shots}/copies-chamfer.png` });
  // Picking it again takes it out, as for any edge.
  await pickNear(page, "edge", [60, 20, 38], "move1");
  await expect.poll(() => modelSource(page)).toContain("const chamfer1 = chamfer({ body: move1, edges: [], distance: 1 });");
});

test("a collaborator's hover on a copy highlights the copy only", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await open(a.page);
  await open(b.page, docPathWith(a.page));
  const peerBodies = async () => [...new Set((await viewer(b.page).evaluate((el) => (el as unknown as Hook).cadViewer.highlighted("peer"))).map((e) => e.body))];

  await hoverFaceOf(a.page, "move1");
  await expect.poll(peerBodies, { timeout: 15_000 }).toEqual(["move1"]);
  await hoverFaceOf(a.page, "extrude1");
  await expect.poll(peerBodies, { timeout: 15_000 }).toEqual(["extrude1"]);
  if (shots) await b.page.screenshot({ path: `${shots}/copies-peer.png` });
});

test("renaming the copied feature to a property of bodies reaches it through of(), and back", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await setModelSource(page, (await modelSource(page)).replace("return [extrude1, move1];", "const chamfer1 = chamfer({ body: move1, edges: [edge(move1.extrude1.end, move1.extrude1.side.right)], distance: 1 });\n  return [extrude1, chamfer1];").replace("move }", "move, chamfer, edge }"));
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  const rename = async (from: string, to: string) => {
    await timelineEntry(page, from).focus();
    await page.keyboard.press("F2");
    await page.getByRole("textbox", { name: `New name for ${from}` }).fill(to);
    await page.keyboard.press("Enter");
    await expect(timelineEntry(page, to)).toBeVisible();
  };
  await rename("extrude1", "end");
  await expect.poll(() => modelSource(page)).toContain('edges: [edge(move1.of("end").end, move1.of("end").side.right)]');
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
  await rename("end", "plate");
  await expect.poll(() => modelSource(page)).toContain("edges: [edge(move1.plate.end, move1.plate.side.right)]");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
});
