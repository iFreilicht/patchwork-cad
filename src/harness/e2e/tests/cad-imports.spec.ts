/**
 * Imports of documents in model code (research/02, "Verdict: imports in code"): a JS file that
 * imports a data document, and the data document pinned to a version; the model follows the one
 * and not the other, and errors point at the model's lines.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, editorView, setModelSource, timelineEntry } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

type Repo = { find(u: string): Promise<{ change(fn: (d: Record<string, unknown>) => void): void }>; create(d: unknown): { url: string; heads(): string[] } };
const repoOf = () => (window as unknown as { repo: Repo }).repo;

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

test("a model imports a JS file and a data document, followed or pinned", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });

  const { data, pinned, lib } = await page.evaluate(`(${(repoOf: () => Repo) => {
    const repo = repoOf();
    const data = repo.create({ hole_diameter: 8 });
    const lib = repo.create({
      content: `import { hole_diameter } from "${data.url}";\nexport const width = hole_diameter * 10;\nexport function fail() {\n  throw new Error("from the library");\n}\n`,
      mimeType: "application/javascript",
    });
    return { data: data.url, pinned: `${data.url}#${data.heads().join("|")}`, lib: lib.url };
  }})(${repoOf})`) as { data: string; pinned: string; lib: string };

  const model = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";\nimport { width, fail } from "${lib}";\nimport { hole_diameter as pinned } from "${pinned}";\nexport default function main() {\n  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [width + pinned, 1] }) });\n  return { plate: extrude({ sketch: sketch1, distance: 1 }) };\n}\n`;
  await setModelSource(page, model, "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(88);

  // The library follows the data document; the pinned import keeps its version.
  await page.evaluate(async (url) => (await (window as unknown as { repo: Repo }).repo.find(url)).change((d) => (d["hole_diameter"] = 10)), data);
  await expect.poll(() => extentX(page)).toBeCloseTo(108);

  // An error thrown in the library is on the line of the model that called it.
  await setModelSource(page, model.replace("  const sketch1", "  fail();\n  const sketch1"), "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText("runtime error on line 5: from the library");
  // A document that can't be found is an import error on the line of its import.
  await setModelSource(page, `import x from "automerge:nope";\nexport default function main() {}\n`, "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText(/import error on line 1: automerge:nope can't be imported/);
  // So is a cycle: the library imports itself, through a second one.
  await page.evaluate(
    async ([url]) => {
      const repo = (window as unknown as { repo: Repo }).repo;
      const other = repo.create({ content: `export * from "${url}";\n`, mimeType: "application/javascript" });
      (await repo.find(url!)).change((d) => (d["content"] = `export * from "${other.url}";\n`));
    },
    [lib],
  );
  await setModelSource(page, model, "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText(/import error on line 2: .*imports itself/);
});

const PART = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";\nexport const defaultParams = { width: 60 };\nexport default function main({ width }) {\n  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [width, 10] }) });\n  return { plate: extrude({ sketch: sketch1, distance: 5 }) };\n}\n`;

test("a model imports another model as a JS file: calls its main, or adopts its bodies with body()", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const part = (await page.evaluate(`(${(repoOf: () => Repo, content: string) => repoOf().create({ "@patchwork": { type: "cad-model" }, title: "Part", content, mimeType: "application/javascript", cad: {} }).url})(${repoOf}, ${JSON.stringify(PART)})`)) as string;

  // Its features run in this model's build; body() adopts what its main returns as bodies of this model.
  const model = `import { body, move } from "@patchwork-cad/features";\nimport * as part from "${part}";\nexport default function main() {\n  const { plate } = part.default({ width: 30 });\n  const { plate: copy } = body(() => part.default(part.defaultParams));\n  const moved = move({ body: copy, x: 100 });\n  return { plate, moved };\n}\n`;
  await setModelSource(page, model, "replace");
  await expect(timelineEntry(page, "moved")).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect.poll(() => extentX(page)).toBeCloseTo(160);

  // It follows the model it imports.
  await page.evaluate(async (url) => (await (window as unknown as { repo: Repo }).repo.find(url)).change((d) => (d["content"] = String(d["content"]).replace("width: 60", "width: 70"))), part);
  await expect.poll(() => extentX(page)).toBeCloseTo(170);
});

test("a model uses a file's text and bytes, and JS and JSON files uploaded as bytes", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });

  // As the sidebar uploads files: bytes, with the browser's type or none it knows.
  const files = await page.evaluate(() => {
    const repo = (window as unknown as { repo: { create(d: unknown): { url: string } } }).repo;
    const file = (name: string, extension: string, mimeType: string, content: Uint8Array) => repo.create({ "@patchwork": { type: "file" }, name, extension, mimeType, content }).url;
    const utf8 = (text: string) => new TextEncoder().encode(text);
    return {
      note: file("note", "txt", "text/plain", utf8("12345")),
      pixel: file("pixel", "png", "image/png", new Uint8Array(7)),
      lib: file("lib", "js", "application/octet-stream", utf8("export const w = 30;\n")),
      dims: file("dims", "json", "application/octet-stream", utf8('{ "h": 4 }')),
    };
  });
  const model = (imports: string) =>
    `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";\n${imports}\nexport default function main() {\n  const width = w + note.length + (pixel instanceof Uint8Array ? pixel.length : 1000);\n  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [width, h] }) });\n  return { plate: extrude({ sketch: sketch1, distance: 1 }) };\n}\n`;
  const imports = `import note from "${files.note}" with { type: "text" };\nimport pixel from "${files.pixel}" with { type: "bytes" };\nimport { w } from "${files.lib}";\nimport { h } from "${files.dims}";`;
  await setModelSource(page, model(imports), "replace");
  await expect.poll(() => extentX(page)).toBeCloseTo(42);

  // An image isn't text, and an attribute names what it supports, on the import's line.
  await setModelSource(page, model(imports.replace(`"${files.pixel}" with { type: "bytes" }`, `"${files.pixel}" with { type: "text" }`)), "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText(/import error on line 3: .*can't be imported with \{ type: "text" \}/);
  await setModelSource(page, model(imports.replace('with { type: "text" }', 'with { type: "css" }')), "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText(/import error on line 2: .*the type "css" isn't supported, only \{ type: "text" \}, \{ type: "bytes" \}, \{ type: "json" \}/);
  // Without the attribute it needs, the error says how to import it.
  await setModelSource(page, model(imports.replace(' with { type: "text" }', "")), "replace");
  await expect(page.locator(".cad-model__status").first()).toContainText(/import error on line 2: .*import it with \{ type: "text" \} or with \{ type: "bytes" \}/);
});
