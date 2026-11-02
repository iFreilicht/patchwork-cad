/**
 * Bodies as lineages (research/15): lanes beneath the timeline, the browser with per-user
 * visibility and outputs, the return entry, picking bodies, joining or branching, and combine, on
 * M4 (a joined boss, a corner cut by a copy, a private fork and a lid).
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, docPathWith, editorView, entities, exampleSource, hideSidebars, modelSource, openCode, pickNear, reloadStored, setModelSource, timelineEntry, toolbarButton, versionChips, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const browser = (page: Page) => page.getByRole("complementary", { name: "Browser" });
const row = (page: Page, name: string) => browser(page).locator(`.cad-editor__browser-row[data-name="${name}"]`);
const rows = (page: Page) => browser(page).locator(".cad-editor__browser-row").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-name")}:${e.getAttribute("data-version")}${e.getAttribute("data-visible") === "true" ? " shown" : ""}`));
const eye = (page: Page, name: string) => row(page, name).getByRole("button", { name: /^(Hide|Show) / });
const marker = (page: Page) => page.getByRole("slider", { name: "Timeline marker" });
/** Moves the timeline marker `steps` back from the end, past the return. */
async function markerBack(page: Page, steps: number) {
  await marker(page).focus();
  await page.keyboard.press("End");
  for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowLeft");
}
/** The bodies the 3D view shows. */
const shownBodies = async (page: Page) => [...new Set((await entities(page, "face")).map((e) => e.body))].sort();
const returned = async (page: Page) => /return (.*);/.exec(await modelSource(page))?.[1];
const lanes = (page: Page) => page.locator(".cad-editor__lanes");
const hovered = (page: Page) => page.locator(".cad-model__viewer").first().evaluate((el) => (el as unknown as { cadViewer: { highlighted(s: "hover"): Entity[] } }).cadViewer.highlighted("hover"));
const returnEntry = (page: Page) => page.locator(".cad-editor__return");

async function openM4(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await bootToFrame(page);
  await createModel(page);
  // Once the model has opened: during its navigation, the sidebar's button may not take the click.
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, exampleSource("m4"));
  await expect(timelineEntry(page, "lid")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
}

test("M4's bodies: the browser lists what exists at the marker, the lanes show how they fork, copy and merge", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  await page.mouse.move(0, 0);
  // Past the return, at the end, what main returns: plate, the body from sketch1 to notched, and lid, a copy.
  await expect(editorView(page)).toHaveAttribute("data-marker", "11");
  await expect(browser(page).getByText("Returned")).toBeVisible();
  await expect.poll(() => rows(page)).toEqual(["plate:notched shown", "lid:lid shown"]);
  await expect.poll(() => shownBodies(page)).toEqual(["lid", "notched"]);
  await expect(lanes(page)).toHaveAttribute("data-rows", "5");
  // One lane per lineage: plate's, the boss's (from sketch2), and rounded's, corner's and lid's.
  const laneNames = await lanes(page).locator("path.cad-editor__lane[data-name]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-name")))]);
  expect(laneNames.sort()).toEqual(["boss", "corner", "lid", "plate", "rounded"]);
  // Links: the boss and the corner merge into the plate, rounded forks, corner and lid are copies.
  const links = await lanes(page).locator("path.cad-editor__lane[data-link]").evaluateAll((els) => els.map((e) => e.getAttribute("data-link")).sort());
  expect(links).toEqual(Array(2).fill(["copy", "copy", "fork", "merge", "merge"]).flat().sort());
  // Ports, each drawn before and past the marker: plate and lid are returned, rounded is private.
  expect(await lanes(page).locator('path.cad-editor__lane-port[data-returned="true"]').count()).toBe(4);
  expect(await lanes(page).locator('path.cad-editor__lane-port[data-returned="false"]').count()).toBe(2);
  if (shots) await page.screenshot({ path: `${shots}/bodies-m4.png` });
  if (shots) await page.locator(".cad-editor__timeline-wrap").screenshot({ path: `${shots}/bodies-m4-timeline.png` });

  // Hovering a body highlights it in the view and its lane, drawn over the others.
  await row(page, "plate").hover();
  await expect(lanes(page).locator('path.cad-editor__lane[data-name="plate"]').first()).toHaveAttribute("data-hovered", "true");

  // Before the return, everything that no feature used: also rounded, which main doesn't return.
  await markerBack(page, 1);
  await expect(editorView(page)).toHaveAttribute("data-marker", "10");
  await expect(returnEntry(page)).toHaveAttribute("data-past-marker", "true");
  await expect(browser(page).getByText("Before the return")).toBeVisible();
  await expect.poll(() => rows(page)).toEqual(["plate:notched shown", "rounded:rounded shown", "lid:lid shown"]);
  await expect.poll(() => shownBodies(page)).toEqual(["lid", "notched", "rounded"]);
  if (shots) await page.screenshot({ path: `${shots}/bodies-before-return.png` });

  // Rolled back to before joined, plate is the extrusion and the boss a body of its own.
  await markerBack(page, 6);
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  await expect.poll(() => rows(page)).toEqual(["plate:plate shown", "boss:fillet1 shown"]);
  await expect(browser(page).getByText("At the timeline marker")).toBeVisible();
  await expect.poll(() => shownBodies(page)).toEqual(["fillet1", "plate"]);
  await page.keyboard.press("Home");
  await expect.poll(() => rows(page)).toEqual([]);
  // The ⏭ button goes past the return.
  await page.getByRole("button", { name: "Move the timeline marker to the end" }).click();
  await expect(editorView(page)).toHaveAttribute("data-marker", "11");
});

