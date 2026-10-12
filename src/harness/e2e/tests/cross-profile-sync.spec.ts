import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, docPath, editor, typeAtEnd } from "../ui.ts";

// The full product loop: two browser profiles (contexts) whose only path to
// each other is the local Subduction server. Adapted from patchwork-e2e's
// cross-profile-sync.spec.
test("a markdown doc round-trips between two profiles via the local sync server", async ({ users, localStack }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");

  await bootToFrame(a.page);
  await createViaMenu(a.page, "Markdown");
  await typeAtEnd(a.page, "\nhello from profile A");
  await expect(editor(a.page)).toContainText("hello from profile A");

  await bootToFrame(b.page, docPath(a.page));
  await expect(editor(b.page)).toContainText("hello from profile A", { timeout: 90_000 });
  await typeAtEnd(b.page, "\nhello back from profile B");
  await expect(editor(a.page)).toContainText("hello back from profile B", { timeout: 90_000 });

  expect(localStack.classicRequests(), "requests to the classic sync server").toBe(0);
});
