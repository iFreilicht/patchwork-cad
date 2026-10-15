/**
 * Hover highlighting (research/12): the 3D view always hovers faces and edges; in the editor, a click
 * selects one, whose reference the status bar shows to copy; hovering a feature in the timeline or
 * the code highlights what it made, on its own result past the marker; and hovering a face marks the
 * features that made it.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, editorView, entities, exampleSource, hideSidebars, openCode, openWithTool, setModelSource, timelineEntry, type Entity, type EntityKind } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
const marker = (page: Page) => page.getByRole("slider", { name: "Timeline marker" });
const reference = (page: Page) => page.locator(".cad-model__reference code");

interface Hook {
  cadViewer: {
    screenPoint(e: Entity): { x: number; y: number } | undefined;
    highlighted(style: "hover" | "accent"): Entity[];
  };
}

/** The hover-style highlights of `kind`, e.g. the faces of a feature hovered in the timeline. */
const hoverHighlight = (page: Page, kind: EntityKind) => viewer(page).evaluate((el, k) => (el as unknown as Hook).cadViewer.highlighted("hover").filter((e) => e.kind === k), kind);
const count = async (page: Page, kind: EntityKind) => (await hoverHighlight(page, kind)).length;

/** Moves the mouse onto `e` and waits until the view hovers it; false if another entity is hovered there. */
async function hover(page: Page, e: Entity): Promise<boolean> {
  const point = await viewer(page).evaluate((el, x) => (el as unknown as Hook).cadViewer.screenPoint(x), e);
  if (!point) return false;
  await page.mouse.move(point.x, point.y);
  // A face's point may be close enough to an edge that the edge is hovered instead.
  await expect(viewer(page)).not.toHaveAttribute("data-hovered", "");
  return (await viewer(page).getAttribute("data-hovered")) === `${e.body}:${e.kind}:${e.index}`;
}

/** Hovers the visible entities of `kind` until the status bar names one starting with `name`; the mouse stays on it. */
async function hoverNamed(page: Page, kind: EntityKind, name: string): Promise<Entity> {
  const seen: string[] = [];
  for (const e of await entities(page, kind)) {
    if (!(await hover(page, e))) continue;
    await expect(reference(page)).toHaveCount(1);
    const shown = (await reference(page).textContent()) ?? "";
    if (shown.startsWith(name)) return e;
    seen.push(shown);
  }
  throw new Error(`no visible ${kind} named ${name}…; hovered ${seen.join(", ")}`);
}

async function openM1(page: Page): Promise<void> {
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, exampleSource("m1"));
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
}

test("the 3D view hovers and selects faces, names them, and marks the features that made them", async ({ users, browserName }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await openCode(page);

  // The front face right of the notch: extrude1 made it, and notch split it.
  const size = await viewer(page).boundingBox();
  const face = await hoverNamed(page, "face", "extrude1.side.front.piece(notch, 2");
  expect(await hoverHighlight(page, "face")).toEqual([face]);
  // A long name doesn't grow the status bar, which would move the view under the pointer.
  expect(await viewer(page).boundingBox()).toEqual(size);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "fillet1")).not.toHaveAttribute("data-cross-hover", "true");
  await expect(page.locator(".cad-model__code .cad-model__cross-hover")).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/hover-1-face.png` });

  // Leaving the view clears it all.
  await page.mouse.move(0, 0);
  await expect(viewer(page)).toHaveAttribute("data-hovered", "");
  await expect(reference(page)).toHaveCount(0);
  await expect(page.locator('.cad-editor__entry[data-cross-hover="true"]')).toHaveCount(0);

  // A click selects it: its name stays, to be copied from the status bar.
  expect(await hover(page, face)).toBe(true);
  await page.mouse.down();
  await page.mouse.up();
  await expect(viewer(page)).toHaveAttribute("data-selected", `${face.body}:face:${face.index}`);
  await page.mouse.move(0, 0);
  await expect(reference(page)).toContainText("extrude1.side.front.piece(notch, 2");
  expect(await viewer(page).boundingBox()).toEqual(size);
  if (shots) await page.screenshot({ path: `${shots}/hover-2-selected.png` });
  // Only Chromium lets a page read the clipboard back.
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await reference(page).textContent());
  }

  // A click elsewhere in the view clears the selection.
  const box = (await viewer(page).boundingBox())!;
  await page.mouse.click(box.x + 10, box.y + box.height - 10);
  await expect(viewer(page)).toHaveAttribute("data-selected", "");
  await page.mouse.move(0, 0);
  await expect(reference(page)).toHaveCount(0);
});

test("hovering a feature in the timeline or code highlights what it made, also past the marker", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);

  // The notch's wall and the two pieces of the front face it split (owners.test.ts).
  await timelineEntry(page, "notch").hover();
  await expect.poll(() => count(page, "face")).toBe(3);
  await expect.poll(() => count(page, "edge")).toBeGreaterThan(0);
  if (shots) await page.screenshot({ path: `${shots}/hover-3-feature.png` });
  await timelineEntry(page, "fillet1").hover();
  await expect.poll(() => count(page, "face")).toBe(1);

  await page.mouse.move(0, 0);
  await expect.poll(() => count(page, "face")).toBe(0);

  await openCode(page);
  await page.locator(".cad-model__code .cm-line", { hasText: "const fillet1" }).hover({ position: { x: 30, y: 5 } });
  await expect.poll(() => count(page, "face")).toBe(1);
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-cross-hover", "true");
  await page.mouse.move(0, 0);
  await expect.poll(() => count(page, "face")).toBe(0);

  // So does the cursor, while the code pane has focus; of the pointer and the cursor, the one that moved last wins.
  await page.locator(".cad-model__code .cm-line", { hasText: "const fillet1" }).click({ position: { x: 30, y: 5 } });
  await expect.poll(() => count(page, "face")).toBe(1);
  await expect(timelineEntry(page, "fillet1")).toHaveAttribute("data-cross-hover", "true");
  // The pointer stays parked on fillet1's line.
  await page.keyboard.press("ArrowUp");
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "fillet1")).not.toHaveAttribute("data-cross-hover", "true");
  await expect.poll(() => count(page, "face")).toBe(3);
  await page.locator(".cad-model__code .cm-line", { hasText: "const chamfer1" }).hover({ position: { x: 30, y: 5 } });
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "notch")).not.toHaveAttribute("data-cross-hover", "true");
  // Leaving the code falls back to the cursor, and losing focus clears it.
  await page.mouse.move(0, 0);
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-cross-hover", "true");
  await page.locator(".cad-model__code .cm-content").blur();
  await expect.poll(() => count(page, "face")).toBe(0);
  await expect(page.locator('.cad-editor__entry[data-cross-hover="true"]')).toHaveCount(0);

  // Rolled back before the notch, it is shown on its own result, which the view doesn't show.
  await marker(page).focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await expect(editorView(page)).toHaveAttribute("data-marker", "3");
  await expect(editorView(page)).toHaveAttribute("data-rolled-back", "true");
  await timelineEntry(page, "notch").hover();
  await expect.poll(async () => (await hoverHighlight(page, "face")).map((e) => e.body)).toEqual(["notch", "notch", "notch"]);
  if (shots) await page.screenshot({ path: `${shots}/hover-4-past-marker.png` });
  // extrude1 is before the marker: on the shown body.
  await timelineEntry(page, "extrude1").hover();
  await expect.poll(async () => (await hoverHighlight(page, "face")).map((e) => e.body)).toEqual(Array(6).fill("extrude1"));
});

/** Two plates adopted with one body(), and a feature after them (research/11). */
const adopted = `import { body, sketch, plane, rect, extrude } from "@patchwork-cad/features";
import { drawRoundedRectangle } from "replicad";

