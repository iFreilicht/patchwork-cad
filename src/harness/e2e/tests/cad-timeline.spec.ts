/**
 * The timeline marker and reordering (research/07, "The timeline marker", "Reordering"): each user's
 * marker rolls their view back and is where new features go, it stays between the surviving entries
 * when another user deletes entries around it, and features move by drag and drop within the range
 * their dependencies allow, rewiring the chain of bodies.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, docPathWith, hideSidebars, editorView, exampleSource, modelSource, openCode, reloadStored, setModelSource, timelineEntry, toolbarButton, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, editor, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const marker = (page: Page) => page.getByRole("slider", { name: "Timeline marker" });
const entries = (page: Page) => page.locator(".cad-editor__entry");
const names = (page: Page) => entries(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-name") ?? "script"));

/** A point in the gap before entry `position` of the timeline (after the last one at the end). */
async function gapPoint(page: Page, position: number): Promise<{ x: number; y: number }> {
  const boxes = await entries(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, y: r.top + r.height / 2 })));
  const after = boxes[position];
  // Just left of the entry after the gap, or right of the last entry; rows may wrap.
  return after ? { x: after.left + 2, y: after.y } : { x: boxes.at(-1)!.right + 2, y: boxes.at(-1)!.y };
}

/** Drags `handle` with the mouse into the gap before entry `position`. */
async function dragTo(page: Page, handle: Locator, position: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const to = await gapPoint(page, position);
  // Several steps: the first ones pass the drag threshold, the last lands in the gap.
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Presses on `handle` and moves the mouse to `to` without releasing; returns the release. */
async function dragAndHold(page: Page, handle: Locator, to: { x: number; y: number }): Promise<() => Promise<void>> {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  return () => page.mouse.up();
}

/** A point just left (before) or right (past) of the marker's line. */
async function besideMarker(page: Page, side: "before" | "past"): Promise<{ x: number; y: number }> {
  const box = (await marker(page).boundingBox())!;
  return { x: box.x + box.width / 2 + (side === "before" ? -2 : 2), y: box.y + box.height / 2 };
}

/** Moves the marker before entry `position` with the keyboard. */
async function setMarker(page: Page, position: number): Promise<void> {
  await marker(page).focus();
  await page.keyboard.press("End");
  const end = Number(await marker(page).getAttribute("aria-valuenow"));
  for (let i = position; i < end; i++) await page.keyboard.press("ArrowLeft");
  await expect(editorView(page)).toHaveAttribute("data-marker", String(position));
}

const pastMarker = (page: Page) => page.locator('.cad-editor__entry[data-past-marker="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));

async function openM1(page: Page, source = exampleSource("m1")): Promise<void> {
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, source);
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
}

test("the marker rolls the view back, new features go there, and it survives deletions around it", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const { page } = a;
  await openM1(page);
  await openCode(page);
  const all = await vertices(page);
  await expect(marker(page)).toHaveAttribute("aria-valuenow", "8");

  // Roll back to before fillet1.
  await dragTo(page, marker(page), 4);
  await expect(editorView(page)).toHaveAttribute("data-marker", "4");
  await expect(editorView(page)).toHaveAttribute("data-rolled-back", "true");
  await expect.poll(() => vertices(page)).toBeLessThan(all);
  await expect(page.locator('.cad-editor__entry[data-past-marker="true"]')).toHaveCount(4);
  await expect(page.locator(".cad-model__code .cad-model__past-marker")).toHaveCount(4);
  await expect(page.locator(".cad-model__code .cad-model__past-marker").first()).toContainText("const fillet1");

  // The keyboard moves it too.
  await marker(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(editorView(page)).toHaveAttribute("data-marker", "3");
  await page.keyboard.press("ArrowRight");
  await expect(editorView(page)).toHaveAttribute("data-marker", "4");

  // A new fillet goes to the marker and into the chain: it works on notch, and fillet1 on it.
  await toolbarButton(page, "Fillet").click();
  await expect.poll(() => modelSource(page)).toContain("const fillet2 = fillet({ body: notch, edges: [], radius: 1 });\n  const fillet1 = fillet({ body: fillet2, ");
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "fillet2", "fillet1", "chamfer1", "sketch3", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");

  // B deletes fillet2 before A's marker and fillet1 after it at once, rewiring the chamfer by hand.
  await bootToFrame(b.page, docPathWith(page));
  await expect(timelineEntry(b.page, "fillet2")).toBeVisible({ timeout: 120_000 });
  // The marker is A's own: B's is at the end.
  await expect(editorView(b.page)).toHaveAttribute("data-marker", "9");
  const source = await modelSource(b.page);
  const without = source
    .split("\n")
    .filter((line) => !line.includes("const fillet2 =") && !line.includes("const fillet1 ="))
    .join("\n")
    .replace("chamfer({ body: fillet1, ", "chamfer({ body: notch, ");
  await setModelSource(b.page, without);
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "sketch3", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "4");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-past-marker", "true");
  await expect(timelineEntry(page, "notch")).not.toHaveAttribute("data-past-marker", "true");

  // Back to the end: the whole model shows again.
  await page.getByRole("button", { name: "Move the timeline marker to the end" }).click();
  await expect(editorView(page)).toHaveAttribute("data-marker", "7");
  await expect(editorView(page)).toHaveAttribute("data-rolled-back", "false");
});

