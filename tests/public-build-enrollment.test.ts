import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertExperimentalUsdLimits } from "../server/runtime/activation";
import { selectProofRunner } from "../server/runtime/fresh-proof";
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
});
