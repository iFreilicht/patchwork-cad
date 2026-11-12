/**
 * The documents a model refers to (research/21-embedding.md): the documents list in the browser
 * with each one's state, cross-highlighting with the features that use it, the document dialog
 * (As, Name, Version), titles in the code pane, and the locks of followed documents, which hold back
 * a version that breaks the model, are never undo steps, are written by the editor only, and only
 * forward.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, cadView, createModel, dialog, docPathWith, docUrl, editorView, modelSource, openCode, openWithTool, setModelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, editor, pressMod } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

type Handle = { url: string; heads(): string[]; doc(): Record<string, unknown>; change(fn: (d: Record<string, unknown>) => void): void };
type Repo = { find(u: string): Promise<Handle>; create(d: unknown): Handle };

/** The largest x of the shown faces' centroids: the width of a plate from x = 0. */
async function extentX(page: Page): Promise<number> {
  return page
    .locator(".cad-model__viewer")
    .first()
    .evaluate((el) => {
      const hook = (el as unknown as { cadViewer: { entities(k: "face"): unknown[]; centroid(e: unknown): number[] | undefined } }).cadViewer;
      return Math.max(...hook.entities("face").map((e) => hook.centroid(e)?.[0] ?? -Infinity));
    });
}

/** Creates documents in the tab's repo: data documents as given, files with their text as UTF-8 bytes, as the sidebar uploads them. */
async function create(page: Page, docs: Record<string, { data: Record<string, unknown> } | { file: string; mimeType: string; text: string }>): Promise<Record<string, string>> {
  return page.evaluate((docs) => {
    const repo = (window as unknown as { repo: Repo }).repo;
    return Object.fromEntries(
      Object.entries(docs).map(([key, d]) => {
        if ("data" in d) return [key, repo.create(d.data).url];
        const [name, extension] = d.file.split(".");
        return [key, repo.create({ "@patchwork": { type: "file" }, name, extension, mimeType: d.mimeType, content: new TextEncoder().encode(d.text) }).url];
      }),
    );
  }, docs);
}

/** Replaces a file's content, as UTF-8 bytes, or changes a data document. */
async function change(page: Page, url: string, update: { text: string } | Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ([url, update]) => {
      const handle = await (window as unknown as { repo: Repo }).repo.find(url as string);
      const u = update as Record<string, unknown>;
      handle.change((d) => {
        if (typeof u["text"] === "string") d["content"] = new TextEncoder().encode(u["text"]);
        else Object.assign(d, u);
      });
    },
    [url, update] as const,
  );
}

const headsOf = (page: Page, url: string) => page.evaluate(async (url) => [...(await (window as unknown as { repo: Repo }).repo.find(url)).heads()].sort(), url);
/** The model's locks, as the tab's repo has them. */
const locks = (page: Page) => page.evaluate(async (url) => ((await (window as unknown as { repo: Repo }).repo.find(url)).doc()["cad"] as { locks?: Record<string, string[]> } | undefined)?.locks, docUrl(page));

const modelHeads = (page: Page) => page.evaluate(async (url) => [...(await (window as unknown as { repo: Repo }).repo.find(url)).heads()].sort(), docUrl(page));
const row = (page: Page, name: string) => page.locator(`.cad-editor__document-row[data-name="${name}"]`);
const status = (page: Page) => page.locator(".cad-model__status").first();

async function open(page: Page) {
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
}

const plate = (imports: string, width: string, height = "10") =>
  `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";\n${imports}\nexport default function main() {\n  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [${width}, 10] }) });\n  const extrude1 = extrude({ sketch: sketch1, distance: ${height} });\n  return { plate: extrude1 };\n}\n`;

