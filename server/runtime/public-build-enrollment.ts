import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import capability from "../mainnet-capability.json";
import { release } from "../../src/lib/model";
import { sha256Hex } from "./identity";
import { parseWorkerDockerfile } from "./package-release";

/**
 * Reviewed identities of the public source build. The build receipt stays
 * HOLD. This record enrolls those identities and does not enable execution,
 * mainnet, or broadcast.
 *
 * The solver binary and supervisor archive were produced from
 * 4763c70dafa76c717f7d0a27e386523bab62049f. Commit
 * 848751c082c2b70dfd11c7542525bbd2162819dd changed only the workflow and
 * rebuilt the same archive, manifest, and receipt. Later gate commits are
 * not that build.
 */

const RECEIPT_PATH = "docs/source-build/20260924/solver-build-receipt.json";
const SOURCE_LOCK_PATH = "worker/optimized/source-lock.json";
const OPTIMIZED_DOCKERFILE = "worker/optimized/Dockerfile";
const HISTORICAL_DOCKERFILE = "worker/Dockerfile";
const OPTIMIZED_SOURCE = "research/optimized-subset";
const SUPERVISOR_SOURCE_MANIFEST = "supervised/runtime/source-manifest.json";
const PACKAGE_LOCK = "package-lock.json";

const ROUTING_FILES = [
  "supervised/archive/work/yukon-app-routing-20260923/routing.ts",
  "supervised/runtime/source/work/yukon-app-routing-20260923/routing.ts",
] as const;

export const PUBLIC_BUILD_SOURCE_COMMIT =
  "4763c70dafa76c717f7d0a27e386523bab62049f";
export const PUBLIC_BUILD_REBUILD_COMMIT =
  "848751c082c2b70dfd11c7542525bbd2162819dd";

export const HISTORICAL_ARCHIVE_SHA256 =
  "18421ac06c8834dae064b0cc3cef7fdf7344e96fadbed1cf201020905f43ff2f";
export const HISTORICAL_SOLVER_RELEASE_SHA256 =
  "966136928aca1b7546275599a0462a1870c92b2a8d184391967a250bb16d9291";
export const HISTORICAL_RUNTIME_SHA256 =
  "14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9";
export const HISTORICAL_IMAGE_DIGEST =
  "6c0ba190306cfe78307aca4dd287b4c43b3ce92a2ab78050d7024adf44967abc";

const RECEIPT_SHA256 =
  "1e243370561b16c7d2c1d9be68e756fe39fbea44167f0e70d8507d1a14dfc160";
const WORKER_BINARY_SHA256 =
  "6d46cec4ddfebeb94993a9aad26a8506668b7b23b6d2d3f0214a6a77272586d6";
const SOLVER_RELEASE_SHA256 =
  "cfa5e15772e1d6764d707d6c9bd7c1bcd9b8ec9cfbe5c800a00b384e39e35ac2";
const RUNTIME_BINDING_SHA256 =
  "d5eab6dc14a5806e19b74a9185ab2e0e9dd909b97daef03cb13ba6f8c3ecb8a6";
const SOURCE_LOCK_SHA256 =
  "922e6a8574b9120660db5dafdb0dc97fa27106594605f9f1cf7a15173a0e1c93";
const RUNTIME_PY_SHA256 =
  "67ad95b23d055c625e204170024eea1539cbd0f59a2017af858789447090a6f0";

