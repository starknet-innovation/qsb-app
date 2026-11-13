/** Explicit offline follow-up: retain native identities, allow only checker/docs changes. */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const allowed = new Set([
  "ops/pqb-serving/consensus.ts", "ops/pqb-serving/consensus-signature.ts",
  "ops/pqb-serving/consensus-retained.ts", "tests/pqb-serving-consensus.test.ts",
]);
export function retainedOnlyChanges(files: string[]): boolean {
  return files.every(f => allowed.has(f) || f === "README.md" || f === "ops/pqb-serving/README.md"
    || (f.startsWith("docs/") && f.endsWith(".md")));
}
function attribute(value: any): any {
  if ("S" in value) return value.S;
  if ("N" in value) return Number.isSafeInteger(Number(value.N)) ? Number(value.N) : value.N;
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(attribute);
  if ("M" in value) return Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, attribute(v)]));
  throw Error("Unsupported sealed DynamoDB attribute");
}
export function retainedContext(dir: string, campaign: any, job: any, currentCommit: string) {
  const root = realpathSync(dir);
  function bytes(file: string): Buffer {
    const target = realpathSync(path.resolve(root, file));
    if (!target.startsWith(root + path.sep)) throw Error("Evidence file escaped campaign directory");
    return readFileSync(target);
  }
  const json = (file: string) => JSON.parse(bytes(file).toString("utf8"));
  function binding(ref: any): any {
    if (!ref || !ref.file || sha(bytes(ref.file)) !== ref.sha256) throw Error("Missing or changed retained receipt");
    return json(ref.file);
  }
  const cleanup = binding(campaign.independentCleanup);
  if (campaign.reservationStatus !== "released" || cleanup.verified !== true
    || cleanup.campaign !== campaign.name || cleanup.sourceCommit !== campaign.sourceCommit
    || !cleanup.checks?.length || !cleanup.checks.every((x: any) => x.passed === true))
    throw Error("Retained verification requires independently verified cleanup");
  const seal = binding(campaign.finalCollection);
  if (seal.sourceCommit !== campaign.sourceCommit || seal.name !== campaign.name
    || !Object.keys(seal.executions ?? {}).length
    || !Object.values(seal.executions).every(s => ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"].includes(s as string)))
    throw Error("Sealed native campaign identity or terminal history differs");
  for (const [file, hash] of Object.entries(seal.files))
    if (sha(bytes(file)) !== hash) throw Error("Sealed evidence changed: " + file);
  const retainedManifest = json("build-artifacts/manifest.json");
  if (!retainedManifest.clean || retainedManifest.commit !== campaign.sourceCommit)
    throw Error("Original build source identity differs");
  const changed = execFileSync("git", ["diff", "--name-only", campaign.sourceCommit, currentCommit], { encoding: "utf8" }).trim();
  if (!retainedOnlyChanges(changed ? changed.split("\n") : []))
    throw Error("Application/build/fixture changes require a new native assessment");
  const resourceFiles = Object.keys(seal.files).filter(f => /^final-resources-\d+\.json$/.test(f));
  if (resourceFiles.length !== 1 || !seal.files["public-fixture.json"] || !seal.files["build-artifacts/api.zip"])
    throw Error("Missing sealed native evidence");
  const resources = json(resourceFiles[0]);
  if (!Array.isArray(campaign.tables) || campaign.tables.length !== 2 || campaign.tables[0] === campaign.tables[1]
    || !resources.tables[campaign.tables[1]]) throw Error("Missing sealed solve table");
  const rows = resources.tables[campaign.tables[1]].pages.flatMap((p: any) =>
    p.Items.map((item: any) => attribute({ M: item })));
  const matches = rows.filter((r: any) => r.job?.id === job.id);
  if (matches.length !== 1 || !["manifest", "manifestHash", "solution", "solver", "vaultId", "owner"].every(k =>
    isDeepStrictEqual(matches[0].job[k], job[k]))) throw Error("Final job differs from sealed coordinator result");
  const originalRaw = bytes("solved-synthetic-transaction.hex").toString("utf8").trim();
  const positive = json("offline-core-solved-pqb-with-public-OP_TRUE-helper.json");
  const intent = json("offline-consensus-intent.json");
  if (positive.accepted !== true || positive.expectedValid !== true
    || positive.transactionSha256 !== sha(Buffer.from(originalRaw, "hex"))
    || intent.sourceCommit !== campaign.sourceCommit || intent.apiArtifactSha256 !== campaign.apiArtifactSha256)
    throw Error("Original positive Core receipt differs");
  return { originalRaw, intent, retainedManifest,
    provenance: { nativeConsumerSourceCommit: campaign.sourceCommit, validationSourceCommit: currentCommit,
      postprocessingOnly: true, finalCollectionSha256: campaign.finalCollection.sha256,
      independentCleanupSha256: campaign.independentCleanup.sha256,
      originalTransactionSha256: positive.transactionSha256 } };
}