test("the documents list: titles, states, cross-highlighting, and the dialog's As, Name and Version", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const docs = await create(page, {
    data: { data: { title: "Dimensions", w: 20 } },
    json: { file: "dims.json", mimeType: "application/json", text: '{ "h": 3 }' },
    svg: { file: "logo.svg", mimeType: "image/svg+xml", text: "<svg/>" },
  });
  const pinned = `${docs["json"]}#${(await headsOf(page, docs["json"]!)).join("|")}`;
  await setModelSource(page, plate(`import dims from "${docs["data"]}";\nimport { h } from "${pinned}";\nimport logo from "${docs["svg"]}" with { type: "text" };`, "dims.w", "h"), "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(20);

  // A row per document, by its title, with its state.
  await expect(page.locator(".cad-editor__document-row")).toHaveCount(3);
  await expect(row(page, "Dimensions")).toHaveAttribute("data-state", "following");
  await expect(row(page, "dims")).toHaveAttribute("data-state", "pinned");
  await expect(row(page, "logo")).toHaveAttribute("data-state", "following");

  // Hovering a row highlights the features that use it; hovering a feature, the rows of what it uses.
  await row(page, "Dimensions").hover();
  await expect(timelineEntry(page, "sketch1")).toHaveAttribute("data-cross-hover", "true");
  await expect(timelineEntry(page, "extrude1")).not.toHaveAttribute("data-cross-hover", "true");
  await timelineEntry(page, "extrude1").hover();
  await expect(row(page, "dims")).toHaveAttribute("data-hovered", "true");
  await expect(row(page, "Dimensions")).not.toHaveAttribute("data-hovered", "true");

  // A pinned document that changed has a newer version; Update pins that one.
  await change(page, docs["json"]!, { text: '{ "h": 4 }' });
  await expect(row(page, "dims")).toHaveAttribute("data-state", "newer");
  await row(page, "dims").getByRole("button").first().click();
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["json"]}`);
  await dialog(page).getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(async () => (await modelSource(page)).includes(`${docs["json"]}#${(await headsOf(page, docs["json"]!)).join("|")}`)).toBe(true);
  await expect(row(page, "dims")).toHaveAttribute("data-state", "pinned");
  // Following: the specifier loses its heads, and the row stays selected.
  await dialog(page).getByRole("radio", { name: "Following" }).click();
  await expect.poll(async () => (await modelSource(page)).includes(`import { h } from "${docs["json"]}";`)).toBe(true);
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["json"]}`);
  await expect(dialog(page).locator('[data-param="name"] code')).toHaveText(["h"]);

  // Name renames the import and its uses; Pinned pins the version the model is built with.
  await row(page, "Dimensions").getByRole("button").first().click();
  await expect(dialog(page)).toHaveAttribute("data-document", docs["data"]!);
  await expect(dialog(page).locator('[data-param="preview"]')).toContainText("{2}");
  const name = dialog(page).getByLabel("Name", { exact: true });
  await name.fill("size");
  await name.press("Enter");
  await expect.poll(async () => (await modelSource(page)).includes(`import size from "${docs["data"]}";`) && (await modelSource(page)).includes("to: [size.w, 10]")).toBe(true);
  await dialog(page).getByRole("radio", { name: "Pinned" }).click();
  await expect.poll(async () => (await modelSource(page)).includes(`${docs["data"]}#${(await headsOf(page, docs["data"]!)).join("|")}`)).toBe(true);
  await expect(row(page, "Dimensions")).toHaveAttribute("data-state", "pinned");

  // As rewrites the attribute only, and the document stays selected; its preview follows.
  await row(page, "logo").getByRole("button").first().click();
  await expect(dialog(page).getByRole("radio")).toHaveText(["Text", "Bytes", "Following", "Pinned"]);
  await expect(dialog(page).locator('[data-param="preview"]')).toContainText("<svg/>");
  await dialog(page).getByRole("radio", { name: "Bytes" }).click();
  await expect.poll(async () => (await modelSource(page)).includes(`import logo from "${docs["svg"]}" with { type: "bytes" };`)).toBe(true);
  await expect(editorView(page)).toHaveAttribute("data-selection", `document:${docs["svg"]} with bytes`);
  await expect(dialog(page).locator('[data-param="preview"]')).toContainText("6 bytes");

  // A feature that uses a document edits it from its context menu; nothing uses the logo, which can be removed.
  await timelineEntry(page, "sketch1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit Dimensions" }).click();
  await expect(dialog(page)).toHaveAttribute("data-document", docs["data"]!);
  await row(page, "Dimensions").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open", "Follow"]);
  await page.keyboard.press("Escape");
  await row(page, "logo").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open", "Pin to this version", "Remove"]);
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove" }).click();
  await expect(page.locator(".cad-editor__document-row")).toHaveCount(2);
  expect(await modelSource(page)).not.toContain("logo");

  // The code pane shows titles after the specifiers; a click opens the document.
  await openCode(page);
  await expect(page.locator(".cad-model__document-title")).toHaveText(["Dimensions", "dims"]);
  await page.locator(".cad-model__document-title", { hasText: "Dimensions" }).click();
  await expect.poll(() => docUrl(page)).toBe(docs["data"]);
});

