import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "output/playwright/test-results",
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
