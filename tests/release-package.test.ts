import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enrolledSourcePaths, historicalVendorExtras } from "../server/runtime/closure";
import archivedRelease from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import { assertInsideRepo, certifyWrapper, sha256Hex } from "../server/runtime/identity";
import {
  assertCompatibleStages,
  componentIdentities,
  createSourceManifest,
  enrollHistoricalPair,
  nodeRequirementFromReadme,
  recordedManifestPath,
  serializeManifest,
  verifyPackageTree,
  writePackageTree,
} from "../server/runtime/package-release";

const root = process.cwd();

describe("source release package", () => {
  it("matches the committed manifest and keeps native and OCI identities unproduced", () => {
    const manifest = createSourceManifest(root);
    const committed = JSON.parse(
      readFileSync(path.join(root, "release/source-manifest.json"), "utf8"),
    );
    expect(manifest).toEqual(committed);
    expect(serializeManifest(manifest)).toBe(
      readFileSync(path.join(root, "release/source-manifest.json"), "utf8"),
    );
    assertCompatibleStages(manifest);
    expect(manifest.mainnetEnabled).toBe(false);
    expect(manifest.broadcastAuthorized).toBe(false);
    expect(manifest.sourceCommit).toEqual({
      status: "unbound",
      value: null,
      reason: expect.stringContaining("does not invent a commit"),
    });
    expect(manifest.releases.optimizedSubset.selectedByWorkerDockerfile).toBe(
      false,
    );
    expect(manifest.releases.optimizedSubset.replacesSolverPipeline).toBe(false);
    expect(manifest.releases.pinning.compatiblePipelinePartner).toBe(
      "historicalSubset",
    );
    expect(manifest.releases.historicalSubset.compatiblePipelinePartner).toBe(
      "pinning",
    );
    expect(manifest.identities.nativeBinaries.pinning.value).toBeNull();
    expect(manifest.identities.nativeBinaries.historicalSubset.value).toBeNull();
    expect(manifest.identities.nativeBinaries.optimizedSubset.value).toBeNull();
    expect(manifest.identities.imageConfig.value).toBeNull();
    expect(manifest.identities.ociIndex.value).toBeNull();
    expect(manifest.identities.registryManifest.value).toBeNull();
    expect(manifest.identities.registryManifest.placeholderIsDeployable).toBe(
      false,
    );
    expect(manifest.identities.registryManifest.historicalPlaceholder).toContain(
      "000000000000.dkr.ecr",
    );
    expect(manifest.buildInputs.imageBuildStatus).toBe("not-produced");
    expect(manifest.buildInputs.node).toBe(">=22");
    expect(manifest.buildInputs.nodeSource).toBe("README.md");
    expect(manifest.identities.sourceFiles["README.md"]).toMatch(/^[a-f0-9]{64}$/);
    const packagedScripts = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).scripts as Record<string, string>;
    expect(packagedScripts["build:runtime"]).toContain("supervised/build.mjs");
    const directoryForScripts = mkdtempSync(path.join(tmpdir(), "qsb-scripts-"));
    writePackageTree(root, directoryForScripts, manifest);
    const packaged = JSON.parse(
      readFileSync(path.join(directoryForScripts, "tree/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packaged.scripts["build:runtime"]).toBeUndefined();
    expect(packaged.scripts["build:optimized"]).toBeUndefined();
    expect(packaged.scripts.dev).toBeUndefined();
    expect(packaged.scripts.build).toBeUndefined();
    expect(packaged.scripts.test).toBeUndefined();
    expect(packaged.scripts["test:e2e"]).toBeUndefined();
    expect(packaged.scripts.typecheck).toBeUndefined();
    expect(packaged.scripts.vendor).toBeUndefined();
    expect(Object.keys(packaged.scripts)).toEqual([
      "package:release",
      "inventory:storage",
    ]);
    expect(packaged.scripts["package:release"]).toContain("package-release");
    expect(packaged.scripts["inventory:storage"]).toContain("storage-inventory");
    const packagedReadme = readFileSync(
      path.join(directoryForScripts, "tree/README.md"),
      "utf8",
    );
    expect(packagedReadme).toContain("Requires Node.js 22 or newer");
    expect(packagedReadme).toContain("npm run package:release -- --check");
    expect(packagedReadme).toContain("../release-manifest.json");
    expect(packagedReadme).not.toContain("npm run dev");
    expect(packagedReadme).not.toContain("npm run vendor");
    expect(packagedReadme).not.toContain("npm run build:runtime");
    expect(existsSync(path.join(directoryForScripts, "tree/release/source-manifest.json"))).toBe(
      false,
    );
    expect(recordedManifestPath(path.join(directoryForScripts, "tree"))).toBe(
      path.join(directoryForScripts, "release-manifest.json"),
    );
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(directoryForScripts, "tree/node_modules"),
      "dir",
    );
    expect(
      execFileSync(
        process.execPath,
        [
          path.join(root, "node_modules/tsx/dist/cli.mjs"),
          "scripts/package-release.ts",
          "--check",
        ],
        { cwd: path.join(directoryForScripts, "tree"), encoding: "utf8" },
      ),
    ).toContain("matches this checkout");
    expect(manifest.buildInputs.dockerfileFlags.pinning).toEqual([
      "-O3",
      "-arch=sm_${CUDA_ARCH}",
      "-DQSB_SLOTPIPE=0",
    ]);
    expect(manifest.buildInputs.defaultArchFlags.historicalSubset).toContain(
      "-arch=sm_89",
    );
    const dockerfile = readFileSync(path.join(root, "worker/Dockerfile"), "utf8");
    expect(dockerfile).toContain("vendor/challenge/candidates");
    expect(dockerfile).not.toMatch(
      /^\s*(?:COPY|ADD)\s+\S*research\/optimized-subset/m,
    );
    expect(
      certifyWrapper(
        {
          wrapperSha256: manifest.identities.sourceFiles["worker/handler.py"] ?? "",
          nativeSha256: manifest.identities.nativeBinaries.pinning.value,
        },
        {
          wrapperBytes: readFileSync(path.join(root, "worker/handler.py")),
          nativeSha256: "cd".repeat(32),
        },
      ),
    ).toEqual({ ok: false, reason: "native-not-enrolled" });
  });

  it("rejects a modified wrapper even when the native hash is unchanged", () => {
    const manifest = createSourceManifest(root);
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-release-"));
    writePackageTree(root, directory, manifest);
    expect(verifyPackageTree(directory).format).toBe(
      "qsb-source-release-manifest-v1",
    );
    const wrapper = path.join(directory, "tree/worker/handler.py");
    const enrolled = {
      wrapperSha256: sha256Hex(readFileSync(wrapper)),
      nativeSha256: "ab".repeat(32),
    };
    writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}\n# wrapper changed\n`);
    expect(() => verifyPackageTree(directory)).toThrow(/enrolled identity/);
    expect(
      certifyWrapper(enrolled, {
        wrapperBytes: readFileSync(wrapper),
        nativeSha256: enrolled.nativeSha256,
      }),
    ).toEqual({ ok: false, reason: "wrapper-changed" });
  });

  it("enrolls the local import closure and build metadata", () => {
    const manifest = createSourceManifest(root);
    const paths = enrolledSourcePaths(root);
    for (const relativePath of [
      "src/mainnet/assembly.ts",
      "src/mainnet/chain.ts",
      "src/mainnet/finalizer.ts",
      "src/lib/api.ts",
      "src/lib/session.ts",
      "src/lib/backup.ts",
      "src/lib/qsb.ts",
      "src/lib/qsb-worker.ts",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ]) {
      expect(paths).toContain(relativePath);
      expect(manifest.identities.sourceFiles[relativePath]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifest.releases.pinning.sourcesEnrolled).toBe(true);
    expect(manifest.releases.historicalSubset.sourcesEnrolled).toBe(true);
    expect(manifest.identities.sourceFiles["vendor/challenge/candidates/pinning/pinning.cu"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(manifest.identities.sourceFiles["vendor/challenge/candidates/subset/subset.cu"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("packages the Dockerfile historical inputs and checks the tree inside the checkout", () => {
    const manifest = createSourceManifest(root);
    const archivedHashes = archivedRelease.sourceHashes as Record<string, string>;
    expect(archivedRelease.id).toBe("qsb-config-a-ranked-v2-2791ed0");
    for (const [relativePath, digest] of Object.entries(historicalVendorExtras)) {
      expect(archivedHashes[relativePath]).toBeUndefined();
      expect(manifest.identities.sourceFiles[relativePath]).toBe(digest);
    }
    for (const relativePath of [
      "vendor/challenge/candidates/pinning/pinning.cu",
      "vendor/challenge/candidates/subset/subset.cu",
    ]) {
      expect(manifest.identities.sourceFiles[relativePath]).toBe(archivedHashes[relativePath]);
    }
    const directory = path.join(root, "release/dist");
    writePackageTree(root, directory, manifest);
    const tree = path.join(directory, "tree");
    for (const relativePath of [
      "vendor/challenge/candidates/pinning/pinning.cu",
      "vendor/challenge/candidates/subset/subset.cu",
      "vendor/challenge/candidates/pinning/COPYING",
      "vendor/challenge/candidates/subset/COPYING",
    ]) {
      expect(existsSync(path.join(tree, relativePath))).toBe(true);
    }
    const modules = path.join(tree, "node_modules");
    symlinkSync(path.join(root, "node_modules"), modules, "dir");
    try {
      expect(
        execFileSync(
          process.execPath,
          [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/package-release.ts", "--check"],
          { cwd: tree, encoding: "utf8" },
        ),
      ).toContain("matches this checkout");
    } finally {
      rmSync(modules, { force: true });
    }
    const extra = path.join(root, "vendor/challenge/candidates/pinning/local-notes.txt");
    writeFileSync(extra, "not allowlisted\n");
    try {
      expect(() => createSourceManifest(root)).toThrow(/Unexpected release input/);
    } finally {
      rmSync(extra, { force: true });
    }
  });

  it("rejects an untracked optimized file and leaves ignored files out", () => {
    const unexpected = path.join(root, "research/optimized-subset/local-notes.txt");
    writeFileSync(unexpected, "not tracked\n");
    try {
      expect(() => createSourceManifest(root)).toThrow(/Unexpected release input/);
    } finally {
      rmSync(unexpected, { force: true });
    }
    const ignored = path.join(root, "research/optimized-subset/.env");
    writeFileSync(ignored, "SECRET=not-enrolled\n");
    try {
      const manifest = createSourceManifest(root);
      expect(manifest.identities.sourceFiles["research/optimized-subset/.env"]).toBeUndefined();
      expect(
        manifest.identities.sourceFiles["vendor/challenge/candidates/pinning/pinning.cu"],
      ).toMatch(/^[a-f0-9]{64}$/);
      expect(
        Object.keys(manifest.identities.sourceFiles).some(
          (relativePath) =>
            relativePath.includes("__pycache__") || relativePath.endsWith(".pyc"),
        ),
      ).toBe(false);
    } finally {
      rmSync(ignored, { force: true });
    }
  });

  it("requires both historical candidate roots", () => {
    expect(enrollHistoricalPair(["a"], ["b"])).toEqual({
      pinning: true,
      historicalSubset: true,
    });
    expect(() => enrollHistoricalPair([], [])).toThrow(
      /HistoricalCandidatePairIncomplete/,
    );
    expect(() => enrollHistoricalPair(["a"], [])).toThrow(
      /HistoricalCandidatePairIncomplete/,
    );
    expect(() => enrollHistoricalPair([], ["b"])).toThrow(
      /HistoricalCandidatePairIncomplete/,
    );
  });

  it("rejects extra tree files and unproduced native identities", () => {
    const manifest = createSourceManifest(root);
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-release-"));
    writePackageTree(root, directory, manifest);
    const extra = path.join(directory, "tree/stale-injected.txt");
    writeFileSync(extra, "not enrolled\n");
    expect(() => verifyPackageTree(directory)).toThrow(/path set/);
    writePackageTree(root, directory, manifest);
    expect(existsSync(extra)).toBe(false);
    expect(verifyPackageTree(directory).format).toBe(
      "qsb-source-release-manifest-v1",
    );
    const manifestPath = path.join(directory, "release-manifest.json");
    const forged = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      identities: {
        nativeBinaries: {
          historicalSubset: { value: string | null; status: string };
          optimizedSubset: { value: string | null; status: string };
        };
      };
    };
    forged.identities.nativeBinaries.historicalSubset.value = "ab".repeat(32);
    forged.identities.nativeBinaries.historicalSubset.status = "produced";
    writeFileSync(manifestPath, JSON.stringify(forged));
    expect(() => verifyPackageTree(directory)).toThrow(/nativeBinaries/);
    forged.identities.nativeBinaries.historicalSubset.value = null;
    forged.identities.nativeBinaries.historicalSubset.status = "not-produced";
    forged.identities.nativeBinaries.optimizedSubset.value = "cd".repeat(32);
    writeFileSync(manifestPath, JSON.stringify(forged));
    expect(() => verifyPackageTree(directory)).toThrow(/nativeBinaries/);
    writePackageTree(root, directory, manifest);
    const bytecode = path.join(directory, "tree/injected/__pycache__/stale.pyc");
    mkdirSync(path.dirname(bytecode), { recursive: true });
    writeFileSync(bytecode, "bytecode");
    expect(() => verifyPackageTree(directory)).toThrow(/path set/);
    writePackageTree(root, directory, manifest);
    const manifestPathAgain = path.join(directory, "release-manifest.json");
    const components = JSON.parse(readFileSync(manifestPathAgain, "utf8")) as {
      format: string;
      identities: { components: Record<string, string> };
    };
    components.identities.components.api = "ab".repeat(32);
    writeFileSync(manifestPathAgain, JSON.stringify(components));
    expect(() => verifyPackageTree(directory)).toThrow(/component/);
    components.identities.components.api =
      manifest.identities.components.api ?? "";
    components.format = "qsb-other";
    writeFileSync(manifestPathAgain, JSON.stringify(components));
    expect(() => verifyPackageTree(directory)).toThrow(/format/);
    writePackageTree(root, directory, manifest);
    const derived = JSON.parse(readFileSync(manifestPathAgain, "utf8")) as {
      sourceCommit: { status: string; value: string | null };
      buildInputs: { images: { build: string } };
      releases: { pinning: { sourcesEnrolled: boolean } };
    };
    derived.sourceCommit = { status: "bound", value: "ab".repeat(32) };
    writeFileSync(manifestPathAgain, JSON.stringify(derived));
    expect(() => verifyPackageTree(directory)).toThrow();
    writePackageTree(root, directory, manifest);
    const images = JSON.parse(readFileSync(manifestPathAgain, "utf8")) as {
      buildInputs: { images: { build: string } };
    };
    images.buildInputs.images.build = "forged.example/image:latest";
    writeFileSync(manifestPathAgain, JSON.stringify(images));
    expect(() => verifyPackageTree(directory)).toThrow(/build inputs/);
    writePackageTree(root, directory, manifest);
    const incompletePath = path.join(directory, "release-manifest.json");
    const incomplete = JSON.parse(readFileSync(incompletePath, "utf8")) as {
      identities: { sourceFiles: Record<string, string>; components: Record<string, string> };
    };
    delete incomplete.identities.sourceFiles["server/runtime/dispatcher.ts"];
    incomplete.identities.components = componentIdentities(incomplete.identities.sourceFiles);
    rmSync(path.join(directory, "tree/server/runtime/dispatcher.ts"));
    writeFileSync(incompletePath, JSON.stringify(incomplete));
    expect(() => verifyPackageTree(directory)).toThrow(/Missing release input/);
  });

  it("rejects a packaged README whose Node requirement changed", () => {
    const manifest = createSourceManifest(root);
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-readme-"));
    writePackageTree(root, directory, manifest);
    const readme = path.join(directory, "tree/README.md");
    writeFileSync(
      readme,
      readFileSync(readme, "utf8").replace("Node.js 22", "Node.js 18"),
    );
    expect(() => verifyPackageTree(directory)).toThrow(
      /enrolled identity: README.md/,
    );
    expect(() => nodeRequirementFromReadme("Requires Node.js 18 or newer")).toThrow(
      /README Node requirement is not enrolled/,
    );
  });

  it("refuses release paths outside this checkout", () => {
    expect(() => assertInsideRepo(root, "../etc/passwd")).toThrow(
      /escapes the checkout/,
    );
    expect(() => assertInsideRepo(root, "/etc/passwd")).toThrow(
      /escapes the checkout/,
    );
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-link-"));
    const outside = mkdtempSync(path.join(tmpdir(), "qsb-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "outside\n");
      mkdirSync(path.join(directory, "nested"));
      symlinkSync(outside, path.join(directory, "nested", "alias"));
      expect(() => assertInsideRepo(directory, "nested/alias/secret.txt")).toThrow(
        /escapes the checkout/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