test("documents an imported JS file imports, and those a configuration links values to, are listed for what they are", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const { data } = await create(page, { data: { data: { title: "Dimensions", w: 20 } } });
  const { lib } = await create(page, { lib: { file: "lib.js", mimeType: "text/javascript", text: `import dims from "${data}";\nexport const width = dims.w;\n` } });
  await setModelSource(page, plate(`import { width } from "${lib}";\nexport const defaultParams = { d: 10 };`, "width + d - 10").replace("main()", "main({ d })"), "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(20);
  await expect(row(page, "lib")).toHaveAttribute("data-role", "import");
  await expect(row(page, "Dimensions")).toHaveAttribute("data-role", "indirect");
  // The document an imported file follows is locked as the model's own are.
  await expect.poll(() => locks(page)).toEqual({ [lib!]: await headsOf(page, lib!), [data!]: await headsOf(page, data!) });
  await row(page, "Dimensions").getByRole("button").first().click();
  await expect(dialog(page)).toHaveAttribute("data-role", "indirect");
  await expect(dialog(page).getByRole("radio", { name: "Pinned" })).toBeDisabled();
  await dialog(page).locator('[data-param="users"]').getByRole("button", { name: "lib" }).click();
  await expect(dialog(page)).toHaveAttribute("data-document", lib!);
  await expect(dialog(page).locator('[data-param="preview"] code')).toHaveText(["width"]);

  // A configuration's linked value names its document and path; the dialog lists the configuration that links to it.
  await page.evaluate(
    async ([model, url]) => (await (window as unknown as { repo: Repo }).repo.find(model!)).change((d) => ((d["cad"] as Record<string, unknown>)["configurations"] = [{ id: "c1", name: "Deep", params: { d: { link: url } } }])),
    [docUrl(page), `${data}/w`] as const,
  );
  const link = page.locator('.cad-editor__document-row[data-role="link"]');
  await expect(link).toHaveAttribute("data-name", "Dimensions");
  await expect(link).toContainText("/w");
  await link.getByRole("button").first().click();
  await expect(dialog(page).locator('[data-param="users"]')).toContainText("Deep: d");
});

test("a newer version that breaks the model is held back at its lock, never as an undo step, and advances once it builds", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await open(page);
  const { json } = await create(page, { json: { file: "dims.json", mimeType: "application/octet-stream", text: '{ "w": 20 }' } });
  await setModelSource(page, plate(`import { w } from "${json}";`, "w"), "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(20);
  // The first build without errors writes the lock.
  await expect.poll(() => locks(page)).toEqual({ [json!]: await headsOf(page, json!) });
  const first = await headsOf(page, json!);

  // Invalid JSON is an import error the locked version doesn't have: the model stays as it was.
  await change(page, json!, { text: '{ "w": ' });
  await expect(status(page)).toContainText("dims is held back at the version the model last built with: import error on line 2");
  await expect(row(page, "dims")).toHaveAttribute("data-state", "held");
  expect(await extentX(page)).toBeCloseTo(20);
  expect(await locks(page)).toEqual({ [json!]: first });
  await openCode(page);
  await expect(page.locator('.cm-line[data-marked="true"]')).toHaveCount(1);
  await expect(page.locator(".cad-model__document-title")).toHaveAttribute("data-state", "held");

  // An edit of the code, then a fixed source: the lock advances, and undo undoes the edit, not the lock.
  await editor(page).focus();
  await pressMod(page, "End");
  await page.keyboard.type("// edited");
  await expect.poll(async () => (await modelSource(page)).endsWith("// edited")).toBe(true);
  await change(page, json!, { text: '{ "w": 30 }' });
  await expect.poll(() => extentX(page)).toBeCloseTo(30);
  await expect(row(page, "dims")).toHaveAttribute("data-state", "following");
  await expect.poll(() => locks(page)).toEqual({ [json!]: await headsOf(page, json!) });
  const advanced = await locks(page);
  await editor(page).focus();
  await pressMod(page, "z");
  await expect.poll(async () => (await modelSource(page)).endsWith("// edited")).toBe(false);
  expect(await locks(page)).toEqual(advanced);
  await expect(status(page)).not.toContainText("held back");

  // A document no longer imported loses its lock.
  await setModelSource(page, plate("", "15"), "replace");
  await expect.poll(() => locks(page)).toEqual({});
});

