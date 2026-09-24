import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./identity";

/** Ranked batches are this compile, not the default short-epoch pair build. */
export const SELECTED_GENERIC_FLAGS = {
  ZLAB_TRIM: 0,
  QSB_PAIR_SHARED: 0,
} as const;

/** Compile unit for the ranked generic path. Its quoted includes are the review closure. */
const REVIEW_ENTRYPOINTS = [
  "research/optimized-subset/subset/tests/gpu_epochs/tree.cu",
] as const;

const OPTIMIZED_ROOT = "research/optimized-subset/";

const REQUIRED_MARKERS: Record<string, readonly string[]> = {
  "research/optimized-subset/subset/GPUMath.h": [
    "The input contract permits all four-limb values <2^256.",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/tree.cu": [
    "void qsb_field_normalize",
    "0xFFFFFFFEFFFFFC2FULL",
    "unsupported geometry for the ranked generic path",
    "hand exceptional active points to exact host",
    "qsb_resolve_exceptions",
    "return gpu_is_valid_der(digest, 32);",
    "QSB_RANGE_INCOMPLETE: cannot write hit output",
    "hit count exceeds host capacity",
    "exceptional point requires exact recovery",
    "if(count>1024u)",
    "if(encoded<0)",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/tree_inverse.cuh": [
    "qsb_field_normalize(root);",
    "_ModInv(root);",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/zinv32.cuh": [
    "no universal convergence bound is",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/exact_resolve.cuh": [
    "if(count>64)return false;",
    "qsb_exact_der",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/pair_shared.cuh": [
    "if(!qsb_k2s_front_exact(ep,first,lane,d_gt,rx,ry,inv,m1,m2))return -1;",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/cuda_checked.h": [
    "QSB_RANGE_INCOMPLETE: CUDA",
    "return 2;",
  ],
  "research/optimized-subset/subset/tests/gpu_epochs/openssl_checked.h": [
    "QSB_RANGE_INCOMPLETE: OpenSSL",
  ],
};

export type AlgorithmAssumption = {
  id: string;
  admitted: string;
  remains: string;
};

export const algorithmAssumptions: readonly AlgorithmAssumption[] = [
  {
    id: "field-representation",
    admitted:
      "Guard helpers and qsb_field_normalize take four little-endian uint64 limbs in [0, 2^256). Because 2p is greater than 2^256, one conditional subtraction maps every such word onto [0, p).",
    remains:
      "Values wider than 256 bits before the reduction tail are outside this contract. The PTX product schedule was not executed in this checkout.",
  },
  {
    id: "normalization",
    admitted:
      "A 256-bit word is reduced exactly when its upper three limbs are all ones and the low limb is at least 0xFFFFFFFEFFFFFC2F. The CPU check compares that rule with reduction modulo p.",
    remains:
      "Agreement on finite vectors does not prove that every CUDA multiply emits a 256-bit residue, and it is not universal arithmetic correctness.",
  },
  {
    id: "inversion",
    admitted:
      "The ranked inverse is the delayed binary-GCD family in zinv32 and _ModInv. A non-invertible input, including zero, yields zero rather than a slope. The tree inverse normalizes the root product before _ModInv.",
    remains:
      "The source states that no universal convergence bound is assumed for the 32-batch divstep cap. This checkout did not run those iterations.",
  },
  {
    id: "point-recovery",
    admitted:
      "XYZZ recovery uses W = ZZZ * d with d = xR*ZZ - X. W is zero when d is zero or the point is at infinity, and the affine finish is not used on that set. The ranked generic kernel records those active points for qsb_resolve_exceptions. The pair verifier returns -1 instead of dropping them, and the host fails the range.",
    remains:
      "The speculative pair filter can still omit a candidate before verification. That build is not the ranked generic path. Exact OpenSSL recovery was not executed here. Historical vendored source still returns on an unusable denominator without that host recovery.",
  },
  {
    id: "predicates-and-publication",
    admitted:
      "The ranked gate calls gpu_is_valid_der. Strict qsb_exact_der matches that predicate on 32-byte inputs in the CPU check. Easy and calibrate modes are not the generic path. CUDA and OpenSSL helpers, hit reads, and hit writes return QSB_RANGE_INCOMPLETE before a completed-batch publication.",
    remains:
      "No native binary was built, so these checks are source-locked rather than tied to new machine code. docs/gpu-validation is not in this checkout.",
  },
  {
    id: "capacity-and-omissions",
    admitted:
      "More than 64 retained hit records fails the range. A 1024-slot device buffer is not extra published capacity. Deterministic failure, unsupported ranked geometry, and an unresolved exceptional denominator do not receive range credit.",
    remains:
      "Checking candidates that were returned cannot detect a solver that returned success after omitting a candidate. Predecessor GPU timings are not evidence for these bytes.",
  },
];

