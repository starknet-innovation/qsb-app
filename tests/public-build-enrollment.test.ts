import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertExperimentalUsdLimits } from "../server/runtime/activation";
import {
  enrolledSourcePaths,
  publicBuildReadPaths,
} from "../server/runtime/closure";
import { selectProofRunner } from "../server/runtime/fresh-proof";
import {
  createSourceManifest,
  writePackageTree,
} from "../server/runtime/package-release";
import {
  CPU_REFERENCE_SHA256,
  HISTORICAL_ARCHIVE_SHA256,
  HISTORICAL_SOLVER_RELEASE_SHA256,
  enrollPublicBuild,
  historicalIdentityRejected,
} from "../server/runtime/public-build-enrollment";
import { judgeEvidence, reviewGenericPath } from "../server/runtime/solver-review";
import { release } from "../src/lib/model";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("public build enrollment", () => {
  it("enrolls the recorded worker, CPU reference, supervisor, and local OCI identities", () => {
    const enrolled = enrollPublicBuild(root);
    expect(enrolled).toMatchObject({
      format: "qsb-public-build-enrollment-v1",
      identitiesEnrolled: true,
      sourceCommit: "4763c70dafa76c717f7d0a27e386523bab62049f",
      identicalArtifactRebuild: "848751c082c2b70dfd11c7542525bbd2162819dd",
      executionEnabled: false,
      certifiesCurrentTree: false,
      freshSearch: false,
      externalMinerInclusion: false,
      section6Closed: false,
      section7Closed: false,
      section8Closed: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      solverSourceMatchesRecordedLock: false,
      supervisedProfilePointsAtHistoricalWorkerDockerfile: false,
      mainnetConfigRelabeledAsRegtest: false,
    });
    expect(release.mainnetEnabled).toBe(false);
    expect(enrolled.worker).toMatchObject({
      binarySha256:
        "6d46cec4ddfebeb94993a9aad26a8506668b7b23b6d2d3f0214a6a77272586d6",
      solverReleaseSha256:
        "cfa5e15772e1d6764d707d6c9bd7c1bcd9b8ec9cfbe5c800a00b384e39e35ac2",
      runtimeBindingSha256:
        "d5eab6dc14a5806e19b74a9185ab2e0e9dd909b97daef03cb13ba6f8c3ecb8a6",
      dockerfile: "worker/optimized/Dockerfile",
      historicalDockerfile: "worker/Dockerfile",
      selectedByHistoricalWorkerDockerfile: false,
      imageDigest: null,
    });
    expect(enrolled.cpuReference.files).toEqual(CPU_REFERENCE_SHA256);
    expect(enrolled.cpuReference.matchesTree).toBe(true);
    expect(enrolled.cpuReference.historicalCpuVerifierEnrolled).toBe(false);
    expect(enrolled.supervisor).toMatchObject({
      archiveSha256:
        "4ed13bb96e5ce5118e2cddd0b895a73b3d33d90e4dbd2ce90e4c32641f4128eb",
      manifestSha256:
        "2f389c54d15a1a30644fe8cbaca58e52ee0b1b1f8b6fb2b7bc77b44f2544635a",
      executionEnabled: false,
      sourceManifestMatchesTree: false,
      packageLockMatchesTree: true,
      historicalArchiveUsed: false,
    });
    expect(enrolled.oci).toMatchObject({
      localLayoutIndexDigest:
        "sha256:6ff70536dc098dc1c367497b7af05d0c592c771728ba6e7d94348aa759d1d894",
      platform: "linux/amd64",
      registryManifestPushed: false,
      registryManifestDigest: null,
      worker: {
        configDigest:
          "sha256:7cf180dcbac578788d3bd464ae3e2167c0e66bac6cbe7335746d58d99dc5c6e5",
        manifestDigest:
          "sha256:bdf6efba3723a7c0f458d3d22561a109b30801d8321412b79a94f57d1388eb73",
      },
      queue: {
        configDigest:
          "sha256:642721810b2fd603311f138b11d3d61464f6a2184d04cc7fd2f26f4b7a0ef931",
        manifestDigest:
          "sha256:a1bb64af3be57be1e7aa77afd2f6e9e29e880edf4ac73200902f47bde98ec421",
      },
    });
    expect(enrolled.oci.worker.configDigest.startsWith("sha256:")).toBe(true);
    expect(enrolled.worker.binarySha256.startsWith("sha256:")).toBe(false);
    expect([...enrolled.divergedFromRecordedLock]).toEqual([
      "research/optimized-subset/subset/tests/gpu_epochs/pair_shared.cuh",
      "research/optimized-subset/subset/tests/gpu_epochs/tree.cu",
    ]);
    expect(historicalIdentityRejected(HISTORICAL_ARCHIVE_SHA256)).toBe(true);
    expect(historicalIdentityRejected(enrolled.supervisor.archiveSha256)).toBe(
      false,
    );
    expect(enrolled.worker.solverReleaseSha256).not.toBe(
      HISTORICAL_SOLVER_RELEASE_SHA256,
    );
  });

  it("does not treat enrollment as coverage, a regtest runner, or a USD spend check", () => {
    const enrolled = enrollPublicBuild(root);
    const review = reviewGenericPath(root);
    expect(
      judgeEvidence(review, {
        kind: "native-binary",
        sourceSha256: review.sourceSha256,
        nativeBinarySha256: enrolled.worker.binarySha256,
      }),
    ).toEqual({ accepted: false, reason: "hold-binary-unenrolled" });
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: {
          format: "qsb-proof-service-config-v1",
          serviceId: "mainnet-service",
          configuredChain: "mainnet",
          mainnetOnly: true,
          releaseProfileId: "qsb-supervised-pin-v4-subset-v5",
          sourceManifestSha256: "a".repeat(64),
          nativeBinariesEnrolled: false,
          mainnetEnabled: false,
          broadcastAuthorized: false,
        },
        enrolled: {
          profileId: "qsb-supervised-pin-v4-subset-v5",
          sourceManifestSha256: "a".repeat(64),
          nativeBinariesEnrolled: false,
          mainnetEnabled: false,
          broadcastAuthorized: false,
        },
      }),
    ).toThrow("MainnetConfigRelabeledAsRegtest");
    expect(() =>
      assertExperimentalUsdLimits({ vaultUsd: 1, feeUsd: 1, gpuUsd: 1 }),
    ).toThrow("UsdLimitCheckClosed");
  });

  it("rejects an extra solver file even when every locked file matches", () => {
    const directory = materializeEnrollmentTree();
    try {
      for (const [relativePath, fixture] of [
        [
          "research/optimized-subset/subset/tests/gpu_epochs/pair_shared.cuh",
          "tests/fixtures/public-build-4763c70/pair_shared.cuh",
        ],
        [
          "research/optimized-subset/subset/tests/gpu_epochs/tree.cu",
          "tests/fixtures/public-build-4763c70/tree.cu",
        ],
      ] as const) {
        writeFileSync(
          path.join(directory, relativePath),
          readFileSync(path.join(root, fixture)),
        );
      }
      const extra = "research/optimized-subset/subset/tests/gpu_epochs/extra_header.cuh";
      writeFileSync(path.join(directory, extra), "extra solver source\n");
      const enrolled = enrollPublicBuild(directory);
      expect(enrolled.solverSourceMatchesRecordedLock).toBe(false);
      expect([...enrolled.divergedFromRecordedLock]).toEqual([extra]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects optimized Dockerfile strings that are only a comment or an unused stage", () => {
    const lock = JSON.parse(
      readFileSync(path.join(root, "worker/optimized/source-lock.json"), "utf8"),
    ) as { buildBase: string; runtimeBase: string };
    const decoy = [
      `# FROM ${lock.buildBase} AS build`,
      "# COPY research/optimized-subset /src/research/optimized-subset",
      `# FROM ${lock.runtimeBase} AS runtime`,
      `FROM ${lock.buildBase} AS unused`,
      "COPY research/optimized-subset /src/research/optimized-subset",
      `FROM ${lock.runtimeBase} AS also-unused`,
      "FROM alpine:3 AS build",
      "COPY worker/optimized/build.py /src/worker/optimized/build.py",
      "FROM alpine:3 AS runtime",
      "COPY --from=build /opt/qsb-validation /opt/qsb-validation",
      "FROM runtime AS queue",
      "",
    ].join("\n");
    const commented = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(commented, "worker/optimized/Dockerfile"), decoy);
      expect(() => enrollPublicBuild(commented)).toThrow(
        "PublicBuildBaseImageMismatch",
      );
    } finally {
      rmSync(commented, { recursive: true, force: true });
    }
    const unusedCopy = [
      `FROM ${lock.buildBase} AS build`,
      "COPY worker/optimized/build.py /src/worker/optimized/build.py",
      "# COPY research/optimized-subset /src/research/optimized-subset",
      `FROM ${lock.buildBase} AS unused`,
      "COPY research/optimized-subset /src/research/optimized-subset",
      `FROM ${lock.runtimeBase} AS runtime`,
      "COPY --from=build /opt/qsb-validation /opt/qsb-validation",
      "FROM runtime AS queue",
      "",
    ].join("\n");
    const copied = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(copied, "worker/optimized/Dockerfile"), unusedCopy);
      expect(() => enrollPublicBuild(copied)).toThrow(
        "PublicBuildDockerfileMissingSolver",
      );
    } finally {
      rmSync(copied, { recursive: true, force: true });
    }
    const stillValid = materializeEnrollmentTree();
    try {
      const original = readFileSync(
        path.join(root, "worker/optimized/Dockerfile"),
        "utf8",
      );
      writeFileSync(
        path.join(stillValid, "worker/optimized/Dockerfile"),
        `# FROM ${lock.buildBase}\n# COPY research/optimized-subset /tmp/comment\n${original}`,
      );
      expect(enrollPublicBuild(stillValid).worker.dockerfile).toBe(
        "worker/optimized/Dockerfile",
      );
    } finally {
      rmSync(stillValid, { recursive: true, force: true });
    }
  });

  it("rejects symlinks that resolve outside the enrollment root", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "qsb-enroll-outside-"));
    const directory = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(outside, "runtime.py"), "outside\n");
      rmSync(path.join(directory, "worker/optimized/runtime.py"));
      symlinkSync(
        path.join(outside, "runtime.py"),
        path.join(directory, "worker/optimized/runtime.py"),
      );
      expect(() => enrollPublicBuild(directory)).toThrow("PublicBuildPathEscapes");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
    const externalSubset = mkdtempSync(path.join(tmpdir(), "qsb-enroll-subset-"));
    const linked = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(externalSubset, "extra.cu"), "outside solver\n");
      rmSync(path.join(linked, "research/optimized-subset/subset"), {
        recursive: true,
      });
      symlinkSync(
        externalSubset,
        path.join(linked, "research/optimized-subset/subset"),
      );
      expect(() => enrollPublicBuild(linked)).toThrow("PublicBuildPathEscapes");
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(externalSubset, { recursive: true, force: true });
    }
  });

  it("rejects a disconnected queue stage and a decoy build stage", () => {
    const lock = JSON.parse(
      readFileSync(path.join(root, "worker/optimized/source-lock.json"), "utf8"),
    ) as { buildBase: string; runtimeBase: string };
    const disconnected = [
      `FROM ${lock.buildBase} AS build`,
      "COPY research/optimized-subset /src/research/optimized-subset",
      `FROM ${lock.runtimeBase} AS runtime`,
      "COPY --from=build /opt/qsb-validation /opt/qsb-validation",
      "FROM alpine:3 AS queue",
      "COPY --from=runtime /opt/qsb-validation /opt/qsb-validation",
      "",
    ].join("\n");
    const directory = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(directory, "worker/optimized/Dockerfile"), disconnected);
      expect(() => enrollPublicBuild(directory)).toThrow(
        "PublicBuildBaseImageMismatch",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const decoy = [
      "FROM alpine:3 AS build",
      "COPY worker/optimized/build.py /src/worker/optimized/build.py",
      `FROM ${lock.buildBase} AS decoy`,
      "COPY research/optimized-subset /src/research/optimized-subset",
      `FROM ${lock.runtimeBase} AS runtime`,
      "COPY --from=build /opt/qsb-validation /opt/qsb-validation",
      "COPY --from=decoy /src/research/optimized-subset /tmp/decoy",
      "FROM runtime AS queue",
      "",
    ].join("\n");
    const decoyTree = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(decoyTree, "worker/optimized/Dockerfile"), decoy);
      expect(() => enrollPublicBuild(decoyTree)).toThrow(
        "PublicBuildBaseImageMismatch",
      );
    } finally {
      rmSync(decoyTree, { recursive: true, force: true });
    }
  });

  it("rejects a routing file that keeps the historical profile id only in a comment", () => {
    const relativePath =
      "supervised/runtime/source/work/yukon-app-routing-20260923/routing.ts";
    const original = readFileSync(path.join(root, relativePath), "utf8");
    const retargeted = [
      `// qsb-supervised-pin-v4-subset-v5 ${HISTORICAL_SOLVER_RELEASE_SHA256}`,
      original.replace(HISTORICAL_SOLVER_RELEASE_SHA256, "a".repeat(64)),
      "",
    ].join("\n");
    expect(retargeted).toContain("qsb-supervised-pin-v4-subset-v5");
    expect(retargeted).toContain(HISTORICAL_SOLVER_RELEASE_SHA256);
    const directory = materializeEnrollmentTree();
    try {
      writeFileSync(path.join(directory, relativePath), retargeted);
      expect(() => enrollPublicBuild(directory)).toThrow(
        "SupervisedProfileRetargeted",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enrolls from the packaged tree that includes the runtime-read inputs", () => {
    const manifest = createSourceManifest(root);
    for (const relativePath of publicBuildReadPaths) {
      expect(enrolledSourcePaths(root)).toContain(relativePath);
      expect(manifest.identities.sourceFiles[relativePath]).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(manifest.identities.components["public-build"]).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-enroll-package-"));
    try {
      writePackageTree(root, directory, manifest);
      const tree = path.join(directory, "tree");
      expect(() => enrollPublicBuild(tree)).not.toThrow();
      const enrolled = enrollPublicBuild(tree);
      expect(enrolled.identitiesEnrolled).toBe(true);
      expect(enrolled.executionEnabled).toBe(false);
      expect(enrolled.mainnetEnabled).toBe(false);
      expect(enrolled.broadcastAuthorized).toBe(false);
      rmSync(path.join(tree, "worker/optimized/runtime.py"));
      expect(() => enrollPublicBuild(tree)).toThrow(
        "PublicBuildMissing:worker/optimized/runtime.py",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const enrollmentInputs = [
  "docs/source-build/20260924/solver-build-receipt.json",
  "worker/optimized/source-lock.json",
  "worker/optimized/runtime.py",
  "worker/optimized/Dockerfile",
  "worker/Dockerfile",
  "package-lock.json",
  "supervised/runtime/source-manifest.json",
  "supervised/archive/work/yukon-app-routing-20260923/routing.ts",
  "supervised/runtime/source/work/yukon-app-routing-20260923/routing.ts",
  ...Object.keys(CPU_REFERENCE_SHA256).map(
    (name) => `worker/optimized/${name}`,
  ),
];

function materializeEnrollmentTree(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "qsb-enroll-"));
  for (const relativePath of enrollmentInputs) {
    const destination = path.join(directory, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, relativePath), destination);
  }
  cpSync(
    path.join(root, "research/optimized-subset/subset"),
    path.join(directory, "research/optimized-subset/subset"),
    { recursive: true },
  );
  return directory;
}