test("two editors keep each other's locks: one that is behind a lock never writes it", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await open(a.page);
  const { data } = await create(a.page, { data: { data: { title: "Dimensions", w: 20 } } });
  await setModelSource(a.page, plate(`import dims from "${data}";`, "dims.w"), "replace");
  await expect.poll(() => locks(a.page)).toEqual({ [data!]: await headsOf(a.page, data!) });
  await bootToFrame(b.page, docPathWith(a.page));
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => extentX(b.page)).toBeCloseTo(20);
  // Both tabs have the same model: an editor that loaded it before the lock arrived may have written the same lock meanwhile.
  await expect.poll(async () => JSON.stringify(await modelHeads(a.page)) === JSON.stringify(await modelHeads(b.page))).toBe(true);

  // A lock at a version of the document that neither editor has: both are behind it, and neither writes.
  const ahead = await a.page.evaluate(async ([model, data]) => {
    const repo = (window as unknown as { repo: Repo }).repo;
    // The page's importmap provides the same automerge and automerge-repo as the repo's.
    const specifiers = ["@automerge/automerge", "@automerge/automerge-repo"];
    const [am, amr] = (await Promise.all(specifiers.map((s) => import(s)))) as [
      { clone<T>(d: T): T; change<T>(d: T, fn: (d: Record<string, unknown>) => void): T; getHeads(d: unknown): string[] },
      { encodeHeads(h: string[]): string[] },
    ];
    const fork = am.change(am.clone((await repo.find(data!)).doc()), (d) => (d["w"] = 99));
    const heads = [...amr.encodeHeads(am.getHeads(fork))].sort();
    (await repo.find(model!)).change((d) => (((d["cad"] as { locks: Record<string, string[]> }).locks[data!] = heads)));
    return heads;
  }, [docUrl(a.page), data] as const);
  await expect.poll(() => locks(b.page)).toEqual({ [data!]: ahead });
  await change(a.page, data!, { w: 25 });
  await expect.poll(() => extentX(a.page)).toBeCloseTo(25);
  await expect.poll(() => extentX(b.page)).toBeCloseTo(25);
  await a.page.waitForTimeout(1000);
  expect(await locks(a.page)).toEqual({ [data!]: ahead });
  expect(await locks(b.page)).toEqual({ [data!]: ahead });

  // Both editors in step: they write the same lock once, and it stays.
  await change(a.page, data!, { w: 30 });
  await expect.poll(() => extentX(b.page)).toBeCloseTo(30);
  await a.page.evaluate(async ([model, data]) => (await (window as unknown as { repo: Repo }).repo.find(model!)).change((d) => delete (d["cad"] as { locks: Record<string, unknown> }).locks[data!]), [docUrl(a.page), data] as const);
  await expect.poll(() => locks(b.page)).toEqual({});
  await change(a.page, data!, { w: 35 });
  const latest = await headsOf(a.page, data!);
  await expect.poll(() => locks(a.page)).toEqual({ [data!]: latest });
  await expect.poll(() => locks(b.page)).toEqual({ [data!]: latest });
  // Each may have written it once; then the model stays as it is, without locks going back and forth.
  await expect
    .poll(async () => {
      const before = await modelHeads(a.page);
      await a.page.waitForTimeout(1500);
      return JSON.stringify(before) === JSON.stringify(await modelHeads(a.page));
    })
    .toBe(true);
  expect(await locks(b.page)).toEqual({ [data!]: latest });
});

test("the viewer reads locks and never writes one", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page, "cad-model-viewer");
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const { json } = await create(page, { json: { file: "dims.json", mimeType: "application/json", text: '{ "w": 20 }' } });
  await setModelSource(page, plate(`import { w } from "${json}";`, "w"), "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(20);
  await page.waitForTimeout(500);
  expect(await locks(page)).toBeUndefined();

  // With a lock, written by an editor elsewhere, it holds back as the editor does, and still writes nothing.
  const locked = await headsOf(page, json!);
  await page.evaluate(async ([model, url, heads]) => (await (window as unknown as { repo: Repo }).repo.find(model as string)).change((d) => (d["cad"] = { locks: { [url as string]: heads } })), [docUrl(page), json, locked] as const);
  await change(page, json!, { text: '{ "w": ' });
  await expect(status(page)).toContainText("dims is held back");
  expect(await extentX(page)).toBeCloseTo(20);
  await change(page, json!, { text: '{ "w": 30 }' });
  await expect.poll(() => extentX(page)).toBeCloseTo(30);
  await page.waitForTimeout(500);
  expect(await locks(page)).toEqual({ [json!]: locked });
  await openWithTool(page, "cad-model");
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // The editor advances it.
  await expect.poll(() => locks(page)).toEqual({ [json!]: await headsOf(page, json!) });
});
