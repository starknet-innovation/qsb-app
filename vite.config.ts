import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const network = process.env.VITE_QSB_NETWORK;
if (network !== "mainnet") {
  throw new Error("Set VITE_QSB_NETWORK to mainnet");
}

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@noble/hashes/legacy.js"] },
  server: {
    port: 5173,
    strictPort: true,
    // The webapp calls /v1 (API_BASE_PATH in src/lib/network.ts); the local API
    // (server/local.ts) also serves /api, as the deployed one does.
    proxy: { "/v1": "http://127.0.0.1:8787", "/api": "http://127.0.0.1:8787" },
  },
  build: { target: "es2022" },
  worker: { format: "es" },
});
