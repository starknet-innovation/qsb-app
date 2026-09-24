import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
mkdirSync("supervised/dist", { recursive: true });
await build({
  entryPoints: ["supervised/dispatch/host-entry.ts"],
  outfile: "supervised/dist/dispatcher.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "import.meta.env": "undefined" },
});
copyFileSync("supervised/host/host.py", "supervised/dist/host.py");
const files = {};
for (const name of ["dispatcher.cjs", "host.py"])
  files[name] = createHash("sha256")
    .update(readFileSync("supervised/dist/" + name))
    .digest("hex");
writeFileSync(
  "supervised/dist/manifest.json",
  JSON.stringify(
    { format: "qsb-dispatch-package-v1", executionEnabled: false, files },
    null,
    2,
  ) + "\n",
);
