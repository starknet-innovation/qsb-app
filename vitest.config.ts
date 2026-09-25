import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: { QSB_NETWORK: "mainnet" },
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.e2e.ts"],
    testTimeout: 15000,
  },
});
