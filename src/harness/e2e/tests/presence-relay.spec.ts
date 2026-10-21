/**
 * Ephemeral messages, which presence is made of, between two profiles and between two tabs of one
 * profile, also after Patchwork's shared worker resolved and evicted the documents
 * (research/13-collaboration.md#limitations, patchwork-system#450).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

interface Handle {
  url: string;
  broadcast(message: unknown): void;
  on(event: "ephemeral-message", f: (e: { message: unknown }) => void): void;
}
interface Win {
  repo: { create(doc: object): Handle; find(url: string): Promise<Handle> };
  heard: string[];
}

const create = (page: Page) => page.evaluate(() => (window as unknown as Win).repo.create({ content: "hello" }).url);

/** Records every ephemeral message on `url`; retries while the document hasn't reached the server yet. */
async function listen(page: Page, url: string): Promise<void> {
  await expect(async () => {
    await page.evaluate(async (url) => {
      const w = window as unknown as Win;
      w.heard = [];
      (await w.repo.find(url)).on("ephemeral-message", (e) => w.heard.push((e.message as { text: string }).text));
    }, url);
  }).toPass({ timeout: 30_000 });
}

/** Sends `text` from `from` until every page in `to` heard it; a subscription may not have reached the server yet. */
async function reaches(from: Page, url: string, text: string, ...to: Page[]): Promise<void> {
  await expect
    .poll(
      async () => {
        await from.evaluate(async ({ url, text }) => (await (window as unknown as Win).repo.find(url)).broadcast({ text }), { url, text });
        return Promise.all(to.map((page) => page.evaluate((text) => (window as unknown as Win).heard.includes(text), text)));
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toEqual(to.map(() => true));
}

test("presence reaches other profiles and tabs, also after the shared worker evicted the document", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await bootToFrame(b.page);
  const b2 = await b.context.newPage();
  await bootToFrame(b2);

  const doc = await create(a.page);
  const other = await create(a.page);
  for (const page of [a.page, b.page, b2]) await listen(page, doc);
  await reaches(a.page, doc, "a1", b.page, b2);
  await reaches(b.page, doc, "b1", a.page, b2);

  // B's shared worker resolves both documents from the server, then evicts them 5 s after its last handoff.
  for (const url of [doc, other]) {
    const status = await b.page.evaluate((url) => fetch(`/${encodeURIComponent(url)}`).then((r) => r.status), url);
    expect(status, url).toBeLessThan(500);
  }
  await b.page.waitForTimeout(8_000);

  await reaches(a.page, doc, "a2", b.page, b2);
  await reaches(b.page, doc, "b2", a.page, b2);
  await reaches(b2, doc, "b2-2", a.page, b.page);
});