/** An entry's node in the lanes, by its version: drawn before and past the marker, the first one. */
const node = (page: Page, version: string) => lanes(page).locator(`g.cad-editor__node:has(circle[data-version="${version}"])`).first();
const centre = async (page: Page, version: string) => {
  const box = (await node(page, version).locator("circle.cad-editor__lane-dot").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const lineage = (page: Page) => page.locator('.cad-editor__entry[data-lineage="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
const hoveredEntries = (page: Page) => page.locator('.cad-editor__entry[data-hovered="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
const selfCode = (page: Page) => page.locator(".cad-model__code .cad-model__related--self").allTextContents();

test("hovering is one thing wherever it starts: an entry, its node or code, a lineage in the browser or the lanes, the return", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  await openCode(page);
  await page.mouse.move(0, 0);

  // A lineage in the browser: the feature a click opens shows as hovered, its code underlined; its others are marked.
  await row(page, "plate").hover();
  await expect.poll(() => hoveredEntries(page)).toEqual(["notched"]);
  await expect.poll(() => lineage(page)).toEqual(["sketch1", "plate", "joined", "notched"]);
  await expect.poll(() => selfCode(page)).toEqual([expect.stringContaining("const notched")]);
  if (shots) await page.screenshot({ path: `${shots}/bodies-hover-lineage.png` });

  // The return entry hovers as a feature does, without its dependencies; it highlights the returned lanes.
  await returnEntry(page).hover();
  await expect(returnEntry(page)).toHaveAttribute("data-hovered", "true");
  await expect.poll(() => selfCode(page)).toEqual(["return [notched, lid];"]);
  await expect(page.locator(".cad-editor__entry[data-relation]")).toHaveCount(0);
  await expect(lanes(page).locator('path.cad-editor__lane[data-name="lid"]').first()).toHaveAttribute("data-hovered", "true");
  // Its ports mirror it.
  await expect(lanes(page).locator('g.cad-editor__node:has(path.cad-editor__lane-port[data-returned="true"])').first()).toHaveAttribute("data-hovered", "true");

  // A feature's code: its lane and its body's row in the browser.
  await page.locator(".cad-model__code .cm-line", { hasText: "const lid" }).hover({ position: { x: 30, y: 5 } });
  await expect(row(page, "lid")).toHaveAttribute("data-hovered", "true");
  await expect(row(page, "plate")).not.toHaveAttribute("data-hovered", "true");
  await expect(lanes(page).locator('path.cad-editor__lane[data-name="lid"]').first()).toHaveAttribute("data-hovered", "true");
  // The return's code: the return entry.
  await page.locator(".cad-model__code .cm-line", { hasText: "return [notched" }).hover({ position: { x: 30, y: 5 } });
  await expect(returnEntry(page)).toHaveAttribute("data-cross-hover", "true");

  // Near a node: its entry, which the node mirrors; a click opens it.
  const fillet1 = await centre(page, "fillet1");
  await page.mouse.move(fillet1.x + 5, fillet1.y + 2);
  await expect.poll(() => hoveredEntries(page)).toEqual(["fillet1"]);
  await expect(node(page, "fillet1")).toHaveAttribute("data-hovered", "true");
  await expect(node(page, "boss")).toHaveAttribute("data-relation", "dependency");
  await page.mouse.click(fillet1.x + 5, fillet1.y + 2);
  await expect(dialog(page)).toHaveAttribute("data-feature", "fillet1");
  await expect(node(page, "fillet1")).toHaveAttribute("data-open", "true");
  if (shots) await page.locator(".cad-editor__timeline-wrap").screenshot({ path: `${shots}/bodies-hover-node.png` });

  // On a lane between nodes: its lineage, by the version of that segment, which a click opens.
  const joined = await centre(page, "joined");
  const notched = await centre(page, "notched");
  await page.mouse.move((joined.x + notched.x) / 2, joined.y + 2);
  await expect(row(page, "plate")).toHaveAttribute("data-hovered", "true");
  await expect.poll(() => hoveredEntries(page)).toEqual(["joined"]);
  await expect.poll(() => lineage(page)).toEqual(["sketch1", "plate", "joined", "notched"]);
  await page.mouse.click((joined.x + notched.x) / 2, joined.y + 2);
  await expect(dialog(page)).toHaveAttribute("data-feature", "joined");
  await page.mouse.move(0, 0);
  await expect.poll(() => lineage(page)).toEqual([]);
});

const JOINED = `import { sketch, plane, rect, extrude, chamfer, edge } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance: 8 });
  const sketch2 = sketch({ plane: plane("XY", 8), profile: rect({ from: [10, 10], to: [30, 30] }) });
  const extrude1 = extrude({ sketch: sketch2, distance: 10, operation: "join", target: plate });
  const chamfer1 = chamfer({ body: extrude1, edges: [], distance: 1 });
  return [plate, chamfer1];
}
`;

test("a returned version that a later feature continues is a body of its own: named, hovered, shown and picked as one", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await page.setViewportSize({ width: 1600, height: 900 });
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await hideSidebars(page);
  await setModelSource(page, JOINED);
  // Without edges yet, it fails alone.
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "failed", { timeout: 120_000 });
  // plate, and the lineage that joined onto it, named by its first version that isn't returned by itself.
  await expect.poll(() => rows(page)).toEqual(["plate:plate shown", "extrude1:chamfer1 shown"]);
  await row(page, "plate").hover();
  await expect(row(page, "extrude1")).not.toHaveAttribute("data-hovered", "true");
  await expect(lanes(page).locator('path.cad-editor__lane[data-link="output"]').first()).toHaveAttribute("data-hovered", "true");
  await page.mouse.move(0, 0);

  // Before the chamfer, plate exists, too: the view shows it, though the join consumed it, and its edges can be picked.
  await timelineEntry(page, "chamfer1").click();
  await dialog(page).getByRole("button", { name: "Select edges" }).click();
  await expect.poll(() => rows(page)).toEqual(["extrude1:extrude1 shown", "plate:plate shown"]);
  await expect.poll(() => shownBodies(page)).toEqual(["extrude1", "plate"]);
  // The join covers plate, which is inside it: hiding it lets plate's edges through.
  await eye(page, "extrude1").click();
  await expect.poll(() => shownBodies(page)).toEqual(["plate"]);
  await pickNear(page, "edge", [60, 20, 8], "plate");
  await expect.poll(() => modelSource(page)).toMatch(/chamfer\(\{ body: plate, edges: \[edge\(plate\.\S+, plate\.\S+\)\]/);
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-status", "ok");
  expect(await returned(page)).toBe("[chamfer1, extrude1]");
  await dialog(page).getByRole("button", { name: "Done selecting" }).click();
  // A branch from history, plate being consumed by the join, too: picking shows what it works on.
  await dialog(page).getByRole("button", { name: "Select edges" }).click();
  await expect.poll(() => shownBodies(page)).toEqual(["extrude1", "plate"]);
  await expect(page.locator(".cad-model__viewer").first()).toHaveAttribute("data-faded", "extrude1");
  if (shots) await page.screenshot({ path: `${shots}/bodies-branch-from-history.png` });
});

test("hiding and showing are this user's; the return entry picks what main returns", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  const source = await modelSource(page);

  await eye(page, "plate").click();
  await expect(row(page, "plate")).toHaveAttribute("data-visible", "false");
  await expect.poll(() => shownBodies(page)).toEqual(["lid"]);
  // Before the return, rounded shows too; this user hides it there.
  await markerBack(page, 1);
  await expect.poll(() => shownBodies(page)).toEqual(["lid", "rounded"]);
  await eye(page, "rounded").click();
  await expect.poll(() => shownBodies(page)).toEqual(["lid"]);
  if (shots) await page.screenshot({ path: `${shots}/bodies-visibility.png` });
  // The model doesn't change; the view state survives a reload.
  expect(await modelSource(page)).toBe(source);
  await reloadStored(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(editorView(page)).toHaveAttribute("data-marker", "10");
  await expect.poll(() => shownBodies(page), { timeout: 30_000 }).toEqual(["lid"]);
  await eye(page, "plate").click();
  await eye(page, "rounded").click();
  await expect.poll(() => shownBodies(page)).toEqual(["lid", "notched", "rounded"]);
  await markerBack(page, 0);

  // The return entry: a chip per returned name, removed with ×, added by picking any body or sketch.
  await returnEntry(page).click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "return");
  await expect(versionChips(page, "return")).toHaveText(["notched", "lid"]);
  await dialog(page).getByRole("button", { name: "remove lid" }).click();
  await expect.poll(() => returned(page)).toBe("notched");
  await expect(timelineEntry(page, "lid")).toHaveAttribute("data-status", "unused");
  await expect.poll(() => rows(page)).toEqual(["plate:notched shown"]);
  await dialog(page).getByRole("button", { name: "Select" }).click();
  await timelineEntry(page, "rounded").click();
  await expect.poll(() => returned(page)).toBe("[notched, rounded]");
  // A version that a later feature consumes, too: it goes to the return on a lane of its own.
  await timelineEntry(page, "joined").click();
  await expect.poll(() => returned(page)).toBe("[notched, rounded, joined]");
  await expect(lanes(page).locator('path.cad-editor__lane[data-link="output"]').first()).toBeAttached();
  await expect.poll(() => rows(page)).toEqual(["plate:notched shown", "rounded:rounded shown", "joined:joined shown"]);
  if (shots) await page.screenshot({ path: `${shots}/bodies-result.png` });
  // Picking a returned one takes it out.
  await timelineEntry(page, "joined").click();
  await expect.poll(() => returned(page)).toBe("[notched, rounded]");
  await dialog(page).getByRole("button", { name: "Done selecting" }).click();

  // A return that isn't a list of names shows as code, and can't be picked into.
  await setModelSource(page, (await modelSource(page)).replace("return [notched, rounded];", "return [...[notched, rounded]];"));
  await expect(versionChips(page, "return")).toHaveText(["[...[notched, rounded]]"]);
  await expect(dialog(page).getByRole("button", { name: "Select" })).toBeDisabled();
});

test("body fields are filled by picking: in the view, the browser or the timeline", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  await timelineEntry(page, "joined").click();
  await expect(versionChips(page, "target")).toHaveText(["plate"]);
  await expect(versionChips(page, "tools")).toHaveText(["fillet1"]);

  // Picking tools: what comes after joined can't be picked; boss can, which forks it.
  await dialog(page).getByRole("button", { name: "Select bodies" }).click();
  await expect(editorView(page)).toHaveAttribute("data-rolled-back", "true");
  await expect(timelineEntry(page, "lid")).toHaveAttribute("data-pickable", "false");
  await expect(timelineEntry(page, "boss")).toHaveAttribute("data-pickable", "true");
  // What the field holds stands out from what it could take.
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-picked", "true");
  await expect(timelineEntry(page, "boss")).not.toHaveAttribute("data-picked", "true");
  // Hovering an entry shows the body it would pick, as a ghost where it doesn't show; not what the feature changed, nor its dependencies.
  const relations = () => page.locator(".cad-editor__entry[data-relation]").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
  const ofJoined = await relations();
  await timelineEntry(page, "boss").hover();
  await expect.poll(async () => [...new Set((await hovered(page)).map((e) => e.body))]).toEqual(["boss"]);
  expect(await relations()).toEqual(ofJoined);
  // In the view, too, hovering shows the whole body, not the face or edge under the pointer.
  const face = (await entities(page, "face")).find((e) => e.body === "fillet1")!;
  const point = await page.locator(".cad-model__viewer").first().evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);
  if (point) {
    await page.mouse.move(point.x, point.y);
    await expect.poll(async () => [...new Set((await hovered(page)).map((e) => `${e.body}:${e.kind}`))]).toEqual(["fillet1:face"]);
    const all = (await entities(page, "face")).filter((e) => e.body === "fillet1").length;
    expect((await hovered(page)).length).toBe(all);
  }
  if (shots) await page.screenshot({ path: `${shots}/bodies-pick-tools.png` });
  await timelineEntry(page, "boss").click();
  await expect(versionChips(page, "tools")).toHaveText(["fillet1", "boss"]);
  await expect(timelineEntry(page, "joined")).toHaveAttribute("data-status", "ok");
  // Picking it again takes it out; the target isn't a tool.
  await timelineEntry(page, "boss").click();
  await expect(versionChips(page, "tools")).toHaveText(["fillet1"]);
  await timelineEntry(page, "plate").click();
  await expect(page.locator(".cad-model__status")).toContainText("plate is the target of joined");
  // In the view: the rolled-back view shows plate and fillet1; clicking fillet1 takes it out.
  await pickNear(page, "face", [30, 20, 20], "fillet1");
  await expect(versionChips(page, "tools")).toHaveText([]);
  await expect(timelineEntry(page, "joined")).toHaveAttribute("data-status", "failed");
  // In the browser, which shows what exists where the view is rolled back to.
  await expect.poll(() => rows(page)).toEqual(["plate:plate shown", "boss:fillet1 shown"]);
  await row(page, "plate").locator(".cad-editor__browser-name").click();
  await expect(page.locator(".cad-model__status")).toContainText("plate is the target of joined");
  await dialog(page).getByRole("button", { name: "Done selecting" }).click();
  await dialog(page).getByRole("button", { name: "Select bodies" }).click();
  await pickNear(page, "face", [30, 20, 20], "fillet1");
  await expect(versionChips(page, "tools")).toHaveText(["fillet1"]);
  await expect(timelineEntry(page, "joined")).toHaveAttribute("data-status", "ok");
});

