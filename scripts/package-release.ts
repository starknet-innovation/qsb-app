import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createSourceManifest,
  recordedManifestPath,
  serializeManifest,
  writePackageTree,
} from "../server/runtime/package-release";

const root = process.cwd();
const check = process.argv.includes("--check");
const manifestPath = path.join(root, "release/source-manifest.json");
const manifest = createSourceManifest(root);
const text = serializeManifest(manifest);
if (check) {
  const current = readFileSync(recordedManifestPath(root), "utf8");
  if (current !== text) {
    console.error("release/source-manifest.json does not match this checkout");
    process.exit(1);
  }
  console.log("release/source-manifest.json matches this checkout");
} else {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, text);
  writePackageTree(root, path.join(root, "release/dist"), manifest);
  console.log("wrote release/source-manifest.json and release/dist");
}