/** Public CPU reference bound by the worker runtime-binding, not worker/cpu. */
export const CPU_REFERENCE_SHA256 = {
  "reference/bitcoin_tx.py":
    "c7e52af90bd0d9fce9834fce26dcd67aee0d7751ee228d9730873c4d12659a5c",
  "reference/gpu_emulator.py":
    "449312593576ec4e59d8abe1b2f601d9c2d74d58c99dfe88924442a6cab4e896",
  "reference/handler.py":
    "d08b7e530d2c140021bfeb645d229f8bb37e2c0f88100cdbe79b03432026a5c1",
  "reference/qsb_pipeline.py":
    "05334c08fa012a77ccba2887e05d78f90a8b81c0e34b786931b423f7f11255d8",
  "reference/secp256k1.py":
    "d2cebd1410b75cad606806cf02d7bee3e24724d5fcb7a53a07f598fcbc8afece",
  "reference/verify_hit.py":
    "9f9e60952db15c054871403b60266d04c50d012e882bcd52a30f4bd3ba831fba",
} as const;

const SUPERVISOR_ARCHIVE_SHA256 =
  "4ed13bb96e5ce5118e2cddd0b895a73b3d33d90e4dbd2ce90e4c32641f4128eb";
const SUPERVISOR_MANIFEST_SHA256 =
  "2f389c54d15a1a30644fe8cbaca58e52ee0b1b1f8b6fb2b7bc77b44f2544635a";
const SUPERVISOR_EMBEDDED_SOURCE_MANIFEST_SHA256 =
  "2853e0a0298bb898178b953c9dea1d40686ae1567e08f7086b960705b591c0d2";
const SUPERVISOR_PACKAGE_LOCK_SHA256 =
  "633d302ec95b0e175ba1bf9d24ee827b93b27c33910b76ca434b99c783754e4b";

const BUILD_BASE =
  "nvidia/cuda:12.8.1-devel-ubuntu22.04@sha256:6617a625f4090c76c545a0e7d63f2e441718ef9af7f4efe7dd1242a29e289fd7";
const RUNTIME_BASE =
  "nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:fcbbd60a5ad3db3a1c7375bf14546b369b54064c513224310b2026df50c7a9bd";

/** Local OCI layout of the unpushed docker save. Not a registry manifest. */
const OCI_INDEX_DIGEST =
  "sha256:6ff70536dc098dc1c367497b7af05d0c592c771728ba6e7d94348aa759d1d894";
const WORKER_CONFIG_DIGEST =
  "sha256:7cf180dcbac578788d3bd464ae3e2167c0e66bac6cbe7335746d58d99dc5c6e5";
const WORKER_MANIFEST_DIGEST =
  "sha256:bdf6efba3723a7c0f458d3d22561a109b30801d8321412b79a94f57d1388eb73";
const QUEUE_CONFIG_DIGEST =
  "sha256:642721810b2fd603311f138b11d3d61464f6a2184d04cc7fd2f26f4b7a0ef931";
const QUEUE_MANIFEST_DIGEST =
  "sha256:a1bb64af3be57be1e7aa77afd2f6e9e29e880edf4ac73200902f47bde98ec421";

const HISTORICAL_DIGESTS = [
  HISTORICAL_ARCHIVE_SHA256,
  HISTORICAL_SOLVER_RELEASE_SHA256,
  HISTORICAL_RUNTIME_SHA256,
  HISTORICAL_IMAGE_DIGEST,
] as const;

const receiptSchema = z
  .object({
    binarySha256: z.literal(WORKER_BINARY_SHA256),
    solverReleaseSha256: z.literal(SOLVER_RELEASE_SHA256),
    runtimeHash: z.literal(RUNTIME_BINDING_SHA256),
    sourceLockSha256: z.literal(SOURCE_LOCK_SHA256),
    status: z.literal("HOLD"),
    historicalBinaryAttestation: z.literal(false),
    flags: z.array(z.string()).min(1),
  })
  .passthrough();

const lockSchema = z
  .object({
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    flags: z.array(z.string()).min(1),
    buildBase: z.literal(BUILD_BASE),
    runtimeBase: z.literal(RUNTIME_BASE),
    status: z.literal("HOLD"),
  })
  .passthrough();

