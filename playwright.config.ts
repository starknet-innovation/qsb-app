import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.ts",
  timeout: 120000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  maxFailures: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    launchOptions: {
      proxy: {
        server: "http://127.0.0.1:9",
        bypass: "127.0.0.1,localhost,[::1]",
      },
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    env: {
      ...process.env,
      QSB_NETWORK: "mainnet",
      VITE_QSB_NETWORK: "mainnet",
    },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
