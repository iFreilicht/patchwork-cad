import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { CAD_MODULES, CODE_TOOL, M1_SOURCE, cadView, createModel, replaceSource, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

/** n boxes in a row; the mesh has n times the vertices of one. */
const boxes = (n: number) => `import { drawRectangle } from "replicad";
export default function main() {
  return Array.from({ length: ${n} }, (_, i) => ({
    name: "box " + i,
    shape: drawRectangle(5, 5).sketchOnPlane().extrude(5).translate(i * 10, 0, 0),
  }));
}
`;

/** Opens a new CAD model whose engine replaces its worker before every build after the first. */
async function restartingModel(page: Page): Promise<void> {
  await page.addInitScript(() => void ((globalThis as { patchworkCadHeapLimit?: number }).patchworkCadHeapLimit = 0));
  await bootToFrame(page);
  await createModel(page, CODE_TOOL);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
}

const restarts = async (page: Page) => Number((await cadView(page).getAttribute("data-kernel-restarts")) ?? 0);

// The engine replaces its kernel worker when OCCT's heap passes a limit
// (research/08). Builds keep working across restarts, and edits made while a
// new worker loads end in the newest source.
test("the kernel worker restarts without losing builds", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await restartingModel(page);
  const seed = await vertices(page);

  await replaceSource(page, boxes(1));
  await expect.poll(() => vertices(page)).not.toBe(seed);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready");
  const box = await vertices(page);
  const before = await restarts(page);
  expect(before).toBeGreaterThan(0);

  // Without waiting in between: each edit lands while a worker restarts.
  for (const n of [2, 3, 4]) await replaceSource(page, boxes(n));
  await expect.poll(() => vertices(page), { timeout: 60_000 }).toBe(4 * box);
  await expect(cadView(page)).toHaveAttribute("data-state", "ready");
  expect(await restarts(page)).toBeGreaterThan(before);
  await expect(cadView(page)).toHaveAttribute("data-init", /compile/);
});

/**
 * Resident memory of all of Playwright's browser processes, in MB. WebKit's
 * content, GPU and networking processes are its development builds
 * (com.apple.WebKit.*.Development) from another store path, started by launchd.
 */
function browserRssMB(): number {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root) throw new Error("PLAYWRIGHT_BROWSERS_PATH is not set; run in nix develop");
  const lines = execFileSync("ps", ["-A", "-o", "rss=,command="], { encoding: "utf8" }).split("\n");
  const ours = (line: string) => line.includes(root) || /com\.apple\.WebKit\.\w+\.Development/.test(line);
  const kb = lines.filter(ours).reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] ?? 0), 0);
  return Math.round(kb / 1024);
}

// Whether terminating a worker gives its memory back: 40 builds of M1, each in
// a new worker. Run alone, as other tests' browsers count too:
//   CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-restart
test("terminated kernel workers release their memory", async ({ users }, testInfo) => {
  test.skip(!process.env["CAD_MEASURE"], "set CAD_MEASURE=1 to measure");
  test.setTimeout(900_000);
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await restartingModel(page);
  await replaceSource(page, M1_SOURCE(30));
  await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  const samples: { builds: number; restarts: number; rssMB: number }[] = [];
  for (let i = 1; i <= 40; i++) {
    const executed = Number(await cadView(page).getAttribute("data-builds-executed"));
    // Alternating notch positions, so that every edit changes the source.
    await replaceSource(page, M1_SOURCE(i % 2 ? 25 : 30));
    await expect.poll(async () => Number(await cadView(page).getAttribute("data-builds-executed"))).toBeGreaterThan(executed);
    await expect(cadView(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    if (i % 10 === 0) samples.push({ builds: i, restarts: await restarts(page), rssMB: browserRssMB() });
  }
  const result = { browser: testInfo.project.name, samples };
  console.log(JSON.stringify(result));
  await testInfo.attach("cad-restart.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