export default function main() {
  const [left, right] = body(() => [-30, 30].map((x) => drawRoundedRectangle(40, 40, 4).sketchOnPlane().extrude(10).translate(x, 0, 0)));
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [-5, -5], to: [5, 5] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 20 });
  return [left, right, extrude1];
}
`;

test("a body() entry highlights all its bodies, and opening code highlights at its cursor", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, adopted);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
  const faces = await entities(page, "face");
  const of = (body: string) => faces.filter((e) => e.body === body).length;
  const bodies = async () => (await hoverHighlight(page, "face")).map((e) => e.body).sort();
  const expected = [...Array(of("left")).fill("left"), ...Array(of("right")).fill("right")];

  // Its faces are owned by each body's own name, not the entry's.
  await timelineEntry(page, "left").hover();
  await expect.poll(bodies).toEqual(expected);
  // And a face of the second body marks the entry.
  for (const e of faces.filter((f) => f.body === "right")) if (await hover(page, e)) break;
  await expect(timelineEntry(page, "left")).toHaveAttribute("data-cross-hover", "true");
  // Past the marker, both bodies are fetched by name.
  await marker(page).focus();
  await page.keyboard.press("Home");
  await expect(editorView(page)).toHaveAttribute("data-marker", "0");
  await timelineEntry(page, "left").hover();
  await expect.poll(bodies).toEqual(expected);
  await page.keyboard.press("End");
  await expect(editorView(page)).toHaveAttribute("data-marker", "3");

  // Selecting a body() entry opens its code with the cursor at its start: once the pointer leaves
  // the timeline, the cursor highlights it, and moving the cursor moves the highlight.
  await timelineEntry(page, "left").click();
  await expect(page.locator(".cad-model__code .cm-content")).toBeFocused();
  await page.mouse.move(0, 0);
  await expect.poll(bodies).toEqual(expected);
  await page.keyboard.press("ArrowDown");
  await expect(timelineEntry(page, "sketch1")).toHaveAttribute("data-cross-hover", "true");
  await expect.poll(bodies).toEqual([]);
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => [...new Set(await bodies())]).toEqual(["extrude1"]);

  // "Edit code" in the context menu puts the cursor at the feature, too.
  await timelineEntry(page, "left").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit code" }).click();
  await page.mouse.move(0, 0);
  await expect.poll(bodies).toEqual(expected);
});

test("the viewer tool hovers faces and edges but doesn't name them", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await openWithTool(page, "cad-model-viewer");
  await expect(page.locator(".cad-model--viewer")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const [face] = await entities(page, "face");
  let hovered = false;
  for (const e of await entities(page, "face")) if ((hovered = await hover(page, e))) break;
  expect(face && hovered).toBe(true);
  // Without a pick target, an edge wins where the pointer is on one.
  hovered = false;
  for (const e of await entities(page, "edge")) if ((hovered = await hover(page, e))) break;
  expect(hovered).toBe(true);
  await expect(reference(page)).toHaveCount(0);
});
