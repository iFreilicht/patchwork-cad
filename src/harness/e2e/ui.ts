import { waitForRepoReady } from "@inkandswitch/patchwork-e2e/helpers";
import { expect, type Page } from "@playwright/test";

/** Opens a path and waits for the threepane frame and the tab's Repo. */
export async function bootToFrame(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.waitForSelector(".threepane-sidebar", { timeout: 120_000 });
  await waitForRepoReady(page);
}

/** Creates a document through the create-new menu; retries while the datatype's module is still loading. */
export async function createViaMenu(page: Page, datatype: string): Promise<void> {
  const item = page.locator(".popmenu__item", { hasText: datatype }).first();
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "create new" }).click();
    await expect(item).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await item.click();
  await expect(page).toHaveURL(/doc=automerge:/, { timeout: 30_000 });
}

export const editor = (page: Page) => page.locator(".cm-content").first();

/**
 * Presses a shortcut with CodeMirror's Mod key. It follows the page's
 * navigator.platform, which device emulation sets (Win32 for the desktop
 * Chrome and Firefox devices), while Playwright's ControlOrMeta follows the
 * host OS.
 */
export async function pressMod(page: Page, key: string): Promise<void> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+${key}`);
}

export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await pressMod(page, "End");
  await page.keyboard.type(text);
}

export async function typeAtStart(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await pressMod(page, "Home");
  await page.keyboard.type(text);
}

/** The `#…` part of the page URL, which opens the current document in another profile. */
export const docPath = (page: Page) => `/${new URL(page.url()).hash}`;
