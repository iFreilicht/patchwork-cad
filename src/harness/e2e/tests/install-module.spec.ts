import { expect, test } from "../fixtures.ts";
import { counterModuleDir } from "../modules.ts";
import { bootToFrame, createViaMenu, docPath } from "../ui.ts";

// A module published to the local server with pushwork renders for its
// installer and, once the second profile installs it too, for a collaborator.
test("a module published with pushwork installs, renders and syncs", async ({ users, installModule }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  const dir = await counterModuleDir();

  await bootToFrame(a.page);
  await installModule(dir, a);
  await createViaMenu(a.page, "Counter");
  const count = (page: typeof a.page) => page.locator(".e2e-counter__count");
  await expect(count(a.page)).toHaveText("0", { timeout: 60_000 });
  for (let i = 0; i < 3; i++) await a.page.locator(".e2e-counter__increment").click();
  await expect(count(a.page)).toHaveText("3");

  await bootToFrame(b.page);
  await installModule(dir, b);
  await b.page.goto(docPath(a.page));
  await expect(count(b.page)).toHaveText("3", { timeout: 90_000 });
});
