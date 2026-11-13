/**
 * Documents entering a model (research/21-embedding.md, "Dropping, pasting, inserting"): documents
 * dragged from Patchwork's sidebar onto the code pane, the timeline, the documents list and the 3D
 * view, onto number fields of a feature, the parameters and a configuration, several at once; the
 * Insert button with a pasted URL, and a paste into the view; a field's dialog where nothing fits;
 * rows of the documents list dragged onto the model and out of it; and drops that aren't the editor's.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, createModel, dialog, docUrl, editorView, modelSource, openCode, setModelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, pressMod } from "../ui.ts";
import { centre, drag, sidebarDocuments, sidebarEntry, type Repo } from "../documents.ts";

test.use({ siteModules: CAD_MODULES });

const status = (page: Page) => page.locator(".cad-model__status").first();
const codePane = (page: Page) => page.locator(".cad-editor__code");
const stage = (page: Page) => page.locator(".cad-editor__stage");

async function open(page: Page, source: string) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // The document sidebar stays, where documents are dragged from; the context sidebar would leave the editor little room.
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, source, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  // Changes within 500 ms of each other are one undo step (research/16): the tests' first drop may come sooner than a person's.
  await page.waitForTimeout(600);
}

const PLATE = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export const defaultParams = { w: 20 };
export default function main({ w } = defaultParams) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 5 });
  return { plate: extrude1 };
}
`;

const headsOf = (page: Page, url: string) => page.evaluate(async (url) => [...(await (window as unknown as { repo: Repo }).repo.find(url)).heads()].sort().join("|"), url);
const insertDialog = (page: Page) => page.locator('.cad-editor__dialog[data-feature="insert"]');
const documentsSection = (page: Page) => page.locator(".cad-editor__documents");
const timeline = (page: Page) => page.locator(".cad-editor__timeline-wrap");
/** The middle of the 3D view, left of the dialogs. */
async function inView(page: Page): Promise<{ x: number; y: number }> {
  const box = await stage(page).boundingBox();
  if (!box) throw new Error("no 3D view");
  return { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 };
}

/** Undoes or redoes the last step, as the keyboard does in the editor. */
async function undo(page: Page, redo = false) {
  await stage(page).focus();
  await pressMod(page, redo ? "Shift+z" : "z");
}

const FEATURES_IMPORT = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";\n`;

