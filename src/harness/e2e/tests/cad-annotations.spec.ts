/**
 * Annotations (research/21-embedding.md, "Annotation"): documents dragged from Patchwork's sidebar
 * onto a face, pinned there at once or, for an image, after choosing Annotation; their pins opening
 * the document in Patchwork's embed frame, which keeps its tool; the dialog moving one to a face, a
 * feature or the model; one whose feature is gone; removing one; and the viewer tool showing them.
 */
import type { Locator, Page } from "@playwright/test";
import { CAD_MODULES, cameraDirection, clickEntity, clickHome, clickViewCube, createModel, dialog, docUrl, editorView, entities, openWithTool, setModelSource, timelineEntry, type Entity } from "../cad.ts";
import { drag, sidebarDocuments, type Repo } from "../documents.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const PLATE = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 5 });
  return { plate: extrude1 };
}
`;

async function open(page: Page) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // The document sidebar stays, where documents are dragged from.
  await page.getByRole("button", { name: "Hide context sidebar", exact: true }).click();
  await setModelSource(page, PLATE, "replace");
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => entities(page, "face").then((f) => f.length), { timeout: 60_000 }).toBeGreaterThan(0);
  // Changes within 500 ms of each other are one undo step (research/16).
  await page.waitForTimeout(600);
}

const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
const screenPoint = (page: Page, face: Entity) => viewer(page).evaluate((el, e) => (el as unknown as { cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined } }).cadViewer.screenPoint(e), face);

/** A face whose reference starts with `name`, that a click reaches, and where it is on the screen; clicking it leaves it selected. */
async function faceNamed(page: Page, name: string): Promise<{ face: Entity; at: { x: number; y: number } }> {
  for (const face of await entities(page, "face")) {
    const at = await screenPoint(page, face);
    if (!at) continue;
    // Selected, so that the name read is this face's: WebKit drops the first click after a drag and drop.
    await expect(async () => {
      await clickEntity(page, face);
      await expect(viewer(page)).toHaveAttribute("data-selected", `${face.body}:face:${face.index}`, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    const reference = page.locator(".cad-model__reference code");
    await expect(reference).toHaveCount(1);
    if (((await reference.textContent()) ?? "").startsWith(name)) return { face, at };
  }
  throw new Error(`no visible face named ${name}…`);
}

type StoredAnnotation = { id: string; doc: string; tool?: string; view?: string; anchor?: { feature?: string; entityName?: string; entity?: unknown } };
const annotationsOf = (page: Page) =>
  page.evaluate(async (url) => {
    const doc = (await (window as unknown as { repo: Repo }).repo.find(url)).doc() as { cad?: { annotations?: StoredAnnotation[] } };
    return JSON.parse(JSON.stringify(doc.cad?.annotations ?? [])) as StoredAnnotation[];
  }, docUrl(page));

const status = (page: Page) => page.locator(".cad-model__status").first();
/** The pins on faces and edges, the model's at the bottom left, and the open one's popover. */
const pins = (page: Page) => page.locator(".cad-model__pin:not(.cad-model__pin--model):not([data-new])");
/** The pin to comment on the selected face or edge, which has none. */
const newPin = (page: Page) => page.locator('.cad-model__pin[data-new="true"]');
const highlighted = (page: Page, style: "accent" | "hover") => viewer(page).evaluate((el, s) => (el as unknown as { cadViewer: { highlighted(style: string): unknown[] } }).cadViewer.highlighted(s).length, style);
const modelPin = (page: Page) => page.locator(".cad-model__pin--model");
/** An open pin: the editor's dialog, or elsewhere a popover. */
const popover = (page: Page) => page.locator(".cad-editor__pin-dialog, .cad-model__comments-popover");

test("a document dropped on a face is pinned there at once; its pin opens it in the embed frame, which keeps its tool", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" } });
  const { at } = await faceNamed(page, "extrude1.end");

  // While dragging, the status bar says what a drop on the face does.
  await drag(page, "notes.txt", at, false);
  await expect(status(page)).toContainText("Pin notes.txt to the face");
  await page.mouse.up();

  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(1);
  const [stored] = await annotationsOf(page);
  expect(stored?.doc).toBe(docs["notes.txt"]);
  expect(stored?.anchor?.feature).toBe("extrude1");
  expect(stored?.anchor?.entityName).toMatch(/^extrude1\.end/);
  // Its row is selected, which opens the document dialog with where it is pinned.
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:annotation:${stored!.id}`);
  await expect(dialog(page)).toHaveAttribute("data-role", "annotation");
  await expect(dialog(page).getByLabel("On", { exact: true })).toHaveValue("#entity");
  await expect(page.locator('.cad-editor__document-row[data-role="annotation"]')).toContainText("notes");

  // A pin with the file's icon, titled as the file datatype titles it; it opens the document in Patchwork's embed frame.
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page)).toHaveAttribute("aria-label", "notes");
  await expect(pins(page)).toHaveAttribute("data-annotations", "1");
  await pins(page).click();
  await expect(popover(page).locator('patchwork-view[tool-id="embed"]')).toHaveAttribute("doc-url", docs["notes.txt"]!);
  await expect(popover(page).locator(".embed-frame")).toBeVisible({ timeout: 30_000 });
  // The document's own view has room, below the frame's header.
  await expect.poll(() => popover(page).locator(".embed-frame .content").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(100);
  // A tool picked in the frame is kept, and the frame mounts with it next time.
  await popover(page).locator('patchwork-view[tool-id="embed"]').evaluate((el) => el.dispatchEvent(new CustomEvent("patchwork:embed-tool-changed", { detail: { url: el.getAttribute("doc-url"), toolId: "file" }, bubbles: true, composed: true })));
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.tool)).toBe("file");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await pins(page).click();
  await expect(popover(page).locator('patchwork-view[tool-id="embed"]')).toHaveAttribute("embed-tool-id", "file");
  await page.keyboard.press("Escape");

  // Dropped on the same face again, it is selected, not pinned twice.
  await page.waitForTimeout(600);
  await drag(page, "notes.txt", (await screenPoint(page, (await faceNamed(page, "extrude1.end")).face))!);
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:annotation:${stored!.id}`);
  expect(await annotationsOf(page)).toHaveLength(1);

  // Undo takes back the picked tool, then the annotation, each one step.
  await page.locator(".cad-editor__stage").focus();
  await pressMod(page, "z");
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.tool)).toBeUndefined();
  expect(await annotationsOf(page)).toHaveLength(1);
  await pressMod(page, "z");
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(0);
  await expect(pins(page)).toHaveCount(0);
});

test("an image dropped on a face waits for its role; the dialog moves its annotation to a feature and the model; a renamed feature detaches it", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "logo.png": { file: "logo.png", mimeType: "image/png", text: "not really a PNG" } });
  const { at } = await faceNamed(page, "extrude1.end");

  // An image is to be a decal, so nothing is preselected: it waits, with the face it was dropped on.
  await drag(page, "logo.png", at, false);
  await expect(status(page)).toContainText("Insert logo.png to the face");
  await page.mouse.up();
  const insert = page.locator('.cad-editor__dialog[data-feature="insert"]');
  await expect(insert.locator('[data-param="anchor"]')).toContainText(/extrude1\.end/);
  expect(await annotationsOf(page)).toHaveLength(0);
  await insert.getByRole("radio", { name: "Annotation" }).click();
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.anchor?.entityName)).toMatch(/^extrude1\.end/);
  await expect(pins(page)).toHaveAttribute("aria-label", "logo");

  // On a feature: its pin is on what the feature made.
  const on = dialog(page).getByLabel("On", { exact: true });
  await on.selectOption("extrude1");
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.anchor)).toEqual({ feature: "extrude1", statement: expect.stringContaining("extrude1 = extrude(") as unknown as string });
  await expect(pins(page)).toHaveAttribute("aria-label", "logo");

  // On the model: on the model's pin at the bottom left of the view.
  await on.selectOption("");
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.anchor)).toBeUndefined();
  await expect(pins(page)).toHaveCount(0);
  const listed = modelPin(page);
  await expect(listed).toHaveAttribute("aria-label", "On the model: logo");
  await listed.click();
  const onModel = page.getByRole("dialog", { name: "Annotations on the model" });
  await expect(onModel.locator('patchwork-view[tool-id="embed"]')).toHaveCount(1);
  // The pin's dialog replaced the annotation's; Edit annotation brings it back.
  await expect(on).toHaveCount(0);
  await onModel.getByRole("button", { name: "Edit annotation" }).click();

  // Back on the feature, which a rename of its variable removes: on the model's pin, as not found.
  await on.selectOption("extrude1");
  await expect(pins(page)).toHaveCount(1);
  await setModelSource(page, PLATE.replaceAll("extrude1", "slab"), "replace");
  await expect(pins(page)).toHaveCount(0);
  await expect(listed).toHaveAttribute("data-detached", "true");
  await listed.click();
  await expect(popover(page).locator(".cad-model__comment-caption")).toHaveText("Feature extrude1 deleted");
});

test("Select face pins an annotation to the picked face; Remove deletes it; the viewer tool shows its pin", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" } });
  const end = await faceNamed(page, "extrude1.end");
  await drag(page, "notes.txt", end.at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(1);

  // Another face, picked in the view while the dialog is open.
  const others = [];
  for (const face of await entities(page, "face")) if (face.index !== end.face.index && (await screenPoint(page, face))) others.push(face);
  await dialog(page).getByRole("button", { name: "Select face" }).click();
  await clickEntity(page, others[0]!);
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.anchor?.entityName)).not.toMatch(/^extrude1\.end/);
  await expect(dialog(page).getByRole("button", { name: "Select face" })).toHaveAttribute("aria-pressed", "false");
  await expect(pins(page)).toHaveCount(1);

  // The viewer tool shows the pin, and opens the document.
  await openWithTool(page, "cad-model-viewer");
  await expect(pins(page)).toHaveCount(1, { timeout: 60_000 });
  await pins(page).click();
  await expect(popover(page).locator('patchwork-view[tool-id="embed"]')).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Back in the editor, the row's context menu removes it.
  await openWithTool(page, "cad-model");
  const row = page.locator('.cad-editor__document-row[data-role="annotation"]');
  await row.locator(".cad-editor__browser-name").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(0);
  await expect(row).toHaveCount(0);
  await expect(pins(page)).toHaveCount(0);
});

test("a view chosen for an annotation is shown, and opening the annotation goes there", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" } });
  await clickViewCube(page, [0, 0, 1]);
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  const rename = page.locator(".cad-editor__browser .cad-editor__rename");
  await rename.fill("Above");
  await rename.press("Enter");
  await clickHome(page);
  await drag(page, "notes.txt", (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(1);
  const direction = async () => (await cameraDirection(page)).map((x) => Math.round(x * 100) / 100 + 0); // + 0: -0 is 0

  await dialog(page).getByLabel("View", { exact: true }).selectOption({ label: "Above" });
  await expect.poll(() => annotationsOf(page).then((l) => l[0]?.view)).toBeDefined();
  await expect.poll(direction).toEqual([0, 0, 1]);
  await clickHome(page);
  expect(await direction()).not.toEqual([0, 0, 1]);
  await pins(page).click();
  await expect.poll(direction).toEqual([0, 0, 1]);
  await expect(page.locator(".cad-editor__pin-dialog")).toHaveCount(1);

  // In the viewer tool, a popover: opened before the camera moved there, it follows its pin; and as the camera orbits.
  await openWithTool(page, "cad-model-viewer");
  await expect(pins(page)).toHaveCount(1, { timeout: 60_000 });
  await clickHome(page);
  await pins(page).click();
  await expect.poll(direction).toEqual([0, 0, 1]);
  await expect.poll(() => offset(page)).toEqual({ x: 0, y: 0 });
  const box = (await viewer(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8, { steps: 10 });
  await page.mouse.up();
  await expect(popover(page)).toHaveCount(1);
  await expect.poll(() => offset(page)).toEqual({ x: 0, y: 0 });
});

/**
 * How far the viewer tool's open popover is from below its pin's left edge, or from above it where
 * there is more room, in whole pixels: 4px is its margin, the pin is 22px above the point it hangs
 * from, and it is kept within the view, 360px wide.
 */
async function offset(page: Page): Promise<{ x: number; y: number }> {
  const pin = (await pins(page).boundingBox())!;
  const open = (await popover(page).boundingBox())!;
  const view = (await page.locator(".cad-model--viewer").boundingBox())!;
  const left = view.x + Math.max(0, Math.min(pin.x - view.x, view.width - 360));
  const pinBottom = pin.y + pin.height;
  const y = open.y > pin.y ? open.y - 4 - pinBottom : pinBottom - 22 - 4 - (open.y + open.height);
  return { x: Math.round(open.x - left) + 0, y: Math.round(y) + 0 };
}

test("a document the model imports, dropped in the view, can be an annotation; a CAD model is one in the viewer, and this model none", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await sidebarDocuments(page, {
    "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" },
    Bracket: { data: { "@patchwork": { type: "cad-model" }, title: "Bracket", content: PLATE, mimeType: "application/javascript", cad: {} } },
  });
  await setModelSource(page, PLATE.replace("\n", `\nimport notes from "${docs["notes.txt"]}" with { type: "text" };\n`), "replace");
  await expect(page.locator('.cad-editor__document-row[data-role="import"]')).toHaveCount(1);

  // Imported already, it waits in the view all the same, and becomes an annotation on the model.
  const view = await viewer(page).boundingBox();
  await drag(page, "notes.txt", { x: view!.x + 20, y: view!.y + view!.height - 20 });
  const insert = page.locator('.cad-editor__dialog[data-feature="insert"]');
  await expect(insert.getByRole("radio")).toHaveText(["Import", "Annotation"]);
  await insert.getByRole("radio", { name: "Annotation" }).click();
  await expect.poll(() => annotationsOf(page)).toEqual([{ id: expect.any(String) as unknown as string, doc: docs["notes.txt"]! }]);

  // Another model, on a face: shown in the viewer tool.
  await drag(page, "Bracket", (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l[1]?.tool)).toBe("cad-model-viewer");
  await pins(page).click();
  await expect(popover(page).locator('patchwork-view[tool-id="embed"]')).toHaveAttribute("embed-tool-id", "cad-model-viewer");
  // Its 3D view fills the frame: the editor's grid areas don't reach into the viewer nested in it.
  const filled = () => popover(page).locator(".cad-model__viewer").evaluate((el) => Math.round((el.getBoundingClientRect().width / el.closest(".content")!.getBoundingClientRect().width) * 100) / 100);
  await expect.poll(filled, { timeout: 60_000 }).toBe(1);
  await page.keyboard.press("Escape");

  // This model itself: refused, with why in the status bar.
  const own = await page.evaluate((url) => document.querySelector(`.threepane-sidebar [data-doc-url="${url}"]`)?.textContent ?? "", docUrl(page));
  await drag(page, own.trim(), (await faceNamed(page, "extrude1.end")).at);
  await expect(status(page)).toContainText("A model can't annotate itself.");
  expect(await annotationsOf(page)).toHaveLength(2);
});

/** Writes and saves the draft in an open thread popover. */
async function writeComment(popover: Locator, text: string) {
  const draft = popover.locator(".comment-draft-editor .cm-content").last();
  await draft.click();
  await draft.pressSequentially(text);
  await popover.getByRole("button", { name: "Save" }).click();
}

test("what is on one face is one pin: its icons, how many, its threads then its annotations; on the model when the face is gone", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" }, "todo.txt": { file: "todo.txt", mimeType: "text/plain", text: "Deburr" } });
  await clickViewCube(page, [0, 0, 1]);
  await page.getByRole("button", { name: "New view from the current camera" }).click();
  const rename = page.locator(".cad-editor__browser .cad-editor__rename");
  await rename.fill("Above");
  await rename.press("Enter");
  await clickHome(page);
  const direction = async () => (await cameraDirection(page)).map((x) => Math.round(x * 100) / 100 + 0); // + 0: -0 is 0

  // A comment on the face, then two text files dropped on it, the second with a view.
  // The selected face has no pin: a new one, only the comment icon, starts a thread there.
  await faceNamed(page, "extrude1.end");
  await expect(newPin(page).locator("svg")).toHaveAttribute("data-icon", "MessageSquare");
  await expect(newPin(page)).toHaveText("");
  await newPin(page).click();
  await writeComment(page.getByRole("dialog", { name: /^Comments on extrude1\.end/ }), "Polish this");
  await page.keyboard.press("Escape");
  await drag(page, "notes.txt", (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(1);
  await drag(page, "todo.txt", (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(2);
  await dialog(page).getByLabel("View", { exact: true }).selectOption({ label: "Above" });
  await expect.poll(direction).toEqual([0, 0, 1]);
  await clickHome(page);

  // One pin: the comment's icon and the files', counted, as two are of one kind.
  await expect(pins(page)).toHaveCount(1);
  const pin = pins(page);
  await expect(pin).toHaveAttribute("data-threads", "1");
  await expect(pin).toHaveAttribute("data-annotations", "2");
  expect(await pin.locator("svg").evaluateAll((icons) => icons.map((i) => i.getAttribute("data-icon")))).toEqual(["MessageSquare", "FileText"]);
  await expect(pin).toHaveText("3");
  await expect(pin).toHaveAttribute("aria-label", "1 comment, notes, todo");
  // The selected face's pin is marked, and no new one is offered.
  await expect(pin).toHaveAttribute("data-selected", "true");
  await expect(newPin(page)).toHaveCount(0);
  const box = (await viewer(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await expect(pin).toHaveAttribute("data-selected", "false");

  // Hovered, its face is.
  await pin.hover();
  await expect.poll(() => highlighted(page, "hover")).toBeGreaterThan(0);

  // Opened, it is the selection, a dialog within the view: the thread, then both documents, each an item of its own, and New comment below them;
  // its face is highlighted, and the feature that made it, as if the face were hovered.
  const home = await direction();
  await pin.click();
  await expect(editorView(page)).toHaveAttribute("data-selection", /^pin:/);
  const list = page.getByRole("dialog", { name: "Comments and annotations on extrude1.end" });
  await expect(list.locator(".comment-content")).toHaveText("Polish this");
  await expect(list.locator('patchwork-view[tool-id="embed"]')).toHaveCount(2);
  expect(await list.locator(".cad-model__pin-item").evaluateAll((items) => items.map((i) => (i.hasAttribute("data-annotation") ? "annotation" : "thread")))).toEqual(["thread", "annotation", "annotation"]);
  await expect(list.locator(".cad-model__pin-item").first().getByRole("button", { name: "Resolve" })).toHaveCount(1);
  await expect(list.locator(".cad-model__pin-item").nth(1).getByRole("button", { name: "Edit annotation" })).toHaveCount(1);
  await expect(list.locator("footer").getByRole("button", { name: "New comment" })).toHaveCount(1);
  await expect(list.locator(".cad-model__pin-list footer")).toHaveCount(0);
  const [dialogBox, stageBox] = [(await list.boundingBox())!, (await page.locator(".cad-editor__stage").boundingBox())!];
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height);
  await expect.poll(() => highlighted(page, "accent")).toBeGreaterThan(0);
  await expect(timelineEntry(page, "extrude1")).toHaveAttribute("data-cross-hover", "true");
  await expect(pin).toHaveAttribute("data-focused", "true");
  // An annotation hovered there marks its row in the documents list.
  await list.locator('.cad-model__pin-item[data-annotation]').first().hover();
  await expect(page.locator('.cad-editor__document-row[data-role="annotation"][data-hovered="true"]')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await direction()).toEqual(home);
  await list.getByRole("button", { name: "Go to view" }).click();
  await expect.poll(direction).toEqual([0, 0, 1]);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(timelineEntry(page, "extrude1")).not.toHaveAttribute("data-cross-hover", "true");

  // The face gone, all of it is on the model's pin, marked so, with what each was on.
  await setModelSource(page, PLATE.replaceAll("extrude1", "slab"), "replace");
  await expect(pins(page)).toHaveCount(0);
  const model = modelPin(page);
  await expect(model).toHaveAttribute("data-threads", "1");
  await expect(model).toHaveAttribute("data-annotations", "2");
  await expect(model).toHaveAttribute("data-detached", "true");
  await model.click();
  const detached = page.getByRole("dialog", { name: "Comments and annotations on the model" });
  await expect(detached.locator(".cad-model__comment-caption")).toHaveText([/^Face not found: extrude1\.end/, /^Face not found: extrude1\.end/, /^Face not found: extrude1\.end/]);
  // The dialog ends above the model's pin, which covers none of it, and its list always has a scrollbar beside the embeds, which may scroll themselves.
  const [dialogBottom, pinTop] = [await detached.evaluate((el) => el.getBoundingClientRect().bottom), await model.evaluate((el) => el.getBoundingClientRect().top)];
  expect(dialogBottom).toBeLessThan(pinTop);
  await expect(detached.locator(".cad-model__scrollbar")).toBeVisible();
});

test("a tool picked in one annotation's frame changes that frame alone, every time; a face with only annotations offers New comment", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" }, "todo.txt": { file: "todo.txt", mimeType: "text/plain", text: "Deburr" } });
  await drag(page, "notes.txt", (await faceNamed(page, "extrude1.end")).at);
  await drag(page, "todo.txt", (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(2);
  const box = (await viewer(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await pins(page).click();
  const list = page.getByRole("dialog", { name: "Annotations on extrude1.end" });
  const frames = list.locator(".embed-frame");
  await expect(frames).toHaveCount(2, { timeout: 30_000 });
  /** Marks the frames, and says for each whether it was marked before, i.e. not mounted anew, and its tool. */
  const frameState = () =>
    frames.evaluateAll((all) =>
      all.map((f) => {
        const kept = (f as { mark?: true }).mark === true;
        (f as { mark?: true }).mark = true;
        return `${kept ? "kept" : "new"} ${f.querySelector(".tool-btn")?.textContent}`;
      }),
    );
  expect(await frameState()).toEqual(["new File", "new File"]);
  for (const tool of ["Raw", "File", "Raw"]) {
    await frames.first().locator(".tool-btn").click();
    await page.locator(".tool-menu .item", { hasText: new RegExp(`^${tool}$`) }).click();
    await expect.poll(() => annotationsOf(page).then((l) => l[0]?.tool)).toBe(tool.toLowerCase());
    expect(await frameState()).toEqual([`kept ${tool}`, "kept File"]);
  }

  // Without a thread there, New comment starts one on the face.
  await list.locator("footer").getByRole("button", { name: "New comment" }).click();
  await writeComment(page.getByRole("dialog", { name: /^Comments and annotations on extrude1\.end/ }), "And a comment");
  await expect(pins(page)).toHaveAttribute("data-threads", "1");
});

test("a long pin dialog has a scrollbar of its own, always shown, whose track scrolls it; it covers the pins under it", async ({ users }, info) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  await sidebarDocuments(page, { "notes.txt": { file: "notes.txt", mimeType: "text/plain", text: "Anodize black" }, "todo.txt": { file: "todo.txt", mimeType: "text/plain", text: "Deburr" }, "more.txt": { file: "more.txt", mimeType: "text/plain", text: "More" } });
  for (const name of ["notes.txt", "todo.txt", "more.txt"]) await drag(page, name, (await faceNamed(page, "extrude1.end")).at);
  await expect.poll(() => annotationsOf(page).then((l) => l.length)).toBe(3);
  const box = (await viewer(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  const pin = pins(page);
  await pin.click();
  const list = page.getByRole("dialog", { name: "Annotations on extrude1.end" });
  await expect(list.locator(".embed-frame")).toHaveCount(3, { timeout: 30_000 });

  // The scrollbar is there without hovering it, beside the embeds, with a thumb as long as the part shown.
  await page.mouse.move(box.x + box.width - 10, box.y + 10);
  const track = list.locator(".cad-model__scrollbar");
  const area = list.locator(".cad-model__scrolled-area");
  const trackBox = (await track.boundingBox())!;
  const areaBox = (await area.boundingBox())!;
  expect(trackBox.width).toBeGreaterThanOrEqual(12);
  expect(trackBox.x).toBeGreaterThanOrEqual(areaBox.x + areaBox.width);
  const thumb = (await list.locator(".cad-model__scrollbar-thumb").boundingBox())!;
  expect(thumb.height).toBeGreaterThan(0);
  expect(thumb.height).toBeLessThan(trackBox.height);
  if (shots) await page.screenshot({ path: `${shots}/annotations-scrollbar-${info.project.name}.png` });
  // The wheel over the track scrolls the list, and the thumb follows.
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await list.locator(".cad-model__scrollbar-thumb").boundingBox())!.y).toBeGreaterThan(thumb.y);

  // The pin it was opened at, under the dialog, is covered by it.
  const at = (await pin.boundingBox())!;
  const dialogBox = (await list.boundingBox())!;
  const centre = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  const under = centre.x > dialogBox.x && centre.x < dialogBox.x + dialogBox.width && centre.y > dialogBox.y && centre.y < dialogBox.y + dialogBox.height;
  expect(under).toBe(true);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".cad-editor__pin-dialog"), centre)).toBe(true);
});
