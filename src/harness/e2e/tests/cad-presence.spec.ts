/**
 * Collaborators' presence (research/13-collaboration.md): two users on one model see each other's
 * selected and hovered faces, pointers, hovered timeline entries, timeline markers and code carets
 * in their colours, in the editor and, in 3D, in the viewer.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, clickEntity, createModel, docPathWith, editorView, entities, exampleSource, hideSidebars, openCode, setModelSource, timelineEntry, type Entity } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();

interface Hook {
  cadViewer: {
    screenPoint(e: Entity): { x: number; y: number } | undefined;
    highlighted(style: "peer"): Entity[];
  };
}

const reference = (page: Page) => page.locator(".cad-model__reference code");

/** Hovers the visible faces until the status bar names one starting with `name`; the mouse stays on it. */
async function hoverNamed(page: Page, name: string): Promise<Entity> {
  for (const face of await entities(page, "face")) {
    const point = await viewer(page).evaluate((el, e) => (el as unknown as Hook).cadViewer.screenPoint(e), face);
    if (!point) continue;
    await page.mouse.move(point.x, point.y);
    if ((await viewer(page).getAttribute("data-hovered")) !== `${face.body}:face:${face.index}`) continue;
    await expect(reference(page)).toHaveCount(1);
    if (((await reference(page).textContent()) ?? "").startsWith(name)) return face;
  }
  throw new Error(`no visible face named ${name}…`);
}

const peerHighlight = (page: Page) => viewer(page).evaluate((el) => (el as unknown as Hook).cadViewer.highlighted("peer"));
const peerMarkers = (page: Page) => viewer(page).getAttribute("data-peer-markers");

/** A face that a click reaches. */
async function visibleFace(page: Page): Promise<{ face: Entity; point: { x: number; y: number } }> {
  for (const face of await entities(page, "face")) {
    const point = await viewer(page).evaluate((el, e) => (el as unknown as Hook).cadViewer.screenPoint(e), face);
    if (point) return { face, point };
  }
  throw new Error("no visible face");
}

