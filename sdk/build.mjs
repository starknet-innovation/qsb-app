// Builds @starknet-innovation/qsb-sdk: dist/index.js (the SDK), dist/cli.js (the qsb bin), dist/types
// (declarations) and public/qsb (the pinned Python sources). Nothing is published; see README.md.
//
// The bundles inline the app's own code from src/lib, src/mainnet and server/api-schemas, so the SDK runs the
// same checks and signing preparation as the webapp. npm dependencies stay external. The runtime finds the
// Python sources at ../public/qsb/ relative to itself: public/qsb in this repository for sdk/runtime.ts, and
// this package's public/qsb for dist/*.js. It checks every file against manifest.json before running it.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sdk = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(sdk, "..");
const dist = path.join(sdk, "dist");
const sources = path.join(sdk, "public", "qsb");

rmSync(dist, { recursive: true, force: true });
rmSync(path.join(sdk, "public"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  // The network comes only from QSB_NETWORK at run time, as for the Lambdas; there's no build-time default.
  define: { "import.meta.env": "undefined" },
  legalComments: "inline",
  logLevel: "warning",
};
await build({ ...common, entryPoints: [path.join(sdk, "index.ts")], outfile: path.join(dist, "index.js") });
await build({ ...common, entryPoints: [path.join(sdk, "main.ts")], outfile: path.join(dist, "cli.js") });

// Every file the manifest pins, and the upstream licence that must travel with them; nothing else.
const manifest = JSON.parse(readFileSync(path.join(root, "public", "qsb", "manifest.json"), "utf8"));
for (const file of ["manifest.json", "LICENSE", ...Object.keys(manifest)]) {
  cpSync(path.join(root, "public", "qsb", file), path.join(sources, file));
}

execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(sdk, "tsconfig.build.json")], {
  stdio: "inherit",
});
console.log("Built the SDK into sdk/dist and sdk/public/qsb. Nothing is published.");
