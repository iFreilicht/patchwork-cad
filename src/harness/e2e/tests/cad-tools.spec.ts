/**
 * The two tools on one model document (research/07, "Two tools"): the viewer only shows and can be
 * embedded with <patchwork-view>, and an open feature dialog in the editor keeps its feature while
 * another user renames it or edits above it.
 */
import { CAD_MODULES, cadView, dialog, docPathWith, docUrl, editorView, modelSource, openCode, openWithTool, setModelSource, timelineEntry, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

test("the viewer and an embedded viewer show one document", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createViaMenu(page, "CAD Model");
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });

  await openWithTool(page, "cad-model-viewer");
  const viewer = page.locator(".cad-model--viewer");
  await expect(viewer).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(await vertices(page)).toBeGreaterThan(0);
  await expect(viewer.locator("input, select, .cm-content, button")).toHaveCount(0);

  // Another tool embeds the viewer by id; inside a tool's DOM, it finds Patchwork's providers.
  await openWithTool(page, "cad-model");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await page.evaluate((url) => {
    const view = document.createElement("patchwork-view");
    view.setAttribute("doc-url", url);
    view.setAttribute("tool-id", "cad-model-viewer");
    view.id = "embedded";
    view.style.cssText = "position: absolute; right: 0; bottom: 0; width: 400px; height: 200px; z-index: 10; display: block";
    document.querySelector(".cad-model--editor")!.append(view);
  }, docUrl(page));
  const embedded = page.locator("#embedded .cad-model--viewer");
  await expect(embedded).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  const before = Number(await embedded.getAttribute("data-builds-executed"));

  // An edit in the editor's code pane rebuilds the embedded viewer too.
  await openCode(page);
  await page.locator(".cad-model__code .cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" // from the code pane");
  await expect.poll(() => modelSource(page)).toContain("// from the code pane");
  await expect.poll(async () => Number(await embedded.getAttribute("data-builds-executed"))).toBeGreaterThan(before);
});

test("an open dialog keeps its feature while another user renames it, edits above it or replaces the text", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createViaMenu(a.page, "CAD Model");
  await expect(editorView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await bootToFrame(b.page, docPathWith(a.page));
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await openCode(b.page);

  await timelineEntry(a.page, "bore").click();
  await expect(dialog(a.page)).toHaveAttribute("data-feature", "bore");

  // B renames the variable everywhere: a name-based identity would close the dialog.
  const source = await modelSource(b.page);
  await setModelSource(b.page, source.replaceAll(/\bbore\b/g, "drill"));
  await expect(timelineEntry(a.page, "drill")).toHaveCount(1);
  await expect(dialog(a.page)).toHaveAttribute("data-feature", "drill");

  // B inserts a feature above it.
  const renamed = await modelSource(b.page);
  await setModelSource(b.page, renamed.replace("  const sketch2 =", `  const sketch3 = sketch({ plane: plane("XZ"), profile: rect({ from: [0, 0], to: [5, 5] }) });\n  const sketch2 =`));
  await expect(timelineEntry(a.page, "sketch3")).toHaveCount(1);
  await expect(dialog(a.page)).toHaveAttribute("data-feature", "drill");

  // B replaces the whole text, which loses every cursor: the dialog falls back to the variable.
  await setModelSource(b.page, (await modelSource(b.page)).replace("const sketch3 = sketch", "const sketch4 = sketch"), "replace");
  await expect(timelineEntry(a.page, "sketch4")).toHaveCount(1);
  await expect(dialog(a.page)).toHaveAttribute("data-feature", "drill");

  // A's form edit still lands in the right call, also when a remote edit and a rebuild arrive
  // while A is typing.
  const distance = dialog(a.page).getByLabel("Distance", { exact: true });
  await distance.fill("5");
  const element = await distance.elementHandle();
  const executed = Number(await editorView(a.page).getAttribute("data-builds-executed"));
  await setModelSource(b.page, (await modelSource(b.page)).replace("export default", "// remote\nexport default"));
  await expect.poll(async () => Number(await editorView(a.page).getAttribute("data-builds-executed"))).toBeGreaterThan(executed);
  // The input A types in must survive: Chromium commits a removed input on blur, Firefox drops it.
  expect(await element!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(distance).toHaveValue("5");
  await distance.press("Enter");
  await expect.poll(() => modelSource(b.page)).toContain(`const drill = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through", distance: 5 });`);
});
