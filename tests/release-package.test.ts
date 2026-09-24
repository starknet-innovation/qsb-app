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
import { enrolledSourcePaths } from "../server/runtime/closure";
import { assertInsideRepo, certifyWrapper, sha256Hex } from "../server/runtime/identity";
import {
  assertCompatibleStages,
  createSourceManifest,
  enrollHistoricalPair,
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
    expect(
      Object.keys(manifest.identities.sourceFiles).some(
        (relativePath) =>
          relativePath.includes("__pycache__") || relativePath.endsWith(".pyc"),
      ),
    ).toBe(false);
  });

  it("requires both historical candidate roots", () => {
    expect(enrollHistoricalPair(["a"], ["b"])).toEqual({
      pinning: true,
      historicalSubset: true,
    });
    expect(enrollHistoricalPair([], [])).toEqual({
      pinning: false,
      historicalSubset: false,
    });
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
    expect(() => verifyPackageTree(directory)).toThrow(/did not produce/);
    forged.identities.nativeBinaries.historicalSubset.value = null;
    forged.identities.nativeBinaries.historicalSubset.status = "not-produced";
    forged.identities.nativeBinaries.optimizedSubset.value = "cd".repeat(32);
    writeFileSync(manifestPath, JSON.stringify(forged));
    expect(() => verifyPackageTree(directory)).toThrow(/did not produce/);
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
