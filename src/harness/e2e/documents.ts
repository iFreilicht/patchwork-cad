/** Documents in Patchwork's sidebar and drags of them, for specs of documents entering a model (research/21-embedding.md). */
import type { Locator, Page } from "@playwright/test";

export type Handle = { url: string; heads(): string[]; doc(): Record<string, unknown>; change(fn: (d: Record<string, unknown>) => void): void };
export type Repo = { find(u: string): Promise<Handle>; create(d: unknown): Handle };

/**
 * Creates documents and lists them in the folder the sidebar's document list shows, as "Add to
 * sidebar" does: data documents as given, files with their text as UTF-8 bytes, as the sidebar
 * uploads them. Each is listed under its key.
 */
export async function sidebarDocuments(page: Page, docs: Record<string, { data: Record<string, unknown> } | { file: string; mimeType: string; text: string }>): Promise<Record<string, string>> {
  return page.evaluate(async (docs) => {
    const w = window as unknown as { repo: Repo };
    const list = document.querySelector('.threepane-sidebar patchwork-view[tool-id="chee/document-list"]');
    const folder = await w.repo.find(list!.getAttribute("doc-url")!);
    const urls: Record<string, string> = {};
    for (const [key, d] of Object.entries(docs)) {
      const [name, extension] = "file" in d ? d.file.split(".") : [];
      const handle = "data" in d ? w.repo.create(d.data) : w.repo.create({ "@patchwork": { type: "file" }, name, extension, mimeType: d.mimeType, content: new TextEncoder().encode(d.text) });
      urls[key] = handle.url;
      folder.change((f) => (f["docs"] as unknown[]).push({ name: key, type: "data" in d ? "unknown" : "file", url: handle.url }));
    }
    return urls;
  }, docs);
}

export const sidebarEntry = (page: Page, name: string) => page.locator(".threepane-sidebar [data-dnd-item]").filter({ hasText: new RegExp(`^${name}$`) }).first();

export async function centre(target: Locator | { x: number; y: number }): Promise<{ x: number; y: number }> {
  if (!("boundingBox" in target)) return target;
  const box = await target.boundingBox();
  if (!box) throw new Error("the drop target isn't visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drags a sidebar entry, by its name, or another element with the mouse onto `target` and, unless `release` is false, drops it there.
 * WebKit drops only where a dragover accepted the drag, which a move ending on a new element hasn't yet sent.
 */
export async function drag(page: Page, source: string | Locator, target: Locator | { x: number; y: number }, release = true): Promise<void> {
  const from = await centre(typeof source === "string" ? sidebarEntry(page, source) : source);
  const to = await centre(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 2 });
  if (release) await page.mouse.up();
}
