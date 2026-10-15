/**
 * Per-user UI state in the account's tool storage (research/10-view-state.md): the editor reopens
 * the code pane of a model it was open for, after a tool switch and after a reload.
 */
import { CAD_MODULES, createModel, editorView, openCode, openWithTool } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

test("the editor remembers per model whether the code pane was open", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const code = page.locator(".cad-model__code");
  await expect(code).toHaveCount(0);
  await openCode(page);
  const first = page.url();

  await openWithTool(page, "cad-model-viewer");
  await expect(page.locator(".cad-model--viewer")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await openWithTool(page, "cad-model");
  await expect(code).toHaveCount(1);

  await page.reload();
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(1);

  // Another model starts closed, and closing it there leaves the first one open.
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(0);
  await page.goto(first);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(code).toHaveCount(1);
});
