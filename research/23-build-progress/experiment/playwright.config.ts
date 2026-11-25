import { defineConfig, devices } from "@playwright/test";
import { firefoxLaunchOptions } from "../../../src/harness/e2e/firefox.ts";

export default defineConfig({
  testDir: ".",
  testMatch: "experiment.spec.ts",
  outputDir: "test-results",
  timeout: 3_600_000,
  retries: 0,
  // Timings: one browser at a time, nothing else running.
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:4181" },
  webServer: { command: "pnpm exec vite preview", url: "http://localhost:4181", reuseExistingServer: false },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: { ...devices["Desktop Firefox"], launchOptions: firefoxLaunchOptions() } },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
