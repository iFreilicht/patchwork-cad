import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Launch options for Playwright's Firefox. On macOS 27 it resolves its
 * app-data directory to ~/Library/Application Support/Firefox, which TCC
 * protects, so every launch from a terminal hangs until the launch timeout
 * (microsoft/playwright#42768, "Fixed upstream in Firefox 158"). Pointing
 * CoreFoundation's home at an empty directory gives it a directory of its own.
 */
export function firefoxLaunchOptions(): { env?: Record<string, string> } {
  if (process.platform !== "darwin") return {};
  const home = join(tmpdir(), "patchwork-harness-firefox-home");
  mkdirSync(home, { recursive: true });
  return { env: { ...(process.env as Record<string, string>), CFFIXED_USER_HOME: home } };
}
