/**
 * Imports of documents in model code (research/02, "Verdict: imports in code"): a JS file that
 * imports a data document, and the data document pinned to a version; the model follows the one
 * and not the other, and errors point at the model's lines.
 */
import type { Page } from "@playwright/test";
import { CAD_MODULES, createModel, editorView, setModelSource } from "../cad.ts";
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
