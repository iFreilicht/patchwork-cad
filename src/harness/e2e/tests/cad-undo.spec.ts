/**
 * Undo as the document's history (research/16-undo-redo.md): each tab undoes only its own changes,
 * in the code pane and in the GUI alike, and an undo run is a step of its own.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, dialog, docPathWith, editorView, exampleSource, modelSource, openCode, setModelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, editor, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

/** The undo history groups changes less than 500 ms apart; steps of the tests are further apart. */
const GROUP_DELAY = 600;

async function twoUsers(users: (n: number) => Promise<{ page: Page }[]>, source: string) {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createViaMenu(a.page, "CAD Model");
  await expect(editorView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await setModelSource(a.page, source);
  await bootToFrame(b.page, docPathWith(a.page));
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => modelSource(b.page)).toBe(source);
  return { alice: a.page, bob: b.page };
}

/** Types at the end of line `line` (1-based) of the code pane. */
async function typeAtLineEnd(page: Page, line: number, text: string) {
  await page.waitForTimeout(GROUP_DELAY);
  await editor(page).focus();
  await pressMod(page, "Home");
  for (let i = 1; i < line; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function undo(page: Page, times = 1) {
  for (let i = 0; i < times; i++) await pressMod(page, "z");
}

/** Both tabs show the same source, whose first two lines are `alice` and `bob`. */
async function lines(alice: Page, bob: Page, expected: [string, string]) {
  const firstTwo = async (page: Page) => (await modelSource(page)).split("\n").slice(0, 2);
  await expect.poll(() => firstTwo(alice)).toEqual(expected);
  await expect.poll(() => firstTwo(bob)).toEqual(expected);
}

test("the A–L scenario: each user undoes only their own steps, and an undo run is a step", async ({ users }) => {
  const base = exampleSource("m1");
  const { alice, bob } = await twoUsers(users, `// alice:\n// bob:\n${base}`);
  await openCode(alice);
  await openCode(bob);
  const step = async (page: Page, line: 1 | 2, text: string, expected: [string, string]) => {
    await typeAtLineEnd(page, line, text);
    await lines(alice, bob, expected);
  };

  await step(alice, 1, " A", ["// alice: A", "// bob:"]);
  await step(bob, 2, " B", ["// alice: A", "// bob: B"]);
  await step(alice, 1, " C", ["// alice: A C", "// bob: B"]);
  await step(bob, 2, " D", ["// alice: A C", "// bob: B D"]);
  await step(alice, 1, " E", ["// alice: A C E", "// bob: B D"]);
  await step(bob, 2, " F", ["// alice: A C E", "// bob: B D F"]);
  // 7. G: two undos, one step.
  await undo(alice, 2);
  await lines(alice, bob, ["// alice: A", "// bob: B D F"]);
  await step(bob, 2, " H", ["// alice: A", "// bob: B D F H"]);
  await step(alice, 1, " I", ["// alice: A I", "// bob: B D F H"]);
  // 10. J
  await undo(bob);
  await lines(alice, bob, ["// alice: A I", "// bob: B D F"]);
  // 11. K: I, then G (which brings back C and E), then E.
  await undo(alice);
  await lines(alice, bob, ["// alice: A", "// bob: B D F"]);
  await undo(alice);
  await lines(alice, bob, ["// alice: A C E", "// bob: B D F"]);
  await undo(alice);
  await lines(alice, bob, ["// alice: A C", "// bob: B D F"]);
  await step(bob, 2, " L", ["// alice: A C", "// bob: B D F L"]);
  // The model below was never touched.
  expect((await modelSource(alice)).split("\n").slice(2).join("\n")).toBe(base);
});

test("GUI edits are undone like typing, also with the focus in the 3D view", async ({ users }) => {
  const { alice, bob } = await twoUsers(users, exampleSource("m1"));
  const names = (page: Page) => page.locator(".cad-editor__entry").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset["name"]));
  const before = await modelSource(alice);
  await expect.poll(() => names(alice)).toContain("fillet1");

  await timelineEntry(alice, "fillet1").click();
  await dialog(alice).getByRole("button", { name: "Delete" }).click();
  await dialog(alice).getByRole("button", { name: "Delete fillet1" }).click();
  await expect.poll(() => names(bob)).not.toContain("fillet1");

  // The 3D view takes no focus: the tool last used gets the keys.
  await alice.locator(".cad-model__viewer canvas").click({ position: { x: 5, y: 5 } });
  await undo(alice);
  await expect.poll(() => modelSource(bob)).toBe(before);
  await expect.poll(() => names(bob)).toContain("fillet1");

  await pressMod(alice, "Shift+z");
  await expect.poll(() => names(bob)).not.toContain("fillet1");
  await undo(alice);
  await expect.poll(() => modelSource(bob)).toBe(before);

  // Bob never changed anything: there is nothing for him to undo.
  await bob.locator(".cad-model__viewer canvas").click({ position: { x: 5, y: 5 } });
  await undo(bob);
  await bob.waitForTimeout(500);
  expect(await modelSource(bob)).toBe(before);
});
