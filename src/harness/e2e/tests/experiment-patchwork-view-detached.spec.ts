/**
 * A Patchwork behaviour the document canvases ran into (research/22, "The experiment"): a
 * `<patchwork-view>` that gets `doc-url` while it isn't connected starts loading in its
 * `attributeChangedCallback`, asks for the document with a `patchwork:subscribe` event that no
 * provider can hear, waits for the answer forever, and doesn't start again once it is connected. One
 * connected in the same task, before that microtask runs, mounts. This spec fails once Patchwork
 * fixes it.
 */
import { expect, test } from "../fixtures.ts";
import { sidebarDocuments } from "../documents.ts";
import { bootToFrame } from "../ui.ts";

test("a <patchwork-view> given its document while detached never mounts its tool", async ({ users }) => {
  const [a] = await users(1);
  const page = a!.page;
  await bootToFrame(page);
  const docs = await sidebarDocuments(page, { notes: { data: { "@patchwork": { type: "markdown" }, content: "# Notes\n\nhello" } } });
  const result = await page.evaluate(async (url) => {
    // Inside the provider of documents, which answers a view's requests.
    const host = document.querySelector("repo-provider")!;
    const view = () => {
      const v = document.createElement("patchwork-view");
      v.style.cssText = "display:block;position:fixed;left:0;top:0;width:300px;height:200px";
      v.setAttribute("doc-url", url);
      return v;
    };
    const subscribed = new Set<EventTarget>();
    window.addEventListener("patchwork:subscribe", (e) => subscribed.add(e.composedPath()[0]!), true);
    // Connected in the same task, and connected 50 ms after it got its document.
    const now = view();
    host.append(now);
    const later = view();
    await new Promise((r) => setTimeout(r, 50));
    host.append(later);
    await new Promise((r) => setTimeout(r, 5000));
    const mounted = (v: Element) => v.querySelector(".patchwork-view-content")?.childElementCount ?? 0;
    const out = { now: mounted(now), later: mounted(later), laterAsked: subscribed.has(later) };
    // Connected again, it mounts.
    later.remove();
    host.append(later);
    await new Promise((r) => setTimeout(r, 5000));
    return { ...out, laterAgain: mounted(later) };
  }, docs["notes"]!);
  expect(result).toEqual({ now: 1, later: 0, laterAsked: false, laterAgain: 1 });
});
