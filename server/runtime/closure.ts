import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertInsideRepo } from "./identity";

/** Files the public checkout can package without reading a developer work directory. */
export const requiredReleasePaths = [
  "AGENTS.md",
  "contracts/ranked-v2.json",
  "docs/source-build/20260924/solver-build-receipt.json",
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
  "server/runtime/activation.ts",
  "server/runtime/capability.ts",
  "server/runtime/closure.ts",
  "server/runtime/coverage-ledger.ts",
  "server/runtime/solver-review.ts",
  "server/runtime/cpu-verifier.ts",
  "server/runtime/dispatcher.ts",
  "server/runtime/evidence-reader.ts",
  "server/runtime/fresh-proof.ts",
  "server/runtime/miner-inclusion.ts",
  "server/runtime/host-bridge.ts",
  "server/runtime/host-lifecycle.ts",
  "server/runtime/host-requirements.ts",
  "server/runtime/identity.ts",
  "server/runtime/package-release.ts",
  "server/runtime/reservation-guard.ts",
  "server/runtime/storage-authority.ts",
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
  "src/mainnet/chain.ts",
  "src/mainnet/flow.ts",
  "src/mainnet/intent.ts",
  "src/mainnet/publicResult.ts",
  "src/mainnet/retainedRequest.ts",
  "src/mainnet/solvedContract.ts",
  "src/mainnet/submission.ts",
  "src/mainnet/submissionClient.ts",
  "public/qsb/LICENSE",
  "public/qsb/bitcoin_tx.py",
  "public/qsb/secp256k1.py",
  "public/qsb/qsb_pipeline.py",
  "public/qsb/bridge.py",
  "public/qsb/manifest.json",
  "worker/cpu/LICENSE",
  "worker/cpu/bitcoin_tx.py",
  "worker/cpu/gpu_emulator.py",
  "worker/cpu/handler.py",
  "worker/cpu/qsb_pipeline.py",
  "worker/cpu/secp256k1.py",
  "worker/cpu/verify_hit.py",
  "scripts/package-release.ts",
  "scripts/generate-solver-registry.mjs",
  "scripts/storage-inventory.ts",
] as const;

/** Compiler, lock, and Node-requirement metadata required to check the packaged tree. */
export const buildMetadataPaths = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
] as const;

/** Scripts whose entrypoints or toolchains are outside this source package. */
export const unpackagedReleaseScripts = [
  "dev",
  "prebuild",
  "pretest",
  "pretypecheck",
  "build",
  "test",
  "test:e2e",
  "typecheck",
  "vendor",
  "build:runtime",
  "build:optimized",
  "build:optimized:queue",
  "test:runtime-build",
  "test:optimized-image",
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
    relativePath === "tsconfig.json" ||
    relativePath === "README.md"
  )
    return "build-metadata";
  if (
    relativePath.startsWith("server/runtime/host-") ||
    relativePath.startsWith("worker/")
  )
    return relativePath.startsWith("worker/cpu/") ? "cpu-verifier" : "runtime";
  if (relativePath === "scripts/storage-inventory.ts") return "dispatcher";
  if (relativePath === "server/runtime/cpu-verifier.ts") return "cpu-verifier";
  if (relativePath === "server/runtime/evidence-reader.ts")
    return "evidence-reader";
  if (
    relativePath === "server/runtime/fresh-proof.ts" ||
    relativePath === "server/runtime/core-binary.json"
  )
    return "fresh-proof";
  if (
    relativePath === "AGENTS.md" ||
    relativePath === "server/runtime/miner-inclusion.ts" ||
    relativePath === "server/runtime/activation.ts"
  )
    return "api";
  if (
    relativePath.startsWith("server/runtime/") ||
    relativePath === "server/coordinator.ts" ||
    relativePath === "server/validation-search.ts" ||
    relativePath === "scripts/package-release.ts"
  )
    return "dispatcher";
  if (relativePath.startsWith("research/optimized-subset/"))
    return "optimized-subset";
  if (relativePath.startsWith("vendor/challenge/candidates/pinning/"))
    return "historical-pinning";
  if (relativePath.startsWith("vendor/challenge/candidates/subset/"))
    return "historical-subset";
  return "api";
};
