import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "../test-results",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // Every failure must be explained, so retries would only hide flakes.
  retries: 0,
  workers: 2,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  use: {
    // Saving a trace of a booted Patchwork page stalls until the test
    // timeout (Playwright 1.59.1, reproduced without harness fixtures).
    trace: "off",
    screenshot: "only-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
