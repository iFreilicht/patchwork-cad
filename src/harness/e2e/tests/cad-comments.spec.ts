/**
 * Comments on the model (research/13-collaboration.md, "Comments"): threads in Patchwork's format in
 * the model document, on code, features, faces and edges, rendered by Patchwork's `comment-thread`
 * tool, between two users.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, cadView, createModel, docPathWith, exampleSource, hideSidebars, openCode, setModelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

/** A opens M1 in the editor; B opens the same model, in `tool` if given, and keeps the context sidebar if `panel`. */
async function twoUsers(users: (n: number) => Promise<{ page: Page }[]>, tool?: string, panel = false) {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createModel(a.page);
  await hideSidebars(a.page);
  await setModelSource(a.page, exampleSource("m1"));
  await expect(timelineEntry(a.page, "extrude2")).toHaveAttribute("data-status", "ok", { timeout: 120_000 });
  await bootToFrame(b.page, docPathWith(a.page, tool));
  if (panel) await b.page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  else await hideSidebars(b.page);
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  return { a: a.page, b: b.page };
}

/** Writes and saves the draft in an open thread popover. */
async function writeComment(popover: Locator, text: string) {
  const draft = popover.locator(".comment-draft-editor .cm-content");
  await draft.click();
  await draft.pressSequentially(text);
  await popover.getByRole("button", { name: "Save" }).click();
}

/** Comments on the code line containing `text`. */
async function commentOnCode(page: Page, text: string, comment: string) {
  await codeLine(page, text).click({ position: { x: 2, y: 4 } });
  await page.keyboard.press("Shift+End");
  await page.locator(".cad-model__comment-button").click();
  const popover = page.locator(".cad-model__comment-popover");
  await writeComment(popover, comment);
  await expect(popover).toHaveCount(0);
}

/** Patchwork's Comments panel in the context sidebar. */
async function commentsPanel(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Comments" }).click();
  return page.locator(".comments-panel");
}

const codeLine = (page: Page, text: string) => page.locator(".cad-model__code .cm-line", { hasText: text }).first();

test("a comment on code shows for the other user, who opens its thread from the code", async ({ users }) => {
  const { a, b } = await twoUsers(users);
  await openCode(a);
  await openCode(b);

  // A selects a line and comments on it.
  await codeLine(a, "const extrude1").click({ position: { x: 2, y: 4 } });
  await a.keyboard.press("Shift+End");
  await a.locator(".cad-model__comment-button").click();
  const popover = a.locator(".cad-model__comment-popover");
  await writeComment(popover, "Too thin?");
  await expect(popover).toHaveCount(0);
  await expect(a.locator(".cad-model__code .cad-model__comment")).toHaveText(/const extrude1/);

  // B sees the commented code and opens the thread by clicking it.
  const marked = b.locator(".cad-model__code .cad-model__comment");
  await expect(marked).toHaveText(/const extrude1/, { timeout: 15_000 });
  await marked.click();
  await expect(b.locator(".cad-model__comment-popover .comment-content")).toHaveText("Too thin?");
});

test("dismissing a new thread without writing leaves no thread behind", async ({ users }) => {
  const { a } = await twoUsers(users);
  await openCode(a);
  await codeLine(a, "const extrude1").click({ position: { x: 2, y: 4 } });
  await a.keyboard.press("Shift+End");
  await a.locator(".cad-model__comment-button").click();
  await expect(a.locator(".cad-model__comment-popover .comment-draft-editor")).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.locator(".cad-model__comment-popover")).toHaveCount(0);
  await expect(a.locator(".cad-model__code .cad-model__comment")).toHaveCount(0);
});

test("Patchwork's Comments panel lists threads on the model and focuses them in the code", async ({ users }) => {
  const { a, b } = await twoUsers(users, undefined, true);
  await openCode(a);
  await commentOnCode(a, "const extrude1", "Too thin?");
  await commentOnCode(a, "const fillet1", "Bigger radius");

  await openCode(b);
  const panel = await commentsPanel(b);
  const threads = panel.locator(".comments-thread");
  await expect(threads).toHaveCount(2, { timeout: 15_000 });
  const focused = b.locator(".cad-model__code .cad-model__comment--focused");
  await expect(focused).toHaveCount(0);

  // Clicking a thread in the panel focuses its code.
  await threads.filter({ hasText: "Bigger radius" }).locator(".comment-content").click();
  await expect(focused).toHaveText(/const fillet1/);

  // Moving the cursor into the other commented code brings that thread up in the panel.
  await codeLine(b, "const extrude1").click({ position: { x: 60, y: 4 } });
  await expect(focused).toHaveText(/const extrude1/);
});

/** Selects a timeline entry and opens its comments. */
async function openEntryComments(page: Page, name: string): Promise<Locator> {
  await timelineEntry(page, name).click();
  await page.locator(".cad-editor__comment").click();
  return page.getByRole("dialog", { name: `Comments on ${name}` });
}

test("a comment on a timeline entry shows on it for the other user, also in the Comments panel", async ({ users }) => {
  const { a, b } = await twoUsers(users, undefined, true);
  const popover = await openEntryComments(a, "extrude1");
  await writeComment(popover, "Make it 25");
  await expect(popover.locator(".comment-content")).toHaveText("Make it 25");
  await a.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(timelineEntry(a, "extrude1")).toHaveAttribute("data-comments", "1");

  await expect(timelineEntry(b, "extrude1")).toHaveAttribute("data-comments", "1", { timeout: 15_000 });
  const theirs = await openEntryComments(b, "extrude1");
  await expect(theirs.locator(".comment-content")).toHaveText("Make it 25");
  if (shots) await b.screenshot({ path: `${shots}/comments-1-timeline.png` });
  await b.keyboard.press("Escape");

  // Its statement is a range in the code, so Patchwork's panel lists it; focusing it there outlines the entry.
  await timelineEntry(b, "sketch1").click();
  await expect(timelineEntry(b, "extrude1")).not.toHaveAttribute("data-comment-focused", "true");
  const panel = await commentsPanel(b);
  await panel.locator(".comments-thread .comment-content", { hasText: "Make it 25" }).click();
  await expect(timelineEntry(b, "extrude1")).toHaveAttribute("data-comment-focused", "true");
  if (shots) await b.screenshot({ path: `${shots}/comments-2-panel.png` });
});

test("the context menu starts a comment; a second one on the same entry adds to its threads", async ({ users }) => {
  const { a } = await twoUsers(users);
  await timelineEntry(a, "notch").click({ button: "right" });
  await a.getByRole("menuitem", { name: "Comment" }).click();
  const popover = a.getByRole("dialog", { name: "Comments on notch" });
  await writeComment(popover, "Through all?");
  await popover.getByRole("button", { name: "New comment" }).click();
  await writeComment(popover, "Or 10 mm deep");
  await expect(popover.locator(".comment-content")).toHaveText(["Through all?", "Or 10 mm deep"]);
  await a.keyboard.press("Escape");
  await expect(timelineEntry(a, "notch")).toHaveAttribute("data-comments", "2");
});