test("a drop on the code pane, the timeline or the documents list imports at once; one undo step, once per document", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  await openCode(page);
  const docs = await sidebarDocuments(page, { "lib.js": { file: "lib.js", mimeType: "application/javascript", text: "export const k = 2;" }, Dimensions: { data: { title: "Dimensions", w: 30 } } });

  // While dragging, the pane is highlighted and the status bar says what a drop does.
  await drag(page, "lib.js", codePane(page), false);
  await expect(codePane(page)).toHaveAttribute("data-drop-target", "true");
  await expect(status(page)).toContainText("Import lib.js");
  await page.mouse.up();
  await expect(codePane(page)).not.toHaveAttribute("data-drop-target", "true");
  await expect(status(page)).not.toContainText("Import lib.js");
  // A JS file, as a namespace, pinned to its current version, after the last import; it is selected.
  const pinned = `import * as lib from "${docs["lib.js"]}#${await headsOf(page, docs["lib.js"]!)}";\n`;
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, FEATURES_IMPORT + pinned));
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["lib.js"]}`);
  await expect(dialog(page).getByRole("radio", { name: "Pinned" })).toHaveAttribute("aria-checked", "true");

  // One undo step takes it out again.
  await undo(page);
  await expect.poll(() => modelSource(page)).toBe(PLATE);

  // A data document on the timeline: following, named after its title.
  await drag(page, "Dimensions", timeline(page), false);
  await expect(timeline(page)).toHaveAttribute("data-drop-target", "true");
  await expect(status(page)).toContainText("Import Dimensions");
  await page.mouse.up();
  const dims = `import dimensions from "${docs["Dimensions"]}";\n`;
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, FEATURES_IMPORT + dims));
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["Dimensions"]}`);
  await expect(dialog(page).getByRole("radio", { name: "Following" })).toHaveAttribute("aria-checked", "true");

  // Imported already: dropped on the documents list, its row is selected, and nothing is written.
  await page.locator(".cad-editor__browser-row", { hasText: "Dimensions" }).first().locator(".cad-editor__browser-name").click();
  await expect(editorView(page)).toHaveAttribute("data-selection", "");
  await drag(page, "Dimensions", documentsSection(page));
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["Dimensions"]}`);
  expect(await modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, FEATURES_IMPORT + dims));

  // A CAD model can't be imported: the status bar says so, and nothing is written.
  const model = await page.evaluate((url) => document.querySelector(`.threepane-sidebar [data-doc-url="${url}"]`)?.textContent ?? "", docUrl(page));
  await drag(page, model.trim(), documentsSection(page));
  await expect(status(page)).toContainText("is a CAD model, and models can't be imported yet");
  expect(await modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, FEATURES_IMPORT + dims));
});

test("a drop in the view waits for Import, and several documents dropped at once", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  const docs = await sidebarDocuments(page, {
    Dimensions: { data: { title: "Dimensions", w: 30 } },
    "logo.svg": { file: "logo.svg", mimeType: "image/svg+xml", text: "<svg/>" },
    "lib.js": { file: "lib.js", mimeType: "application/javascript", text: "export const k = 2;" },
  });

  // Nothing is preselected: the dialog offers Import, and nothing is written until it is chosen.
  await drag(page, "Dimensions", await inView(page), false);
  await expect(stage(page)).toHaveAttribute("data-drop-target", "true");
  await expect(status(page)).toContainText("Insert Dimensions");
  await page.mouse.up();
  await expect(insertDialog(page)).toHaveAttribute("data-insert", docs["Dimensions"]!);
  await expect(insertDialog(page).getByRole("radio", { name: "Import" })).toHaveAttribute("aria-checked", "false");
  await expect(insertDialog(page).locator('[data-param="preview"]')).toContainText("30");
  expect(await modelSource(page)).toBe(PLATE);
  // It is no one else's selection, and closing it writes nothing.
  await insertDialog(page).getByRole("button", { name: "close" }).click();
  await expect(insertDialog(page)).toHaveCount(0);
  expect(await modelSource(page)).toBe(PLATE);

  await drag(page, "Dimensions", await inView(page));
  await insertDialog(page).getByRole("radio", { name: "Import" }).click();
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, `${FEATURES_IMPORT}import dimensions from "${docs["Dimensions"]}";\n`));
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["Dimensions"]}`);
  await undo(page);
  await expect.poll(() => modelSource(page)).toBe(PLATE);

  // Several documents onto the code pane: all imported in one step, the first selected.
  await openCode(page);
  await sidebarEntry(page, "lib.js").click({ modifiers: ["ControlOrMeta"] });
  await sidebarEntry(page, "logo.svg").click({ modifiers: ["ControlOrMeta"] });
  await drag(page, "logo.svg", codePane(page), false);
  await expect(status(page)).toContainText("Import lib.js and 1 more");
  await page.mouse.up();
  const both = `import * as lib from "${docs["lib.js"]}#${await headsOf(page, docs["lib.js"]!)}";\nimport logo from "${docs["logo.svg"]}" with { type: "text" };\n`;
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, FEATURES_IMPORT + both));
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["lib.js"]}`);
  await undo(page);
  await expect.poll(() => modelSource(page)).toBe(PLATE);

  // Into the view: the first is offered, the others are left out.
  await sidebarEntry(page, "lib.js").click({ modifiers: ["ControlOrMeta"] });
  await sidebarEntry(page, "logo.svg").click({ modifiers: ["ControlOrMeta"] });
  await drag(page, "logo.svg", await inView(page), false);
  await expect(status(page)).toContainText("Insert lib.js; the other document is left out");
  await page.mouse.up();
  await expect(insertDialog(page)).toHaveAttribute("data-insert", docs["lib.js"]!);
  await expect(status(page)).toContainText("Only lib.js is inserted; the other document is left out.");
});

/** A data document's preview opens `keys`, unless they are open, and clicks the value at their end. */
async function pick(page: Page, keys: string[], value: string) {
  const tree = insertDialog(page).locator('[data-param="preview"]');
  let at = tree;
  for (const key of keys) {
    at = at.locator("details").filter({ has: page.locator(`> summary .cad-editor__tree-key`, { hasText: new RegExp(`^${key}$`) }) }).first();
    if ((await at.getAttribute("open")) === null) await at.locator("> summary").click();
  }
  await at.locator(".cad-editor__tree-pick", { hasText: new RegExp(`^${value}$`) }).first().click();
}

const params = (page: Page) => page.locator('section[aria-label="Parameters"]');
const paramRow = (page: Page, key: string) => params(page).locator(`tr[data-param="${key}"]`);
const configurations = (page: Page) => page.evaluate(async (url) => ((await (window as unknown as { repo: Repo }).repo.find(url)).doc()["cad"] as { configurations?: { params: Record<string, unknown> }[] } | undefined)?.configurations, docUrl(page));

test("a drop on a number field picks a value: an import for an argument or a default, a link for a configuration", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  const docs = await sidebarDocuments(page, { Sizes: { data: { title: "Sizes", height: 4, rows: [{ width: 30 }, { width: 40 }], label: "x" } } });
  const sizes = docs["Sizes"]!;

  // A feature's argument: a top-level key becomes a named import and the argument its name, in one step.
  await timelineEntry(page, "extrude1").click();
  const distance = dialog(page).locator('.cad-editor__field[data-param="distance"] [data-drop="value"]');
  await drag(page, "Sizes", distance, false);
  await expect(distance).toHaveAttribute("data-drop-target", "true");
  await expect(status(page)).toContainText("Use Sizes for Distance of extrude1");
  await page.mouse.up();
  await expect(insertDialog(page)).toHaveAttribute("data-target", "argument");
  // Only numbers fit a number field, and the branches that lead to them are open.
  await expect(insertDialog(page).locator(".cad-editor__tree-pick")).toHaveText(["4", "30", "40"]);
  expect(await modelSource(page)).toBe(PLATE);
  await pick(page, [], "4");
  const argument = PLATE.replace(FEATURES_IMPORT, `${FEATURES_IMPORT}import { height } from "${sizes}";\n`).replace("distance: 5", "distance: height");
  await expect.poll(() => modelSource(page)).toBe(argument);
  await expect(editorView(page)).toHaveAttribute("data-open", "extrude1");
  await undo(page);
  await expect.poll(() => modelSource(page)).toBe(PLATE);
  await undo(page, true);
  await expect.poll(() => modelSource(page)).toBe(argument);

  // A parameter's default: a deeper value is imported by its path.
  await page.locator(".cad-editor__params-entry").click();
  const width = paramRow(page, "w").locator('[data-drop="value"]');
  await drag(page, "Sizes", width);
  await expect(insertDialog(page)).toHaveAttribute("data-target", "default");
  await pick(page, ["rows", "0"], "30");
  const defaults = argument.replace(`import { height } from "${sizes}";\n`, `import { height } from "${sizes}";\nimport width from "${sizes}/rows/@0/width";\n`).replace("defaultParams = { w: 20 }", "defaultParams = { w: width }");
  await expect.poll(() => modelSource(page)).toBe(defaults);
  await expect(params(page)).toBeVisible();

  // A configuration's value links to the picked value, as a pasted URL does.
  await params(page).getByRole("button", { name: "Save as new configuration" }).click();
  const override = paramRow(page, "w").locator('[data-drop="value"]').last();
  await drag(page, "Sizes", override, false);
  await expect(status(page)).toContainText("Link Sizes to w");
  await page.mouse.up();
  await expect(insertDialog(page)).toHaveAttribute("data-target", "override");
  await pick(page, ["rows", "1"], "40");
  await expect.poll(async () => (await configurations(page))?.[0]?.params).toEqual({ w: { link: `${sizes}/rows/@1/width` } });
  await expect(params(page).getByRole("textbox", { name: "w in Configuration" })).toHaveValue(`${sizes}/rows/@1/width`);
  expect(await modelSource(page)).toBe(defaults);

  // A drag whose URL names a number needs no pick: here dispatched, as the sidebar drags whole documents.
  await page.locator(".cad-editor__params-entry").click();
  await timelineEntry(page, "extrude1").click();
  await distance.evaluate((el, url) => {
    const data = new DataTransfer();
    data.setData("text/x-patchwork-urls", JSON.stringify([url]));
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, composed: true }));
  }, `${sizes}/rows/@1/width`);
  await expect.poll(() => modelSource(page)).toBe(defaults.replace(`import width from "${sizes}/rows/@0/width";\n`, `import width from "${sizes}/rows/@0/width";\nimport width2 from "${sizes}/rows/@1/width";\n`).replace("distance: height", "distance: width2"));
  await expect(insertDialog(page)).toHaveCount(0);
});

/** Pastes `text` with the keyboard into `into`: copied from a field outside the editor first, as a synthetic paste event carries no data in Firefox. */
async function paste(page: Page, text: string, into: Locator) {
  await page.evaluate((text) => {
    const field = document.createElement("textarea");
    field.id = "clipboard";
    field.value = text;
    document.body.append(field);
    field.focus();
    field.select();
  }, text);
  // The browser's own copy and paste, whose keys are the host's (Playwright's ControlOrMeta), not the emulated platform's (pressMod).
  await page.keyboard.press("ControlOrMeta+c");
  await page.evaluate(() => document.getElementById("clipboard")?.remove());
  await into.focus();
  await page.keyboard.press("ControlOrMeta+v");
}

test("Insert takes a pasted URL; a URL pasted into the view opens the dialog with its document", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  const docs = await sidebarDocuments(page, { Dimensions: { data: { title: "Dimensions", w: 30 } }, "notes.md": { file: "notes.md", mimeType: "text/markdown", text: "# Notes" } });

  await page.locator(".cad-editor__toolbar").getByRole("button", { name: "Insert", exact: true }).click();
  await expect(insertDialog(page)).toHaveAttribute("data-insert", "");
  await expect(insertDialog(page).getByRole("radio")).toHaveCount(0);
  // A Patchwork web link names the document too.
  const field = insertDialog(page).getByLabel("Document URL", { exact: true });
  await paste(page, `http://localhost/#doc=${docs["Dimensions"]!.slice("automerge:".length)}`, field);
  await field.press("Enter");
  await expect(insertDialog(page)).toHaveAttribute("data-insert", docs["Dimensions"]!);
  await expect(insertDialog(page).locator(".cad-editor__dialog-header")).toContainText("Dimensions");
  await insertDialog(page).getByRole("radio", { name: "Import" }).click();
  await expect.poll(() => modelSource(page)).toContain(`import dimensions from "${docs["Dimensions"]}";`);

  // Pasted into the view, which has the focus.
  await paste(page, docs["notes.md"]!, stage(page));
  await expect(insertDialog(page)).toHaveAttribute("data-insert", docs["notes.md"]!);
  await insertDialog(page).getByRole("radio", { name: "Import" }).click();
  await expect.poll(() => modelSource(page)).toContain(`import notes from "${docs["notes.md"]}" with { type: "text" };`);
});

