import { writeFileSync } from "node:fs";
import { openApiDocument, serializeOpenApi } from "../server/openapi";

// Run with QSB_NETWORK=mainnet (npm run openapi); tests/openapi.test.ts checks the result.
writeFileSync(
  new URL("../docs/api/openapi.json", import.meta.url),
  serializeOpenApi(openApiDocument()),
);
console.log("wrote docs/api/openapi.json");
