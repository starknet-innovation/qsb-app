// Builds @starknet-innovation/qsb-sdk: dist/index.js (the SDK), dist/cli.js (the qsb bin), dist/types
// (declarations) and public/qsb (the pinned Python sources). Nothing is published; see README.md.
//
// The bundles inline the app's own code from src/lib, src/mainnet and server/api-schemas, so the SDK runs the
// same checks and signing preparation as the webapp. npm dependencies stay external. The runtime finds the
// Python sources at ../public/qsb/ relative to itself: public/qsb in this repository for sdk/runtime.ts, and
// this package's public/qsb for dist/*.js. It checks every file against manifest.json before running it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const tsc = path.join(root, "node_modules", ".bin", "tsc");
execFileSync(tsc, ["-p", path.join(sdk, "tsconfig.build.json")], { stdio: "inherit" });
finishDeclarations(path.join(dist, "types"));
console.log("Built the SDK into sdk/dist and sdk/public/qsb. Nothing is published.");

/**
 * tsc emits declarations with the sources' extensionless imports (`./client`) and JSON imports. A Node ESM
 * consumer (`moduleResolution: NodeNext`) needs `./client.js`, and the package ships no JSON. So each relative
 * import gets its `.js` extension, each JSON import becomes the type TypeScript infers for that JSON, and
 * declarations the SDK's entry doesn't reach are dropped.
 */
function finishDeclarations(types) {
  const entry = path.join(types, "sdk", "index.d.ts");
  const specifier = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g;
  const jsonImport = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.{1,2}\/[^"']+\.json)["'];\s*$/gm;
  const reached = new Set();
  const inlined = [];
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const dir = path.dirname(file);
    let text = readFileSync(file, "utf8").replace(jsonImport, (_, name, spec) => {
      const source = path.join(root, path.relative(types, path.resolve(dir, spec)));
      inlined.push({ source, type: jsonType(JSON.parse(readFileSync(source, "utf8"))) });
      return `declare const ${name}: ${inlined.at(-1).type};`;
    });
    text = text.replace(specifier, (_, lead, quote, spec) => {
      const target = path.resolve(dir, spec);
      const found = [[`${target}.d.ts`, `${spec}.js`], [path.join(target, "index.d.ts"), `${spec}/index.js`]]
        .find(([candidate]) => existsSync(candidate));
      if (!found) throw new Error(`${path.relative(types, file)} imports ${spec}, which has no declaration`);
      visit(found[0]);
      return `${lead}${quote}${found[1]}${quote}`;
    });
    writeFileSync(file, text);
  };
  visit(entry);
  for (const file of walk(types)) if (!reached.has(file)) rmSync(file);
  pruneEmptyDirectories(types);
  assertJsonTypes(inlined);
}

/** The type TypeScript infers for a JSON module: widened primitives, arrays of the union of their elements. */
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const elements = [...new Set(value.map(jsonType))];
    return elements.length === 0 ? "never[]" : elements.length === 1 ? `${elements[0]}[]` : `(${elements.join(" | ")})[]`;
  }
  if (typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${jsonType(v)};`).join(" ")} }`;
  }
  return typeof value;
}

/** Proves each inlined type and TypeScript's own type for that JSON are assignable to each other. */
function assertJsonTypes(inlined) {
  if (!inlined.length) return;
  const check = mkdtempSync(path.join(tmpdir(), "qsb-sdk-json-"));
  try {
    const lines = inlined.flatMap(({ source, type }, i) => [
      `import j${i} from ${JSON.stringify(source)};`,
      `type G${i} = ${type};`,
      `const a${i}: G${i} = j${i}; const b${i}: typeof j${i} = null as unknown as G${i}; void a${i}; void b${i};`,
    ]);
    writeFileSync(path.join(check, "check.ts"), lines.join("\n") + "\n");
    writeFileSync(path.join(check, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
        resolveJsonModule: true, skipLibCheck: true, types: [] },
      files: ["check.ts"],
    }));
    execFileSync(tsc, ["-p", check], { stdio: "inherit" });
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function pruneEmptyDirectories(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirectories(path.join(dir, e.name));
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
}