test("drops that aren't the editor's: a comment's draft, and a named view dragged inside the editor", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  await openCode(page);
  await sidebarDocuments(page, { Dimensions: { data: { title: "Dimensions", w: 30 } } });

  // A comment thread is Patchwork's comment-thread tool: a drop on its draft is its own.
  await timelineEntry(page, "extrude1").click();
  await page.locator(".cad-editor__comment").click();
  const draft = page.getByRole("dialog", { name: "Comments on extrude1" }).locator(".comment-draft-editor .cm-content");
  await expect(draft).toBeVisible();
  await drag(page, "Dimensions", draft, false);
  await expect(status(page)).not.toContainText("Dimensions");
  await page.mouse.up();
  await expect(insertDialog(page)).toHaveCount(0);
  // The draft embeds it, as in Patchwork's Comments panel.
  await expect(page.getByRole("dialog", { name: "Comments on extrude1" }).locator(".cutetxt-embed-title")).toHaveText("Dimensions");
  await expect(editorView(page)).toHaveAttribute("data-open", "extrude1");
  expect(await modelSource(page)).toBe(PLATE);
  await page.keyboard.press("Escape");

  // A named view's grip drags the view out as an embed; inside the editor it inserts nothing, in the view or in the code.
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  await page.locator(".cad-editor__rename").press("Enter");
  const grip = page.locator(".cad-editor__named-row:not([data-fixed]) .cad-editor__grip").first();
  for (const target of [await inView(page), await centre(codePane(page))]) {
    const from = await centre(grip);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 5, { steps: 5 });
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.move(target.x + 1, target.y, { steps: 2 });
    await expect(status(page)).not.toContainText("Insert");
    await page.mouse.up();
    await expect(insertDialog(page)).toHaveCount(0);
    expect(await modelSource(page)).toBe(PLATE);
  }
});