export type PublicBuildEnrollment = {
  format: "qsb-public-build-enrollment-v1";
  identitiesEnrolled: true;
  sourceCommit: typeof PUBLIC_BUILD_SOURCE_COMMIT;
  identicalArtifactRebuild: typeof PUBLIC_BUILD_REBUILD_COMMIT;
  worker: {
    binarySha256: typeof WORKER_BINARY_SHA256;
    solverReleaseSha256: typeof SOLVER_RELEASE_SHA256;
    runtimeBindingSha256: typeof RUNTIME_BINDING_SHA256;
    sourceLockSha256: typeof SOURCE_LOCK_SHA256;
    receiptSha256: typeof RECEIPT_SHA256;
    runtimePySha256: typeof RUNTIME_PY_SHA256;
    solverId: "qsb-subset-public-build-v1";
    imageDigest: null;
    dockerfile: typeof OPTIMIZED_DOCKERFILE;
    historicalDockerfile: typeof HISTORICAL_DOCKERFILE;
    selectedByHistoricalWorkerDockerfile: false;
  };
  cpuReference: {
    directory: "worker/optimized/reference";
    files: typeof CPU_REFERENCE_SHA256;
    matchesTree: true;
    historicalCpuVerifier: "worker/cpu";
    historicalCpuVerifierEnrolled: false;
  };
  supervisor: {
    archiveSha256: typeof SUPERVISOR_ARCHIVE_SHA256;
    manifestSha256: typeof SUPERVISOR_MANIFEST_SHA256;
    format: "qsb-operational-distribution-v1";
    statusAtBuild: "HOLD";
    executionEnabled: false;
    embeddedSourceManifestSha256: typeof SUPERVISOR_EMBEDDED_SOURCE_MANIFEST_SHA256;
    packageLockSha256: typeof SUPERVISOR_PACKAGE_LOCK_SHA256;
    sourceManifestMatchesTree: boolean;
    packageLockMatchesTree: boolean;
    historicalArchiveSha256: typeof HISTORICAL_ARCHIVE_SHA256;
    historicalArchiveUsed: false;
  };
  oci: {
    localLayoutIndexDigest: typeof OCI_INDEX_DIGEST;
    indexMediaType: "application/vnd.oci.image.index.v1+json";
    platform: "linux/amd64";
    worker: {
      name: "qsb-optimized:source-v1";
      configDigest: typeof WORKER_CONFIG_DIGEST;
      manifestDigest: typeof WORKER_MANIFEST_DIGEST;
    };
    queue: {
      name: "qsb-optimized-queue:source-v1";
      configDigest: typeof QUEUE_CONFIG_DIGEST;
      manifestDigest: typeof QUEUE_MANIFEST_DIGEST;
    };
    baseImages: { build: typeof BUILD_BASE; runtime: typeof RUNTIME_BASE };
    registryManifestPushed: false;
    registryManifestDigest: null;
  };
  solverSourceMatchesRecordedLock: boolean;
  divergedFromRecordedLock: readonly string[];
  executionEnabled: false;
  certifiesCurrentTree: false;
  freshSearch: false;
  externalMinerInclusion: false;
  section6Closed: false;
  section7Closed: false;
  section8Closed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  supervisedProfilePointsAtHistoricalWorkerDockerfile: false;
  mainnetConfigRelabeledAsRegtest: false;
};

function fail(code: string): never {
  throw new Error(code);
}

function readRepoFile(root: string, relativePath: string): Buffer {
  if (path.isAbsolute(relativePath) || relativePath.split("/").includes(".."))
    fail("PublicBuildPathEscapes");
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) fail(`PublicBuildMissing:${relativePath}`);
  return readFileSync(absolute);
}

export function historicalIdentityRejected(digest: string): boolean {
  const bare = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return HISTORICAL_DIGESTS.some(
    (historical) => historical === bare || historical === digest,
  );
}

function assertDistinct(digest: string): void {
  if (historicalIdentityRejected(digest)) fail("HistoricalIdentityIsNotThisBuild");
}