test("features move by drag and drop within their dependencies, rewiring the chain", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await openCode(page);

  // Hovering shows what an entry depends on and what depends on it, in the timeline and the code.
  await timelineEntry(page, "fillet1").hover();
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-relation", "dependency");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-relation", "dependency");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-relation", "dependent");
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-link", "chain");
  await expect(page.locator(".cad-model__code .cad-model__related--dependent")).toContainText("const chamfer1");

  await dragTo(page, timelineEntry(page, "chamfer1"), 4);
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "fillet1", "sketch3", "extrude2"]);
  const moved = await modelSource(page);
  expect(moved).toContain("const chamfer1 = chamfer({ body: notch, ");
  expect(moved).toContain("const fillet1 = fillet({ body: chamfer1, ");
  expect(moved).toContain('target: fillet1 });');
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok");
  // The drag didn't open the dialog.
  await expect(editorView(page)).toHaveAttribute("data-open", "");

  // chamfer1 refers to notch, so it can't go before it.
  await dragTo(page, timelineEntry(page, "chamfer1"), 3);
  await expect(page.locator(".cad-model__notice")).toHaveText("chamfer1 can't move before notch, which it uses.");
  expect(await modelSource(page)).toBe(moved);
});

test("a drop line shows where an entry goes, on either side of the marker", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  const source = await modelSource(page);
  await setMarker(page, 4);
  const drop = page.locator(".cad-editor__drop");

  // fillet1, the first entry past the marker, dropped just before the marker: the code stays, the marker moves after it.
  let release = await dragAndHold(page, timelineEntry(page, "fillet1"), await besideMarker(page, "before"));
  await expect(drop).toHaveAttribute("data-position", "4");
  await expect(drop).toHaveAttribute("data-past-marker", "false");
  // The line is an element of its own, right before the marker.
  const [line, slot] = [(await drop.boundingBox())!, (await marker(page).boundingBox())!];
  expect(line.x + line.width).toBeLessThanOrEqual(slot.x);
  await release();
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  expect(await pastMarker(page)).toEqual(["chamfer1", "sketch3", "extrude2"]);
  expect(await modelSource(page)).toBe(source);

  // And back past the marker.
  release = await dragAndHold(page, timelineEntry(page, "fillet1"), await besideMarker(page, "past"));
  await expect(drop).toHaveAttribute("data-past-marker", "true");
  const [after, slot2] = [(await drop.boundingBox())!, (await marker(page).boundingBox())!];
  expect(after.x).toBeGreaterThanOrEqual(slot2.x + slot2.width);
  await release();
  await expect(editorView(page)).toHaveAttribute("data-marker", "4");
  expect(await modelSource(page)).toBe(source);

  // Dragged away and back to where it was: no line, and the drop changes nothing.
  const box = (await timelineEntry(page, "chamfer1").boundingBox())!;
  release = await dragAndHold(page, timelineEntry(page, "chamfer1"), { x: box.x - 60, y: box.y + box.height / 2 });
  await expect(drop).toHaveCount(1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(drop).toHaveCount(0);
  await release();
  await expect(page.locator(".cad-model__notice")).toHaveCount(0);
  await expect(editorView(page)).toHaveAttribute("data-open", "");
  expect(await modelSource(page)).toBe(source);

  // sketch3, past the marker, dropped before it: the code moves, and sketch3 stays before the marker.
  release = await dragAndHold(page, timelineEntry(page, "sketch3"), await besideMarker(page, "before"));
  await expect(drop).toHaveAttribute("data-position", "4");
  await release();
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "sketch3", "fillet1", "chamfer1", "extrude2"]);
  expect(await modelSource(page)).toContain("const sketch3 = sketch({ body: notch, ");
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  expect(await pastMarker(page)).toEqual(["fillet1", "chamfer1", "extrude2"]);
  await expect(timelineEntry(page, "extrude2")).toHaveAttribute("data-status", "ok");

  // A blocked drop shows a red line and says why.
  release = await dragAndHold(page, timelineEntry(page, "chamfer1"), await gapPoint(page, 3));
  await expect(drop).toHaveAttribute("data-blocked", "true");
  await release();
  await expect(page.locator(".cad-model__notice")).toHaveText("chamfer1 can't move before notch, which it uses.");
});

