import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { HARNESS_DIR } from "./stack.ts";

export type AutomergeUrl = `automerge:${string}`;

const PUSHWORK = join(HARNESS_DIR, "node_modules", ".bin", "pushwork");

/**
 * Publishes a built tool directory (package.json + its entry) to the sync
 * server with pushwork, from a temporary copy so the source stays free of
 * `.pushwork/` state. Returns the directory doc's URL.
 */
export async function publishModule(dir: string, subductionUrl: string): Promise<AutomergeUrl> {
  const copy = await mkdtemp(join(tmpdir(), "patchwork-harness-module-"));
  await cp(dir, copy, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.endsWith(".pushwork") });
  const options = { cwd: copy, env: { ...process.env, PUSHWORK_SUBDUCTION_SERVER: subductionUrl } };
  await promisify(execFile)(PUSHWORK, ["init", "."], options);
  const { stdout } = await promisify(execFile)(PUSHWORK, ["url"], options);
  const url = stdout.trim();
  if (!url.startsWith("automerge:")) throw new Error(`pushwork url printed ${JSON.stringify(stdout)}`);
  return url as AutomergeUrl;
}

/**
 * Adds a module to the booted page's account module-settings doc, as the
 * Packages UI's "Add to my package list" does.
 */
export async function registerModule(page: Page, url: AutomergeUrl): Promise<void> {
  await page.evaluate(async (url) => {
    const settingsUrl = window.patchwork.account.doc()?.moduleSettingsUrl;
    if (!settingsUrl) throw new Error("account has no moduleSettingsUrl");
    const settings = await window.repo.find<{ modules: string[] }>(settingsUrl);
    settings.change((doc) => {
      if (!doc.modules.includes(url)) doc.modules.push(url);
    });
  }, url);
}

/** A tool directory with patchwork-e2e's one-file counter module (a `counter` datatype and its viewer). */
export async function counterModuleDir(): Promise<string> {
  const e2e = dirname(createRequire(import.meta.url).resolve("@inkandswitch/patchwork-e2e/package.json"));
  const dir = await mkdtemp(join(tmpdir(), "patchwork-harness-counter-"));
  await cp(join(e2e, "dist", "fixtures", "counter.js"), join(dir, "index.js"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "e2e-counter", version: "1.0.0", main: "./index.js" }));
  return dir;
}