function solverDivergence(
  root: string,
  files: Record<string, string>,
): string[] {
  const diverged: string[] = [];
  for (const [relativeFile, expected] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const relativePath = path.posix.normalize(
      path.posix.join(OPTIMIZED_SOURCE, relativeFile),
    );
    if (
      !relativePath.startsWith(`${OPTIMIZED_SOURCE}/`) ||
      relativePath.split("/").includes("..")
    )
      fail("PublicBuildLockEscapes");
    if (sha256Hex(readRepoFile(root, relativePath)) !== expected)
      diverged.push(relativePath);
  }
  return diverged;
}

function assertOptimizedDockerfile(root: string): void {
  const text = readRepoFile(root, OPTIMIZED_DOCKERFILE).toString("utf8");
  if (!text.includes(`FROM ${BUILD_BASE}`) || !text.includes(`FROM ${RUNTIME_BASE}`))
    fail("PublicBuildBaseImageMismatch");
  if (!text.includes("COPY research/optimized-subset"))
    fail("PublicBuildDockerfileMissingSolver");
  parseWorkerDockerfile(readRepoFile(root, HISTORICAL_DOCKERFILE).toString("utf8"));
}

function assertSupervisedProfileUnmoved(root: string): void {
  const banned = [
    HISTORICAL_DOCKERFILE,
    OPTIMIZED_DOCKERFILE,
    WORKER_BINARY_SHA256,
    SOLVER_RELEASE_SHA256,
    SUPERVISOR_ARCHIVE_SHA256,
    OCI_INDEX_DIGEST,
  ];
  for (const relativePath of ROUTING_FILES) {
    const text = readRepoFile(root, relativePath).toString("utf8");
    if (!text.includes(HISTORICAL_SOLVER_RELEASE_SHA256))
      fail("SupervisedProfileMissingHistoricalPin");
    if (!text.includes("qsb-supervised-pin-v4-subset-v5"))
      fail("SupervisedProfileMissingHistoricalPin");
    if (banned.some((needle) => text.includes(needle)))
      fail("SupervisedProfileRetargeted");
  }
}