test("the marker's drawing is anchored to its slot and sticks out above the timeline", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  const drawing = page.locator(".cad-editor__marker-drawing");
  const fits = async () => {
    const [d, slot, timeline] = [(await drawing.boundingBox())!, (await marker(page).boundingBox())!, (await page.locator(".cad-editor__timeline").boundingBox())!];
    expect(Math.abs(d.x + d.width / 2 - (slot.x + slot.width / 2))).toBeLessThan(1);
    expect(Math.abs(d.y + d.height - (slot.y + slot.height))).toBeLessThan(1);
    expect(d.y).toBeLessThan(timeline.y);
  };
  await fits();
  await setMarker(page, 2);
  await expect.poll(async () => {
    const [d, slot] = [(await drawing.boundingBox())!, (await marker(page).boundingBox())!];
    return Math.round(d.x + d.width / 2 - (slot.x + slot.width / 2));
  }).toBe(0);
  await fits();
  // The drawing's head drags the marker, too.
  const head = (await drawing.boundingBox())!;
  await page.mouse.move(head.x + head.width / 2, head.y + 3);
  await page.mouse.down();
  const to = await gapPoint(page, 5);
  await page.mouse.move(to.x, head.y + 3, { steps: 8 });
  await page.mouse.up();
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  await fits();
});