/** A opens M1 in the editor; B opens the same model, in `tool` if given. */
async function twoUsers(users: (n: number) => Promise<{ page: Page }[]>, tool?: string) {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createModel(a.page);
  await hideSidebars(a.page);
  await setModelSource(a.page, exampleSource("m1"));
  await expect(timelineEntry(a.page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await bootToFrame(b.page, docPathWith(a.page, tool));
  await hideSidebars(b.page);
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => entities(b.page, "face").then((f) => f.length), { timeout: 60_000 }).toBeGreaterThan(0);
  return { a: a.page, b: b.page };
}

test("two editors show each other's selections, pointers, timeline and code", async ({ users }) => {
  const { a, b } = await twoUsers(users);

  // A selects a face: B's view highlights it, and shows A's pointer on it.
  const { face } = await visibleFace(a);
  await clickEntity(a, face);
  await expect(viewer(a)).toHaveAttribute("data-selected", `${face.body}:face:${face.index}`);
  await expect.poll(() => peerHighlight(b), { timeout: 15_000 }).toContainEqual(face);
  await expect(viewer(b)).toHaveAttribute("data-peer-markers", "1");
  if (shots) await b.screenshot({ path: `${shots}/presence-1-selection.png` });
  // Leaving the view removes the pointer; the selection stays.
  await timelineEntry(a, "notch").hover();
  await expect(viewer(b)).toHaveAttribute("data-peer-markers", "0");
  expect(await peerHighlight(b)).toContainEqual(face);

  // Hovering a timeline entry outlines it for B.
  await expect(timelineEntry(b, "notch")).toHaveAttribute("data-peer", "true");
  if (shots) await b.screenshot({ path: `${shots}/presence-2-timeline-hover.png` });
  await a.mouse.move(0, 0);
  await expect(timelineEntry(b, "notch")).not.toHaveAttribute("data-peer", "true");

  // A's timeline marker shows in B's timeline where A put it.
  const marker = a.getByRole("slider", { name: "Timeline marker" });
  await marker.focus();
  await a.keyboard.press("Home");
  await expect(b.locator(".cad-editor__peer-marker")).toHaveAttribute("data-position", "0");
  if (shots) await b.screenshot({ path: `${shots}/presence-3-marker.png` });
  await a.keyboard.press("End");
  const end = await timelineEntryCount(b);
  await expect(b.locator(".cad-editor__peer-marker")).toHaveAttribute("data-position", String(end));
  // A collaborator's marker at the end stays there while one's own moves.
  await b.getByRole("slider", { name: "Timeline marker" }).focus();
  await b.keyboard.press("Home");
  await expect(a.locator(".cad-editor__peer-marker")).toHaveAttribute("data-position", "0");
  await expect(b.locator(".cad-editor__peer-marker")).toHaveAttribute("data-position", String(end));
  await b.keyboard.press("End");

  // The marker has the colour of A's name: the hashed one, and then the one A chooses.
  const colours = () => Promise.all([b.locator(".cad-editor__peer-marker"), b.locator(".cad-editor__peer-name .contact-cursor-token")].map((l) => l.evaluate((el) => getComputedStyle(el).backgroundColor)));
  await expect.poll(colours, { timeout: 15_000 }).toEqual([expect.stringMatching(/^rgb\(/), expect.stringMatching(/^rgb\(/)]);
  const [hashed, name] = await colours();
  expect(name).toBe(hashed);
  await a.evaluate(async () => {
    const url = Object.values((window as unknown as { cadPresence(): Record<string, { contactUrl: string }> }).cadPresence())[0]!.contactUrl;
    const contact = await (globalThis as unknown as { repo: { find(url: string): Promise<{ change(f: (d: { color?: string }) => void): void }> } }).repo.find(url);
    contact.change((d) => (d.color = "rgb(200, 100, 0)"));
  });
  await expect.poll(colours, { timeout: 15_000 }).toEqual(["rgb(200, 100, 0)", "rgb(200, 100, 0)"]);

  // A's caret shows in B's code pane while A's code pane has the focus.
  await openCode(a);
  await openCode(b);
  await a.locator(".cad-model__code .cm-line").nth(2).click();
  await expect(b.locator(".cad-model__code .cad-model__caret")).toHaveCount(1);
  if (shots) await b.screenshot({ path: `${shots}/presence-4-caret.png` });
  await a.locator(".cad-model__code .cm-content").evaluate((el) => (el as HTMLElement).blur());
  await expect(b.locator(".cad-model__code .cad-model__caret")).toHaveCount(0);
});

test("the viewer shows collaborators in 3D and shares its own pointer and selection", async ({ users }) => {
  const { a, b } = await twoUsers(users, "cad-model-viewer");

  const { face } = await visibleFace(a);
  await clickEntity(a, face);
  await expect.poll(() => peerHighlight(b), { timeout: 15_000 }).toContainEqual(face);

  // B points at a face in the viewer: A sees the pointer and the hovered face.
  const { point } = await visibleFace(b);
  await b.mouse.move(point.x, point.y);
  await expect(viewer(b)).not.toHaveAttribute("data-hovered", "");
  const hovered = (await viewer(b).getAttribute("data-hovered"))!.split(":");
  await expect.poll(() => peerMarkers(a), { timeout: 15_000 }).toBe("1");
  await expect.poll(() => peerHighlight(a)).toContainEqual({ body: hovered[0], kind: hovered[1], index: Number(hovered[2]) });
  if (shots) {
    await a.screenshot({ path: `${shots}/presence-5-viewer-pointer.png` });
    await b.screenshot({ path: `${shots}/presence-6-viewer.png` });
  }
});

const timelineEntryCount = (page: Page) => page.locator(".cad-editor__entry[data-index]").count();

test("a collaborator's face shows by its reference, also on a timeline rolled back before its split", async ({ users }) => {
  const { a, b } = await twoUsers(users);
  // B rolls back to before the notch, which splits the block's front face in two.
  await b.getByRole("slider", { name: "Timeline marker" }).focus();
  for (const key of ["Home", "ArrowRight", "ArrowRight", "ArrowRight"]) await b.keyboard.press(key);
  await expect(editorView(b)).toHaveAttribute("data-rolled-back", "true");

  // A selects the piece of the front face right of the notch.
  const piece = await hoverNamed(a, "extrude1.side.front.piece(notch, 2");
  await a.mouse.down();
  await a.mouse.up();
  await expect(viewer(a)).toHaveAttribute("data-selected", `${piece.body}:face:${piece.index}`);

  // B, before the split, shows it on the unsplit front face.
  // A's hover, still on the piece, and selection both name it: one face.
  const distinct = async () => [...new Set((await peerHighlight(b)).map((e) => JSON.stringify(e)))].map((s) => JSON.parse(s) as Entity);
  await expect.poll(distinct, { timeout: 15_000 }).toHaveLength(1);
  const [shown] = await distinct();
  const point = await viewer(b).evaluate((el, e) => (el as unknown as Hook).cadViewer.screenPoint(e), shown!);
  await b.mouse.move(point!.x, point!.y);
  await expect(reference(b)).toHaveText("extrude1.side.front");
});