test("a field's dialog is about a value for it alone: a problem line where none fits, deep numbers opened, a JS file's exports", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  const docs = await sidebarDocuments(page, {
    Words: { data: { title: "Words", a: "x", b: { c: "y" } } },
    Deep: { data: { title: "Deep", a: { b: [{ c: "x" }, { c: 7 }] } } },
    "lib.js": { file: "lib.js", mimeType: "application/javascript", text: 'export const k = 2;\nexport const name = "x";\nexport function f() {}\nexport const sizes = { w: 3 * k };' },
    // Data, though it has a `content` key as files do.
    Note: { data: { title: "Note", content: "Hello", w: 5 } },
  });
  await timelineEntry(page, "extrude1").click();
  const distance = dialog(page).locator('.cad-editor__field[data-param="distance"] [data-drop="value"]');
  const problem = insertDialog(page).locator('.cad-editor__problem[data-status="unpickable"]');
  /** Opens extrude1's dialog, unless a pick left it open: a click on the selected entry would close it. */
  const openExtrude = async () => {
    if ((await distance.count()) === 0) await timelineEntry(page, "extrude1").click();
    await expect(distance).toBeVisible();
  };

  // Only strings: no number to use, and no Use as, whose Import would leave the field.
  await drag(page, "Words", distance);
  await expect(problem).toHaveText("Words has no number to use for Distance of extrude1.");
  await expect(insertDialog(page).getByRole("radio")).toHaveCount(0);
  await expect(insertDialog(page).locator(".cad-editor__tree-pick")).toHaveCount(0);

  // A JS file runs: its numbers are its exports, a new import of one names it, pinned as code is, and a second joins it.
  await timelineEntry(page, "extrude1").click();
  await drag(page, "lib.js", distance);
  await expect(insertDialog(page).locator(".cad-editor__tree-pick")).toHaveText(["2", "6"]);
  await expect(problem).toHaveCount(0);
  await insertDialog(page).locator(".cad-editor__tree-pick", { hasText: /^2$/ }).click();
  const pinned = new RegExp(`import \\{ k \\} from "${docs["lib.js"]}#[^"]+";\n`);
  await expect.poll(() => modelSource(page)).toMatch(pinned);
  expect(await modelSource(page)).toContain("distance: k");
  await openExtrude();
  await drag(page, "lib.js", distance);
  await insertDialog(page).locator(".cad-editor__tree-pick", { hasText: /^6$/ }).click();
  await expect.poll(() => modelSource(page)).toContain("distance: sizes.w");
  expect(await modelSource(page)).toMatch(new RegExp(`import \\{ k, sizes \\} from "${docs["lib.js"]}#[^"]+";\n`));
  await setModelSource(page, PLATE);

  // A data document with a `content` key is data, not a file.
  await openExtrude();
  await drag(page, "Note", distance);
  await insertDialog(page).locator(".cad-editor__tree-pick", { hasText: /^5$/ }).click();
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, `${FEATURES_IMPORT}import { w as w2 } from "${docs["Note"]}";\n`).replace("distance: 5", "distance: w2"));

  // A number deep in the tree: its branches are open, and it is picked.
  await setModelSource(page, PLATE);
  await openExtrude();
  await drag(page, "Deep", distance);
  await expect(problem).toHaveCount(0);
  await insertDialog(page).locator(".cad-editor__tree-pick", { hasText: /^7$/ }).click();
  await expect.poll(() => modelSource(page)).toBe(PLATE.replace(FEATURES_IMPORT, `${FEATURES_IMPORT}import c from "${docs["Deep"]}/a/b/@1/c";\n`).replace("distance: 5", "distance: c"));
});