export type SolverReview = {
  kind: "source-review";
  selectedFlags: typeof SELECTED_GENERIC_FLAGS;
  defaultFlagsAreSelectedPath: false;
  nativeBinarySha256: string | null;
  gpuExecuted: false;
  predecessorEvidenceEnrolled: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  sourceSha256: string;
  files: Record<string, string>;
  assumptions: readonly AlgorithmAssumption[];
};

export type EvidenceClaim = {
  kind: "predecessor-gpu" | "source-review" | "native-binary";
  sourceSha256: string;
  nativeBinarySha256: string | null;
};

export type EvidenceJudgment = {
  accepted: false;
  reason:
    | "predecessor-evidence"
    | "source-mismatch"
    | "native-not-run"
    | "binary-mismatch";
};

const LOCAL_INCLUDE = /^\s*#\s*include\s+"([^"]+)"/gm;

/** Quoted includes, resolved from the including file and walked until the local set closes. */
export function reviewedSourceClosure(root: string): string[] {
  const seen = new Set<string>();
  const pending: string[] = [...REVIEW_ENTRYPOINTS];
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (relativePath === undefined || seen.has(relativePath)) continue;
    if (!relativePath.startsWith(OPTIMIZED_ROOT) || relativePath.includes(".."))
      throw new Error(`Solver include escapes the optimized tree: ${relativePath}`);
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute))
      throw new Error(`Missing solver include ${relativePath}`);
    seen.add(relativePath);
    const text = readFileSync(absolute, "utf8");
    const directory = path.posix.dirname(relativePath);
    for (const match of text.matchAll(LOCAL_INCLUDE)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const resolved = path.posix.normalize(path.posix.join(directory, spec));
      pending.push(resolved);
    }
  }
  for (const relativePath of Object.keys(REQUIRED_MARKERS)) {
    if (!seen.has(relativePath))
      throw new Error(`Marker file is outside the include closure: ${relativePath}`);
  }
  return [...seen].sort();
}

/** Stable digest of every file in the closure. An omitted header cannot keep this hash. */
export function sourceIdentity(files: Readonly<Record<string, string>>): string {
  const joined = Object.keys(files)
    .sort()
    .map((relativePath) => `${relativePath}:${files[relativePath]}`)
    .join("\n");
  return sha256Hex(joined);
}

export function reviewGenericPath(root: string): SolverReview {
  const files: Record<string, string> = {};
  for (const relativePath of reviewedSourceClosure(root)) {
    const text = readFileSync(path.join(root, relativePath), "utf8");
    for (const marker of REQUIRED_MARKERS[relativePath] ?? []) {
      if (!text.includes(marker))
        throw new Error(`Missing solver marker ${marker} in ${relativePath}`);
    }
    files[relativePath] = sha256Hex(text);
  }
  const tree = files["research/optimized-subset/subset/tests/gpu_epochs/tree.cu"];
  const treeText = readFileSync(
    path.join(root, "research/optimized-subset/subset/tests/gpu_epochs/tree.cu"),
    "utf8",
  );
  if (tree === undefined || treeText.includes("? 64 :"))
    throw new Error("Ranked hit output still truncates at 64");
  return {
    kind: "source-review",
    selectedFlags: SELECTED_GENERIC_FLAGS,
    defaultFlagsAreSelectedPath: false,
    nativeBinarySha256: null,
    gpuExecuted: false,
    predecessorEvidenceEnrolled: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    sourceSha256: sourceIdentity(files),
    files,
    assumptions: algorithmAssumptions,
  };
}

/** Predecessor runs and unbuilt binaries do not enroll against the reviewed bytes. */
export function judgeEvidence(
  review: SolverReview,
  claim: EvidenceClaim,
): EvidenceJudgment {
  if (claim.kind === "predecessor-gpu")
    return { accepted: false, reason: "predecessor-evidence" };
  if (claim.sourceSha256 !== review.sourceSha256)
    return { accepted: false, reason: "source-mismatch" };
  if (review.nativeBinarySha256 === null || claim.nativeBinarySha256 === null)
    return { accepted: false, reason: "native-not-run" };
  if (claim.nativeBinarySha256 !== review.nativeBinarySha256)
    return { accepted: false, reason: "binary-mismatch" };
  return { accepted: false, reason: "native-not-run" };
}