test("highlights keep their colours past the marker, and the focused entry stands out", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await openCode(page);
  await setMarker(page, 5);
  await timelineEntry(page, "chamfer1").click();
  await timelineEntry(page, "notch").hover();
  const style = (locator: Locator) =>
    locator.evaluate((e) => {
      const probe = document.createElement("span");
      e.closest(".cad-model")!.append(probe);
      const variable = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      const s = getComputedStyle(e);
      const result = { border: s.borderTopColor, borderStyle: s.borderTopStyle, outline: `${s.outlineStyle} ${s.outlineWidth}`, filter: s.filter, image: s.backgroundImage, fg: variable("--cad-model-fg"), accent: variable("--cad-model-accent"), warning: variable("--cad-model-warning"), plain: getComputedStyle(document.querySelector('.cad-editor__entry[data-name="sketch1"]')!).borderTopColor };
      probe.remove();
      return result;
    });

  // The hovered and the open entry get the thick outline, and the open one no extra border.
  expect(await style(timelineEntry(page, "notch"))).toMatchObject({ outline: "solid 2px" });
  const open = await style(timelineEntry(page, "chamfer1"));
  expect(open.outline).toBe("solid 2px");
  // chamfer1 is past the marker and depends on notch through a reference: a solid border in the dependent colour, not greyed.
  expect(open).toMatchObject({ border: open.warning, borderStyle: "solid", filter: "none" });
  // fillet1, before the marker, depends on notch, too (body and reference).
  const fillet = await style(timelineEntry(page, "fillet1"));
  expect(fillet).toMatchObject({ border: fillet.warning, filter: "none" });
  expect(await style(timelineEntry(page, "extrude1"))).toMatchObject({ border: open.accent });
  expect(await style(timelineEntry(page, "sketch2"))).toMatchObject({ border: open.accent });

  // Closing the dialog leaves chamfer1 with the plain border.
  await page.mouse.move(0, 0);
  await timelineEntry(page, "chamfer1").click();
  await timelineEntry(page, "sketch1").hover();
  const closed = await style(timelineEntry(page, "chamfer1"));
  expect(closed.outline.startsWith("none")).toBe(true);
  expect(closed.border).toBe(closed.plain);

  // In the code: thin underlines in the relation's colour, unfiltered past the marker, and a bar in the gutter.
  await timelineEntry(page, "notch").hover();
  const code = page.locator(".cad-model__code");
  const dependent = code.locator(".cad-model__related--dependent").filter({ hasText: "const chamfer1" });
  const mark = await style(dependent);
  expect(mark.filter).toBe("none");
  expect(mark.image).toContain(mark.warning);
  expect(await style(code.locator(".cad-model__related--self"))).toMatchObject({ filter: "none" });
  await expect(code.locator(".cad-model__relation-bar--self")).toHaveCount(1);
  await expect(code.locator(".cad-model__relation-bar--dependency")).toHaveCount(2);
  await expect(code.locator(".cad-model__relation-bar--dependent")).toHaveCount(3);
  await expect(code.locator(".cad-model__relation-bar--dependent.cad-model__relation-bar--hard")).toHaveCount(3);
});

test("the marker survives a reload, broken code and deleting the entry after it; a moved feature keeps its dialog", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await openM1(page);
  await setMarker(page, 5);

  // It is the user's UI state, so it comes back after a reload.
  await reloadStored(page);
  await expect(timelineEntry(page, "extrude2")).toBeVisible({ timeout: 120_000 });
  await hideSidebars(page);
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");

  // While the code doesn't parse, the timeline and the marker stay as they were.
  const source = await modelSource(page);
  await setModelSource(page, source.replace("const sketch3 =", "const sketch3 = ("));
  await expect(page.locator(".cad-editor__banner")).toContainText("doesn't parse");
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  await setModelSource(page, source);
  await expect(page.locator(".cad-editor__banner")).toHaveCount(0);
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");

  // A dialog stays open on its feature while the feature moves.
  await timelineEntry(page, "chamfer1").click();
  await expect(dialog(page)).toHaveAttribute("data-feature", "chamfer1");
  await dragTo(page, timelineEntry(page, "chamfer1"), 4);
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "fillet1", "sketch3", "extrude2"]);
  await expect(dialog(page)).toHaveAttribute("data-feature", "chamfer1");
  // chamfer1 went before fillet1, which was before the marker; both still are.
  await expect(editorView(page)).toHaveAttribute("data-marker", "6");

  // Deleting the entry right after the marker leaves the marker before the next one.
  await timelineEntry(page, "sketch3").click();
  await dialog(page).getByRole("button", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete sketch3" }).click();
  await expect.poll(() => names(page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "fillet1", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "6");
  expect(await pastMarker(page)).toEqual(["extrude2"]);
});

test("a feature inserted after a loop works on the body the loop made", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, exampleSource("m3"));
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  // Before fillet1, right after the rib loop, which reassigns `body`.
  await setMarker(page, 5);
  await toolbarButton(page, "Chamfer").click();
  await expect.poll(() => modelSource(page)).toContain("const chamfer2 = chamfer({ body: body, edges: [], distance: 1 });\n  const fillet1 = fillet({ body: chamfer2, edges: ");
  await expect(editorView(page)).toHaveAttribute("data-marker", "6");
  await expect(timelineEntry(page, "chamfer2")).not.toHaveAttribute("data-status", "unused");
});

