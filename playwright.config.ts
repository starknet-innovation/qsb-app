import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.ts",
  timeout: 120000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", headless: true },
  webServer: {
    command: "npm run dev",
    env: {
      ...process.env,
      QSB_NETWORK: "mainnet",
      VITE_QSB_NETWORK: "mainnet",
    },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
