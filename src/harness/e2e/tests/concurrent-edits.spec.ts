import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, docPath, editor, typeAtEnd, typeAtStart } from "../ui.ts";

// Two profiles type into the same markdown doc at the same time, at different
// positions: at the same position, CodeMirror maps a cursor past a remote
// insert, so keystrokes legitimately interleave. Both must converge to the
// same text containing both edits.
test("concurrent edits from two profiles converge", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createViaMenu(a.page, "Markdown");
  await typeAtEnd(a.page, "\nseed");
  await bootToFrame(b.page, docPath(a.page));
  await expect(editor(b.page)).toContainText("seed", { timeout: 90_000 });

  await Promise.all([typeAtEnd(a.page, " AAAA from A"), typeAtStart(b.page, "BBBB from B ")]);

  for (const page of [a.page, b.page]) {
    await expect(editor(page)).toContainText("AAAA from A", { timeout: 90_000 });
    await expect(editor(page)).toContainText("BBBB from B", { timeout: 90_000 });
  }
  await expect.poll(async () => (await editor(a.page).innerText()) === (await editor(b.page).innerText())).toBe(true);
});
