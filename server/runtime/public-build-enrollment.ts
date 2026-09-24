import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import capability from "../mainnet-capability.json";
import { release } from "../../src/lib/model";
import { assertInsideRepo, sha256Hex } from "./identity";
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

const ROUTING_FILE_SHA256 = {
  "supervised/archive/work/yukon-app-routing-20260923/routing.ts":
    "f890d87b2b0466da3f9f5407b6e0cf9d08c391acb4db8f22cb74bc51f61440c9",
  "supervised/runtime/source/work/yukon-app-routing-20260923/routing.ts":
    "ec7015ee9ec8caea32068af8ebe024a3f08c2fcbd895415cea4a58cf0aa22bd2",
} as const;

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

function enrollmentPath(root: string, relativePath: string): string {
  try {
    return assertInsideRepo(root, relativePath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Release path escapes the checkout"
    )
      fail("PublicBuildPathEscapes");
    throw error;
  }
}

function readRepoFile(root: string, relativePath: string): Buffer {
  const absolute = enrollmentPath(root, relativePath);
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

function solverLockPath(relativeFile: string): string {
  const relativePath = path.posix.normalize(
    path.posix.join(OPTIMIZED_SOURCE, relativeFile),
  );
  if (
    !relativePath.startsWith(`${OPTIMIZED_SOURCE}/subset/`) ||
    relativePath.split("/").includes("..")
  )
    fail("PublicBuildLockEscapes");
  return relativePath;
}

/** File inventory of subset/, matching worker/optimized/build.py. */
function solverInventory(root: string): string[] {
  const subsetDir = path.posix.join(OPTIMIZED_SOURCE, "subset");
  enrollmentPath(root, subsetDir);
  if (!existsSync(path.join(root, subsetDir))) fail(`PublicBuildMissing:${subsetDir}`);
  const found: string[] = [];
  const stack = [subsetDir];
  while (stack.length) {
    const relativeDir = stack.pop();
    if (!relativeDir) break;
    const absolute = enrollmentPath(root, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      const relativeFile = relativePath.slice(OPTIMIZED_SOURCE.length + 1);
      if (
        !relativePath.startsWith(`${OPTIMIZED_SOURCE}/`) ||
        relativeFile.split("/").includes("..")
      )
        fail("PublicBuildLockEscapes");
      enrollmentPath(root, relativePath);
      if (entry.isDirectory()) stack.push(relativePath);
      else if (entry.isFile()) found.push(relativeFile);
    }
  }
  return found;
}

function solverDivergence(
  root: string,
  files: Record<string, string>,
): string[] {
  const expected = new Map(Object.entries(files));
  for (const relativeFile of expected.keys()) solverLockPath(relativeFile);
  const actual = new Set(solverInventory(root));
  const diverged: string[] = [];
  for (const relativeFile of [...expected.keys()].sort()) {
    const relativePath = solverLockPath(relativeFile);
    if (!actual.has(relativeFile)) {
      diverged.push(relativePath);
      continue;
    }
    if (sha256Hex(readRepoFile(root, relativePath)) !== expected.get(relativeFile))
      diverged.push(relativePath);
  }
  for (const relativeFile of [...actual].sort()) {
    if (!expected.has(relativeFile)) diverged.push(solverLockPath(relativeFile));
  }
  return diverged;
}

type StageCopy = {
  from: string | null;
  sources: string[];
};

type OptimizedStage = {
  name: string;
  image: string;
  copies: StageCopy[];
};

function stripDockerfileComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function dockerfileInstructions(text: string): string[] {
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripDockerfileComment(raw).trim();
    if (stripped) kept.push(stripped);
  }
  const logical: string[] = [];
  let buffer = "";
  for (const line of kept) {
    const continued = line.endsWith("\\");
    const piece = (continued ? line.slice(0, -1) : line).trim();
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (!continued) {
      if (buffer) logical.push(buffer);
      buffer = "";
    }
  }
  if (buffer) logical.push(buffer);
  return logical;
}

function dockerfileTokens(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const character of body) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) fail("PublicBuildDockerfileUnparsed");
  if (current) tokens.push(current);
  return tokens;
}