test("a document row drags its document: onto a field it reuses the import, into the view it waits, into Patchwork it is a document", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page, PLATE);
  // Imported, but not in the sidebar: the row is where it is dragged from.
  const sizes = await page.evaluate(() => (window as unknown as { repo: Repo }).repo.create({ title: "Sizes", height: 4 }).url);
  const imported = PLATE.replace(FEATURES_IMPORT, `${FEATURES_IMPORT}import sizes from "${sizes}";\n`);
  await setModelSource(page, imported);
  const grip = page.locator('.cad-editor__document-row[data-name="Sizes"] .cad-editor__grip');
  await expect(grip).toBeVisible();

  // Onto a feature's number field: the pick reads the import there is, and adds none.
  await timelineEntry(page, "extrude1").click();
  await drag(page, grip, dialog(page).locator('.cad-editor__field[data-param="distance"] [data-drop="value"]'), false);
  await expect(status(page)).toContainText("Use Sizes for Distance of extrude1");
  await page.mouse.up();
  await insertDialog(page).locator(".cad-editor__tree-pick", { hasText: /^4$/ }).click();
  await expect.poll(() => modelSource(page)).toBe(imported.replace("distance: 5", "distance: sizes.height"));

  // Into the view: it waits, as it may be an annotation; Import, imported already, selects its row.
  await drag(page, grip, await inView(page), false);
  await expect(status(page)).toContainText("Insert Sizes");
  await page.mouse.up();
  await insertDialog(page).getByRole("radio", { name: "Import" }).click();
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${sizes}`);
  await expect(insertDialog(page)).toHaveCount(0);
  expect(await modelSource(page)).toBe(imported.replace("distance: 5", "distance: sizes.height"));

  // Into the sidebar's list: an ordinary Patchwork document, listed under the title its datatype gives it (none here, so "Untitled").
  const list = await page.locator(".threepane-sidebar .document-list__doclist").first().boundingBox();
  if (!list) throw new Error("no document list in the sidebar");
  await drag(page, grip, { x: list.x + list.width / 2, y: list.y + list.height - 4 });
  await expect(page.locator(`.threepane-sidebar [data-dnd-item][data-doc-url="${sizes}"]`)).toHaveCount(1);
});
