import { defineConfig } from '@playwright/test';
import config from './playwright.config';
export default defineConfig({
  ...config,
  use: { ...config.use, baseURL: "http://127.0.0.1:5179" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5179",
    env: {
      ...process.env,
      QSB_NETWORK: "mainnet",
      VITE_QSB_NETWORK: "mainnet",
    },
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
  },
});