test("combine from the toolbar: its target is the last body, its tools are picked", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  await setModelSource(page, (await modelSource(page)).replace("const lid = move({ body: plate, z: 30 });", "const lid = move({ body: plate, z: 10 });"));
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  await toolbarButton(page, "Combine").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "combine1");
  await expect(versionChips(page, "target")).toHaveText(["lid"]);
  // rounded, which nothing uses, can be a tool: it doesn't fade as it does otherwise.
  await expect(timelineEntry(page, "rounded")).toHaveAttribute("data-pickable", "true");
  await expect(timelineEntry(page, "rounded")).toHaveCSS("opacity", "1");
  await expect(dialog(page).getByRole("button", { name: "Done selecting" })).toBeVisible();
  await expect(timelineEntry(page, "combine1")).toHaveAttribute("data-status", "failed");
  await pickNear(page, "face", [30, 20, 20], "notched");
  await expect(versionChips(page, "tools")).toHaveText(["notched"]);
  await expect(timelineEntry(page, "combine1")).toHaveAttribute("data-status", "ok");
  // It consumes both: the return has the combine instead.
  await expect.poll(() => returned(page)).toBe("combine1");
  if (shots) await page.screenshot({ path: `${shots}/bodies-combine.png` });
  // The combine carries lid's body on, and plate's ends in it.
  await dialog(page).getByRole("button", { name: "Done selecting" }).click();
  await expect.poll(() => rows(page)).toEqual(["lid:combine1 shown"]);
  await timelineEntry(page, "combine1").hover();
  // Deleting it brings its tool back into the result.
  await dialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Delete combine1" }).click();
  await expect.poll(() => returned(page)).toBe("[lid, notched]");
});

