// Checks the built SDK as a consumer would get it: `npm pack`, then install the tarball into an empty
// project outside this repository and use it there. Run `npm run build -w @starknet-innovation/qsb-sdk` first.
// It publishes nothing. The install fetches the SDK's npm dependencies from the registry.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdk = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(sdk, "..");
const name = "@starknet-innovation/qsb-sdk";
const fail = (message) => {
  console.error(`SDK package check failed: ${message}`);
  process.exit(1);
};
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options });

const work = mkdtempSync(path.join(tmpdir(), "qsb-sdk-check-"));
try {
  // 1. What the tarball holds: the bundles, their declarations, the pinned Python sources and their licence.
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work, "-w", name], { cwd: root }));
  const files = packed.files.map((f) => f.path).sort();
  const manifest = JSON.parse(readFileSync(path.join(root, "public", "qsb", "manifest.json"), "utf8"));
  const required = ["package.json", "README.md", "dist/index.js", "dist/cli.js", "dist/types/sdk/index.d.ts",
    "public/qsb/manifest.json", "public/qsb/LICENSE", ...Object.keys(manifest).map((f) => `public/qsb/${f}`)];
  for (const file of required) if (!files.includes(file)) fail(`the tarball lacks ${file}`);
  const stray = files.filter((f) => !(f === "package.json" || f === "README.md" || f.startsWith("dist/") ||
    f.startsWith("public/qsb/")));
  if (stray.length) fail(`the tarball holds files outside dist/ and public/qsb/: ${stray.join(", ")}`);
  if (files.some((f) => f.startsWith("dist/") && !/\.(js|d\.ts)$/.test(f))) fail("dist/ holds a file that isn't JS or a declaration");

  // 2. The bundles reach nothing outside the package: npm dependencies are bare imports, and the only
  // relative path is the runtime's ../public/qsb/.
  for (const bundle of ["dist/index.js", "dist/cli.js"]) {
    const text = readFileSync(path.join(sdk, bundle), "utf8");
    const relative = [...text.matchAll(/(?:from|import\()\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
    if (relative.length) fail(`${bundle} imports ${relative.join(", ")}`);
    const urls = [...text.matchAll(/new URL\(\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
    if (urls.some((u) => u !== "../public/qsb/")) fail(`${bundle} resolves ${urls.join(", ")}`);
  }

  // 3. Install the tarball into an empty project outside the repository.
  const consumer = path.join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(work, packed.filename)],
    { cwd: consumer, stdio: "ignore" });

  // 4. The SDK loads from the package and runs the pinned Python there, after its manifest check.
  const env = { ...process.env, QSB_NETWORK: "mainnet" };
  const smoke = `
    import { ApiRequestError, QsbClient, loopbackTestSigner, nodeQsb, preparedDepositSchema } from "${name}";
    const exported = [ApiRequestError, QsbClient, loopbackTestSigner, nodeQsb, preparedDepositSchema].every(Boolean);
    const qsb = nodeQsb();
    const generated = await qsb.generateQsb();
    const valid = (await qsb.validateRecovery(generated.stateJson)) === generated.scriptHash;
    qsb.lockQsb();
    console.log(JSON.stringify({ exported, valid }));`;
  const result = JSON.parse(run("node", ["--input-type=module", "-e", smoke], { cwd: consumer, env }).trim().split("\n").pop());
  if (!result.exported || !result.valid) fail(`the installed SDK didn't generate and validate a vault: ${JSON.stringify(result)}`);

  // 5. The qsb bin runs, and refuses to guess a network.
  const help = run(path.join(consumer, "node_modules", ".bin", "qsb"), ["--help"], { cwd: consumer, env });
  if (!help.includes("Usage")) fail("qsb --help printed no usage");
  const { QSB_NETWORK: _omit, ...noNetwork } = process.env;
  try {
    run(path.join(consumer, "node_modules", ".bin", "qsb"), ["--help"], { cwd: consumer, env: noNetwork, stdio: "pipe" });
    fail("qsb ran without QSB_NETWORK");
  } catch (error) {
    if (error.status === 0) throw error;
  }

  // 6. The declarations resolve for a TypeScript consumer.
  writeFileSync(path.join(consumer, "use.ts"), `
    import { QsbClient, nodeQsb, type Signer } from "${name}";
    declare const signer: Signer;
    const client: QsbClient = new QsbClient({ baseUrl: "https://app.example", signer });
    void client; void nodeQsb;`);
  writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
      skipLibCheck: true, types: [], typeRoots: [path.join(root, "node_modules", "@types")] },
    files: ["use.ts"],
  }));
  run(path.join(root, "node_modules", ".bin", "tsc"), ["-p", consumer], { cwd: consumer, stdio: "pipe" });

  console.log(`SDK package check passed: ${files.length} files, ${(packed.size / 1024).toFixed(0)} KiB packed. ` +
    "Installed outside the repository, it generated and validated a vault in Pyodide, ran qsb, and type-checked.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
