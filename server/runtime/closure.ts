import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertInsideRepo } from "./identity";

/** Files the public checkout can package without reading a developer work directory. */
export const requiredReleasePaths = [
  "server/app.ts",
  "server/chain.ts",
  "server/coordinator.ts",
  "server/lambda.ts",
  "server/local.ts",
  "server/mainnet-capability.json",
  "server/mainnetConfig.ts",
  "server/network.ts",
  "server/providers.ts",
  "server/search-ranges.ts",
  "server/store.ts",
  "server/transaction-checks.ts",
  "server/validation-search.ts",
  "server/runtime/capability.ts",
  "server/runtime/closure.ts",
  "server/runtime/cpu-verifier.ts",
  "server/runtime/dispatcher.ts",
  "server/runtime/evidence-reader.ts",
  "server/runtime/host-bridge.ts",
  "server/runtime/identity.ts",
  "server/runtime/package-release.ts",
  "server/runtime/supervised-routes.ts",
  "server/runtime/types.ts",
  "src/lib/model.ts",
  "src/lib/network.ts",
  "src/lib/provenance.ts",
  "src/lib/readiness.ts",
  "src/lib/transactions.ts",
  "src/lib/releases/qsb-config-a-ranked-v2.json",
  "src/mainnet/admissionClient.ts",
  "src/mainnet/consumer.ts",
  "src/mainnet/flow.ts",
  "src/mainnet/intent.ts",
  "src/mainnet/publicResult.ts",
  "src/mainnet/retainedRequest.ts",
  "src/mainnet/solvedContract.ts",
  "src/mainnet/submission.ts",
  "src/mainnet/submissionClient.ts",
  "worker/Dockerfile",
  "worker/handler.py",
  "worker/prepare_kernels.py",
  "worker/search_ranges.py",
  "worker/cpu/LICENSE",
  "worker/cpu/bitcoin_tx.py",
  "worker/cpu/gpu_emulator.py",
  "worker/cpu/handler.py",
  "worker/cpu/qsb_pipeline.py",
  "worker/cpu/secp256k1.py",
  "worker/cpu/verify_hit.py",
  "scripts/package-release.ts",
] as const;

/** Compiler and lock metadata required to type-check the packaged tree. */
export const buildMetadataPaths = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
] as const;

const localSpecifier =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']+)["']|new URL\(\s*["'](\.[^"']+)["']/g;

function resolveLocalSpecifier(fromFile: string, specifier: string): string {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  if (/\.(?:ts|tsx|json|py|mjs|cjs)$/.test(base)) return base;
  return `${base}.ts`;
}

/** Transitive relative imports of the enrolled sources, plus build metadata. */
export function enrolledSourcePaths(root: string): string[] {
  const seen = new Set<string>([...requiredReleasePaths]);
  const pending: string[] = [...requiredReleasePaths];
  while (pending.length) {
    const relativePath = pending.pop();
    if (!relativePath || !/\.(?:ts|tsx)$/.test(relativePath)) continue;
    const absolute = assertInsideRepo(root, relativePath);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, "utf8");
    for (const match of text.matchAll(localSpecifier)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const resolved = resolveLocalSpecifier(relativePath, specifier);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      pending.push(resolved);
    }
  }
  for (const relativePath of buildMetadataPaths) seen.add(relativePath);
  return [...seen].sort();
}

export const componentForPath = (relativePath: string): string => {
  if (
    relativePath === "package.json" ||
    relativePath === "package-lock.json" ||
    relativePath === "tsconfig.json"
  )
    return "build-metadata";
  if (relativePath.startsWith("server/runtime/host-bridge.ts") || relativePath.startsWith("worker/"))
    return relativePath.startsWith("worker/cpu/") ? "cpu-verifier" : "runtime";
  if (relativePath === "server/runtime/cpu-verifier.ts") return "cpu-verifier";
  if (relativePath === "server/runtime/evidence-reader.ts") return "evidence-reader";
  if (
    relativePath.startsWith("server/runtime/") ||
    relativePath === "server/coordinator.ts" ||
    relativePath === "server/validation-search.ts" ||
    relativePath === "scripts/package-release.ts"
  )
    return "dispatcher";
  if (relativePath.startsWith("research/optimized-subset/")) return "optimized-subset";
  if (relativePath.startsWith("vendor/challenge/candidates/pinning/"))
    return "historical-pinning";
  if (relativePath.startsWith("vendor/challenge/candidates/subset/"))
    return "historical-subset";
  return "api";
};

export const historicalCandidateRoots = [
  "vendor/challenge/candidates/pinning",
  "vendor/challenge/candidates/subset",
] as const;

export const optimizedSubsetRoot = "research/optimized-subset";
