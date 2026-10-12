import { waitForServiceWorkerActive } from "@inkandswitch/patchwork-e2e/helpers";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test("the full UI boots against the local stack", async ({ users }) => {
  const [user] = await users(1);
  if (!user) throw new Error("no user");
  await bootToFrame(user.page);
  await waitForServiceWorkerActive(user.page);
  // The account and the base modules are in place: the create-new menu lists Markdown.
  await user.page.getByRole("button", { name: "create new" }).click();
  await expect(user.page.locator(".popmenu__item", { hasText: "Markdown" }).first()).toBeVisible();
});