function parseOptimizedStages(text: string): OptimizedStage[] {
  const stages: OptimizedStage[] = [];
  let current: OptimizedStage | null = null;
  let index = 0;
  for (const instruction of dockerfileInstructions(text)) {
    const from = instruction.match(
      /^FROM\s+(?:--platform=\S+\s+)?(\S+?)(?:\s+AS\s+(\S+))?\s*$/i,
    );
    if (from) {
      index += 1;
      const name = from[2] ?? `stage-${index}`;
      if (stages.some((stage) => stage.name === name))
        fail("PublicBuildDockerfileUnparsed");
      current = { name, image: from[1] ?? "", copies: [] };
      stages.push(current);
      continue;
    }
    if (!current) fail("PublicBuildDockerfileUnparsed");
    const copy = instruction.match(/^COPY\s+([\s\S]*)$/i);
    if (!copy) continue;
    const tokens = dockerfileTokens(copy[1] ?? "");
    const sources: string[] = [];
    let fromStage: string | null = null;
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor] ?? "";
      if (token === "--from") {
        const value = tokens[cursor + 1];
        if (!value || value.startsWith("--") || fromStage)
          fail("PublicBuildDockerfileUnparsed");
        fromStage = value;
        cursor += 1;
        continue;
      }
      if (token.startsWith("--from=")) {
        if (fromStage) fail("PublicBuildDockerfileUnparsed");
        fromStage = token.slice("--from=".length);
        continue;
      }
      if (token.startsWith("--")) {
        if (!token.includes("=")) cursor += 1;
        continue;
      }
      sources.push(token);
    }
    if (sources.length < 2) fail("PublicBuildDockerfileUnparsed");
    current.copies.push({ from: fromStage, sources: sources.slice(0, -1) });
  }
  if (!stages.length) fail("PublicBuildDockerfileUnparsed");
  return stages;
}

function stageByName(
  stages: readonly OptimizedStage[],
  name: string,
): OptimizedStage | undefined {
  return stages.find((stage) => stage.name === name);
}

function derivesFromRuntime(
  stages: readonly OptimizedStage[],
  name: string,
): boolean {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    if (current === "runtime") return true;
    seen.add(current);
    const stage = stageByName(stages, current);
    if (!stage || !stageByName(stages, stage.image)) return false;
    current = stage.image;
  }
  return false;
}

function copiesSolverSource(source: string): boolean {
  return (
    source === "research/optimized-subset" ||
    source.startsWith("research/optimized-subset/")
  );
}

function copiesValidationArtifact(source: string): boolean {
  return (
    source === "/opt/qsb-validation" || source.startsWith("/opt/qsb-validation/")
  );
}

function assertOptimizedDockerfile(root: string): void {
  const stages = parseOptimizedStages(
    readRepoFile(root, OPTIMIZED_DOCKERFILE).toString("utf8"),
  );
  const runtime = stageByName(stages, "runtime");
  if (
    !runtime ||
    runtime.image !== RUNTIME_BASE ||
    !derivesFromRuntime(stages, "queue")
  )
    fail("PublicBuildBaseImageMismatch");
  const producers = runtime.copies.filter((copy) =>
    copy.sources.some(copiesValidationArtifact),
  );
  if (
    producers.length === 0 ||
    producers.some((copy) => stageByName(stages, copy.from ?? "")?.image !== BUILD_BASE)
  )
    fail("PublicBuildBaseImageMismatch");
  if (
    producers.some((copy) => {
      const producer = stageByName(stages, copy.from ?? "");
      return !producer?.copies.some((item) => item.sources.some(copiesSolverSource));
    })
  )
    fail("PublicBuildDockerfileMissingSolver");
  parseWorkerDockerfile(readRepoFile(root, HISTORICAL_DOCKERFILE).toString("utf8"));
}

function assertSupervisedProfileUnmoved(root: string): void {
  for (const [relativePath, expected] of Object.entries(ROUTING_FILE_SHA256)) {
    if (sha256Hex(readRepoFile(root, relativePath)) !== expected)
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