test("a feature joins its input's chain or branches off it", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM4(page);
  await timelineEntry(page, "fillet1").click();
  const chain = dialog(page).getByRole("radiogroup", { name: "Chain" });
  await expect(chain.getByRole("radio", { name: "Join" })).toHaveAttribute("aria-checked", "true");
  await chain.getByRole("radio", { name: "Branch" }).click();
  await expect.poll(() => modelSource(page)).toContain("const joined = combine({ target: plate, tools: [boss] });");
  await expect.poll(() => returned(page)).toBe("[notched, lid, fillet1]");
  await expect(chain.getByRole("radio", { name: "Branch" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => rows(page)).toEqual(["plate:notched shown", "lid:lid shown", "boss:fillet1 shown"]);
  if (shots) await page.screenshot({ path: `${shots}/bodies-branch.png` });
  await chain.getByRole("radio", { name: "Join" }).click();
  await expect.poll(() => modelSource(page)).toContain("const joined = combine({ target: plate, tools: [fillet1] });");
  await expect.poll(() => returned(page)).toBe("[notched, lid]");
  // A copy has no chain to join: no choice.
  await timelineEntry(page, "lid").click();
  await expect(dialog(page).getByRole("radiogroup", { name: "Chain" })).toHaveCount(0);
});

test("a body one user hid still shows what a collaborator points at, as a ghost", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await openM4(a.page);
  await b.page.setViewportSize({ width: 1600, height: 900 });
  await bootToFrame(b.page, docPathWith(a.page));
  await expect(editorView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await eye(b.page, "plate").click();
  await expect.poll(() => shownBodies(b.page)).toEqual(["lid"]);
  // Hiding is B's alone: A still sees the plate.
  await expect.poll(() => shownBodies(a.page)).toEqual(["lid", "notched"]);
  // A hovers the fillet, whose faces are in the plate that B hid.
  await timelineEntry(a.page, "fillet1").hover();
  const peer = () => b.page.locator(".cad-model__viewer").first().evaluate((el) => (el as unknown as { cadViewer: { highlighted(s: "peer"): Entity[] } }).cadViewer.highlighted("peer"));
  await expect.poll(async () => (await peer()).some((e) => e.body === "notched"), { timeout: 15_000 }).toBe(true);
  if (shots) await b.page.screenshot({ path: `${shots}/bodies-peer-ghost.png` });
});
