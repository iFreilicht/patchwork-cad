import { defineConfig, devices } from "@playwright/test";
import { firefoxLaunchOptions } from "./firefox.ts";

export default defineConfig({
  testDir: "./tests",
  outputDir: "../test-results",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Every failure must be explained, so retries would only hide flakes.
  retries: 0,
  workers: 2,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  use: {
    // Saving a trace of a booted Patchwork page stalls until the test
    // timeout (Playwright 1.59.1, reproduced without harness fixtures).
    trace: "off",
    // A click or keypress waits for its element at most this long, so a missing element fails fast instead of at the test timeout.
    actionTimeout: 5_000,
    screenshot: "only-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: { ...devices["Desktop Firefox"], launchOptions: firefoxLaunchOptions() } },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
