import { CAD_DIR, cadView } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu } from "../ui.ts";

// The alternative to serving the tool from the site (research/06): publish it
// with pushwork and register it per account. Measured, not used by `pnpm dev`.
//   CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-pushwork
test.skip(!process.env["CAD_MEASURE"], "set CAD_MEASURE=1 to measure");

test("CAD tool published with pushwork loads OCCT through the service worker", async ({ users, publishModule, installModule, localStack }, testInfo) => {
  test.setTimeout(900_000);
  const start = Date.now();
  await publishModule(CAD_DIR);
  const publishMs = Date.now() - start;

  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  await bootToFrame(a.page);
  await installModule(CAD_DIR, a);
  const shownStart = Date.now();
  await createViaMenu(a.page, "CAD Model");
  await expect(cadView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 600_000 });
  const firstShownMs = Date.now() - shownStart;
  const firstInit = await cadView(a.page).getAttribute("data-init");

  const reloadStart = Date.now();
  await a.page.reload();
  await expect(cadView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 600_000 });
  const result = {
    publishMs,
    firstShownMs,
    firstInit: JSON.parse(firstInit ?? "null") as unknown,
    reloadShownMs: Date.now() - reloadStart,
    reloadInit: JSON.parse((await cadView(a.page).getAttribute("data-init")) ?? "null") as unknown,
    wasmFromSite: localStack.siteRequests.filter((r) => r.path.endsWith(".wasm") && r.path.includes("replicad")).length,
  };
  console.log(JSON.stringify(result));
  await testInfo.attach("cad-pushwork.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