test("when another user moves the entry after the marker, the marker stays between its neighbours", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await openM1(a.page);
  await setMarker(a.page, 4);
  await bootToFrame(b.page, docPathWith(a.page));
  await expect(timelineEntry(b.page, "extrude2")).toBeVisible({ timeout: 120_000 });
  await hideSidebars(b.page);
  // Built, so that B's timeline has settled before the drag measures it.
  await expect(editorView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // B moves fillet1, which A's marker is anchored to, after chamfer1.
  await dragTo(b.page, timelineEntry(b.page, "fillet1"), 6);
  await expect.poll(() => names(a.page)).toEqual(["sketch1", "extrude1", "sketch2", "notch", "chamfer1", "fillet1", "sketch3", "extrude2"]);
  await expect(editorView(a.page)).toHaveAttribute("data-marker", "4");
  expect(await pastMarker(a.page)).toEqual(["chamfer1", "fillet1", "sketch3", "extrude2"]);
  await expect(editorView(b.page)).toHaveAttribute("data-marker", "8");
});

/** The marker's drawing is centred on its slot. */
async function expectDrawingOnSlot(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const slot = document.querySelector(".cad-editor__marker")!.getBoundingClientRect();
        const drawing = document.querySelector(".cad-editor__marker-drawing")!.getBoundingClientRect();
        return Math.round(drawing.left + drawing.width / 2 - (slot.left + slot.width / 2));
      }),
    )
    .toBe(0);
}

test("a Custom Script with replicad code moves before a feature", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  const source = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
import { drawRoundedRectangle, drawCircle } from "replicad";

export const defaultParams = { width: 100, depth: 40, height: 12, hole: 30 };

export default function main({ width, depth, height, hole }) {
  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 20, operation: "new" });
  const cut_plate = plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
  return [cut_plate, extrude1];
}
`;
  await setModelSource(page, source);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => names(page)).toEqual(["script", "sketch1", "extrude1", "script"]);
  // The trial build gets the replicad globals a build gets, so the move goes through.
  await dragTo(page, entries(page).nth(3), 1);
  await expect.poll(() => modelSource(page)).toContain("extrude(height);\n  const cut_plate = plate.cut(bore)");
  await expect(page.locator(".cad-model__notice")).toHaveCount(0);
  await expect.poll(() => names(page)).toEqual(["script", "sketch1", "extrude1"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "3");
  await expectDrawingOnSlot(page);
});

test("typing in the code pane keeps the timeline, the marker and the highlights in step", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await openM1(page);
  await openCode(page);
  await setMarker(page, 5);
  const past = page.locator(".cad-model__code .cad-model__past-marker");
  await expect(past).toHaveCount(3);
  // Highlights are showing while the user types: a decoration dispatched during CodeMirror's own update would throw.
  await timelineEntry(page, "notch").hover();
  await expect(page.locator(".cad-model__code .cad-model__related--self")).toHaveCount(1);
  const line = async (n: number) => {
    await editor(page).focus();
    await pressMod(page, "Home");
    for (let i = 1; i < n; i++) await page.keyboard.press("ArrowDown");
  };
  // Line 10 is sketch2: move it above extrude1 by hand.
  await line(10);
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => names(page)).toEqual(["sketch1", "sketch2", "extrude1", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "5");
  await expect(past).toHaveCount(3);
  await expectDrawingOnSlot(page);
  // Delete sketch1's line (now line 8): one entry less before the marker.
  await line(8);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect.poll(() => names(page)).toEqual(["sketch2", "extrude1", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"]);
  await expect(editorView(page)).toHaveAttribute("data-marker", "4");
  await expect(past).toHaveCount(3);
  await expect(past.first()).toContainText("const chamfer1");
  await expectDrawingOnSlot(page);
  // The highlights still follow the pointer.
  await timelineEntry(page, "fillet1").hover();
  await expect(timelineEntry(page, "chamfer1")).toHaveAttribute("data-relation", "dependent");
  await expect(page.locator(".cad-model__code .cad-model__related--self")).toContainText("const fillet1");
  // A dispatch during CodeMirror's update throws this, and the exception stops Solid's updates of the timeline.
  expect(errors.filter((e) => e.includes("EditorView.update"))).toEqual([]);
});

/** A Custom Script that changes a value a sketch reads: whether it can move depends on what the code does. */
const scripted = `import { sketch, plane, rect, circle, extrude } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 20 };

