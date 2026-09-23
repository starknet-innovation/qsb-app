import { serve } from "@hono/node-server";
import { app } from "./app";
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8787 });
console.log(
  "QSB API: http://127.0.0.1:8787 (local memory store; mainnet operations disabled)",
);
