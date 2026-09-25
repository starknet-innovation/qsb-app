import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const network = process.env.VITE_QSB_NETWORK;
if (network !== "mainnet" && network !== "testnet4") {
  throw new Error("Set VITE_QSB_NETWORK to mainnet or testnet4");
}

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@noble/hashes/legacy.js"] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: { target: "es2022" },
  worker: { format: "es" },
});