export default function main({ w, d, h }) {
  const hole = { r: 8 };
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: h });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [w / 2, d / 2], radius: hole.r }) });
  const notch = extrude({ sketch: sketch2, operation: "cut", target: extrude1, extent: "through" });
  hole.r = 0;
  return notch;
}
`;

test("a Custom Script moves only if a trial build of the move doesn't break the model", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await hideSidebars(page);
  await setModelSource(page, scripted);
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await expect.poll(() => names(page)).toEqual(["script", "sketch1", "extrude1", "sketch2", "notch", "script"]);
  const script = entries(page).nth(5);

  // Before sketch2, the hole's radius would be 0 when the sketch reads it.
  await dragTo(page, script, 3);
  await expect(page.locator(".cad-model__notice")).toContainText("Moving the Custom Script at lines 11–11 before sketch2 breaks");
  expect(await modelSource(page)).toBe(scripted);

  // Before notch, the sketch has read it already.
  await dragTo(page, script, 4);
  await expect.poll(() => modelSource(page)).toContain("hole.r = 0;\n  const notch = ");
  await expect(timelineEntry(page, "notch")).toHaveAttribute("data-status", "ok");
});

/** WCAG's contrast ratio of two sRGB colors. */
function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** `grayscale(1)` as the Filter Effects spec defines it, applied to sRGB values. */
const grayscale = ([r, g, b]: number[]) => {
  const v = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return [v, v, v];
};

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test("code past the marker is grey without losing contrast", async ({ users }) => {
      const [a] = await users(1);
      if (!a) throw new Error("users(1) returned no user");
      const { page } = a;
      await openM1(page);
      await openCode(page);
      await dragTo(page, marker(page), 1);
      await expect(page.locator(".cad-model__code .cad-model__past-marker")).toHaveCount(7);
      // The theme extension loads asynchronously; wait until the editor has its colors.
      await expect.poll(() => page.locator(".cad-model__code .cm-editor").evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      const colors = await page.locator(".cad-model__code").evaluate((code) => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const background = rgb(getComputedStyle(code.querySelector(".cm-editor")!).backgroundColor);
        const lines = [...code.querySelectorAll<HTMLElement>(".cad-model__past-marker")];
        const tokens = lines.flatMap((line) => [...line.querySelectorAll<HTMLElement>("span")]).filter((e) => e.textContent?.trim());
        const style = (e: HTMLElement) => ({ color: rgb(getComputedStyle(e).color), filter: getComputedStyle(e).filter, fontStyle: getComputedStyle(e).fontStyle });
        return { background, lines: lines.map(style), tokens: tokens.map(style) };
      });
      // The tokens are greyed, and everything is italic, which the theme's token styles must not override.
      expect(colors.tokens.length).toBeGreaterThan(20);
      for (const token of colors.tokens) expect(token).toMatchObject({ filter: "grayscale(1)", fontStyle: "italic" });
      for (const line of colors.lines) expect(line).toMatchObject({ filter: "none", fontStyle: "italic" });
      // Greying never takes a token below 4.5:1, or below its own contrast where the theme's is lower
      // (Patchwork's light theme has tokens at 2.9:1, which the grayscale raises).
      for (const { color } of colors.tokens) expect(contrast(grayscale(color), colors.background)).toBeGreaterThanOrEqual(Math.min(4.5, contrast(color, colors.background)));
      for (const { color } of colors.lines) expect(contrast(color, colors.background)).toBeGreaterThanOrEqual(4.5);
    });
  });
}