/** Enrolls the public-build identities after checking this checkout. */
export function enrollPublicBuild(root: string): PublicBuildEnrollment {
  if (release.mainnetEnabled !== false || capability.broadcastAuthorized !== false)
    fail("ActivationRefused");
  for (const digest of [
    WORKER_BINARY_SHA256,
    SOLVER_RELEASE_SHA256,
    RUNTIME_BINDING_SHA256,
    SUPERVISOR_ARCHIVE_SHA256,
    SUPERVISOR_MANIFEST_SHA256,
    WORKER_CONFIG_DIGEST,
    WORKER_MANIFEST_DIGEST,
    QUEUE_CONFIG_DIGEST,
    QUEUE_MANIFEST_DIGEST,
    OCI_INDEX_DIGEST,
    BUILD_BASE,
    RUNTIME_BASE,
  ])
    assertDistinct(digest);
  const receiptBytes = readRepoFile(root, RECEIPT_PATH);
  if (sha256Hex(receiptBytes) !== RECEIPT_SHA256) fail("PublicBuildReceiptMismatch");
  const receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const lockBytes = readRepoFile(root, SOURCE_LOCK_PATH);
  if (sha256Hex(lockBytes) !== receipt.sourceLockSha256)
    fail("PublicBuildSourceLockMismatch");
  const lock = lockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
  if (JSON.stringify(lock.flags) !== JSON.stringify(receipt.flags))
    fail("PublicBuildFlagMismatch");
  if (sha256Hex(readRepoFile(root, "worker/optimized/runtime.py")) !== RUNTIME_PY_SHA256)
    fail("CpuReferenceMismatch");
  for (const [name, expected] of Object.entries(CPU_REFERENCE_SHA256)) {
    const relativePath = `worker/optimized/${name}`;
    if (sha256Hex(readRepoFile(root, relativePath)) !== expected)
      fail("CpuReferenceMismatch");
  }
  assertOptimizedDockerfile(root);
  assertSupervisedProfileUnmoved(root);
  const sourceManifestSha256 = sha256Hex(
    readRepoFile(root, SUPERVISOR_SOURCE_MANIFEST),
  );
  const packageLockSha256 = sha256Hex(readRepoFile(root, PACKAGE_LOCK));
  const divergedFromRecordedLock = solverDivergence(root, lock.files);
  return {
    format: "qsb-public-build-enrollment-v1",
    identitiesEnrolled: true,
    sourceCommit: PUBLIC_BUILD_SOURCE_COMMIT,
    identicalArtifactRebuild: PUBLIC_BUILD_REBUILD_COMMIT,
    worker: {
      binarySha256: WORKER_BINARY_SHA256,
      solverReleaseSha256: SOLVER_RELEASE_SHA256,
      runtimeBindingSha256: RUNTIME_BINDING_SHA256,
      sourceLockSha256: SOURCE_LOCK_SHA256,
      receiptSha256: RECEIPT_SHA256,
      runtimePySha256: RUNTIME_PY_SHA256,
      solverId: "qsb-subset-public-build-v1",
      imageDigest: null,
      dockerfile: OPTIMIZED_DOCKERFILE,
      historicalDockerfile: HISTORICAL_DOCKERFILE,
      selectedByHistoricalWorkerDockerfile: false,
    },
    cpuReference: {
      directory: "worker/optimized/reference",
      files: CPU_REFERENCE_SHA256,
      matchesTree: true,
      historicalCpuVerifier: "worker/cpu",
      historicalCpuVerifierEnrolled: false,
    },
    supervisor: {
      archiveSha256: SUPERVISOR_ARCHIVE_SHA256,
      manifestSha256: SUPERVISOR_MANIFEST_SHA256,
      format: "qsb-operational-distribution-v1",
      statusAtBuild: "HOLD",
      executionEnabled: false,
      embeddedSourceManifestSha256: SUPERVISOR_EMBEDDED_SOURCE_MANIFEST_SHA256,
      packageLockSha256: SUPERVISOR_PACKAGE_LOCK_SHA256,
      sourceManifestMatchesTree:
        sourceManifestSha256 === SUPERVISOR_EMBEDDED_SOURCE_MANIFEST_SHA256,
      packageLockMatchesTree: packageLockSha256 === SUPERVISOR_PACKAGE_LOCK_SHA256,
      historicalArchiveSha256: HISTORICAL_ARCHIVE_SHA256,
      historicalArchiveUsed: false,
    },
    oci: {
      localLayoutIndexDigest: OCI_INDEX_DIGEST,
      indexMediaType: "application/vnd.oci.image.index.v1+json",
      platform: "linux/amd64",
      worker: {
        name: "qsb-optimized:source-v1",
        configDigest: WORKER_CONFIG_DIGEST,
        manifestDigest: WORKER_MANIFEST_DIGEST,
      },
      queue: {
        name: "qsb-optimized-queue:source-v1",
        configDigest: QUEUE_CONFIG_DIGEST,
        manifestDigest: QUEUE_MANIFEST_DIGEST,
      },
      baseImages: { build: BUILD_BASE, runtime: RUNTIME_BASE },
      registryManifestPushed: false,
      registryManifestDigest: null,
    },
    solverSourceMatchesRecordedLock: divergedFromRecordedLock.length === 0,
    divergedFromRecordedLock,
    executionEnabled: false,
    certifiesCurrentTree: false,
    freshSearch: false,
    externalMinerInclusion: false,
    section6Closed: false,
    section7Closed: false,
    section8Closed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    supervisedProfilePointsAtHistoricalWorkerDockerfile: false,
    mainnetConfigRelabeledAsRegtest: false,
  };
}
