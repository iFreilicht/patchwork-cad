/**
 * tldraw's own undo against the document's history (research/16-undo-redo.md, "tldraw"): the same
 * mouse and keyboard actions in PB's tldraw5 tool and in research/16's tool, which undoes with the
 * UndoManager, and the shapes after every undo and redo.
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { hideSidebars, openWithTool } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { HARNESS_DIR } from "../stack.ts";
import { bootToFrame, createViaMenu, docPath, pressMod } from "../ui.ts";

test.use({ siteModules: { "undo-tldraw": join(HARNESS_DIR, "..", "..", "research", "16-undo-redo", "tldraw") } });
// tldraw loads its fonts and icons from its CDN; the egress proxy refuses them, the canvas works without.
test.use({ egressAllowed: true });

type Shape = { type: string; x: number; y: number; w?: number; h?: number };

/** The document's shapes, by position relative to the first one drawn: each tool's camera starts elsewhere. */
async function shapes(page: Page): Promise<Shape[]> {
  const url = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("doc")!;
  const records = await page.evaluate(async (u) => {
    const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): { store: Record<string, any> } }> } }).repo;
    return Object.values((await repo.find(u)).doc().store).filter((r) => r.typeName === "shape");
  }, url);
  const origin = (page as unknown as { origin?: [number, number] }).origin ?? [0, 0];
  return records
    .map((r) => ({ type: r.type, x: Math.round(r.x - origin[0]), y: Math.round(r.y - origin[1]), ...(r.props?.w ? { w: Math.round(r.props.w), h: Math.round(r.props.h) } : {}) }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  // In steps, with a pause in the middle that is longer than the 500 ms that group typing.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + from[0] + ((to[0] - from[0]) * i) / 10, box.y + from[1] + ((to[1] - from[1]) * i) / 10);
    if (i === 5) await page.waitForTimeout(700);
  }
  await page.mouse.up();
}

/** Draws two rectangles, moves the first, deletes the second; the shapes after each action. */
async function draw(page: Page): Promise<Shape[][]> {
  const states: Shape[][] = [];
  const settle = async (count: number) => {
    await expect.poll(async () => (await shapes(page)).length).toBe(count);
    await page.waitForTimeout(300);
    states.push(await shapes(page));
  };
  await page.keyboard.press("r");
  await drag(page, [200, 200], [300, 280]);
  await expect.poll(async () => (await shapes(page)).length).toBe(1);
  const [first] = await shapes(page);
  (page as unknown as { origin?: [number, number] }).origin = [first!.x, first!.y];
  await settle(1);
  await page.keyboard.press("r");
  await drag(page, [450, 200], [530, 300]);
  await settle(2);
  // The first rectangle, by its left edge: a hollow shape isn't hit inside.
  await drag(page, [200, 240], [250, 330]);
  await settle(2);
  const box = (await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.click(box.x + 490, box.y + 250);
  await page.keyboard.press("Delete");
  await settle(1);
  return states;
}

/** Presses undo (or redo) until the shapes stop changing; the distinct states. */
async function press(page: Page, key: string): Promise<Shape[][]> {
  const states: Shape[][] = [await shapes(page)];
  for (let same = 0; same < 3; ) {
    await pressMod(page, key);
    await page.waitForTimeout(300);
    const now = await shapes(page);
    if (JSON.stringify(now) === JSON.stringify(states.at(-1))) same++;
    else {
      states.push(now);
      same = 0;
    }
  }
  return states.slice(1);
}

async function session(page: Page, tool: string) {
  await bootToFrame(page);
  await createViaMenu(page, "tldraw");
  // Explicitly: with research/16's tool installed, Patchwork may open tldraw5 documents with either.
  await openWithTool(page, tool);
  await expect(page).toHaveURL(new RegExp(`tool=${tool}`));
  await page.locator(".tl-canvas").waitFor({ timeout: 60_000 });
  // The whole width, so that tldraw doesn't switch to its mobile layout, once the sidebars have collapsed.
  await hideSidebars(page);
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await page.locator(".tl-canvas").boundingBox());
    const stable = now === last;
    last = now;
    return stable;
  }).toBe(true);
  // Keys go to the canvas after a click into it.
  const box = (await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const drawn = await draw(page);
  const undos = await press(page, "z");
  const redos = await press(page, "Shift+KeyZ");
  return { drawn, undos, redos, path: docPath(page) };
}

test("the same steps as tldraw's own history", async ({ users }) => {
  const [a, b] = await users(2);
  const stock = await session(a!.page, "tldraw5");
  const doc = await session(b!.page, "tldraw-doc-undo");
  console.log(JSON.stringify({ stock, doc }, null, 1));
  expect(doc.drawn).toEqual(stock.drawn);
  // Four steps: draw, draw, move, delete; undone back to the empty canvas and redone.
  expect(stock.undos.length).toBe(4);
  expect(doc.undos).toEqual(stock.undos);
  expect(doc.redos).toEqual(stock.redos);
});
