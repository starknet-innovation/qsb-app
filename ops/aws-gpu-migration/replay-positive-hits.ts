/** Historical public replay only. No AWS client, paid submit, signing or broadcast.
 * Usage: npx tsx ops/aws-gpu-migration/replay-positive-hits.ts /path/to/public-signing-bundle.json
 * The external bundle is intentionally never copied into this repository.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AwsBatch } from "../../server/aws-batch";
import { chunkSize, subsetRank, workRange } from "../../server/search-ranges";
const root = fileURLToPath(new URL("../../", import.meta.url));
const path = process.argv[2];
if (!path || process.argv.length !== 3)
  throw Error("Supply one external public-signing-bundle.json path");
const bundle = z
  .object({
    request: z.object({ vault: z.object({ publicStateJson: z.string() }) }),
    fixture: z.object({ manifest: z.record(z.string(), z.unknown()) }),
    solution: z.object({
      sequence: z.number().int(),
      locktime: z.number().int(),
      round1: z.array(z.number().int()).length(9),
      round2: z.array(z.number().int()).length(9),
    }),
  })
  .parse(JSON.parse(readFileSync(path, "utf8")));
const reference = (event: unknown): any => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys; from handler import handler; print(json.dumps(handler(json.load(sys.stdin))))",
    ],
    {
      cwd: root,
      input: JSON.stringify(event),
      encoding: "utf8",
      timeout: 60000,
      // No inherited cloud credentials or operator runtime configuration.
      env: {
        PATH: process.env.PATH,
        PYTHONPATH: root + "worker/cpu",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  assert.equal(result.status, 0, "CPU reference failed: " + result.stderr);
  return JSON.parse(result.stdout);
};
const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-replay";
const definition =
  "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-replay:1";
const token = "11111111-1111-1111-1111-111111111111";
const rows = [];
for (const stage of ["pinning", "round1", "round2"] as const) {
  const context = {
    publicStateJson: bundle.request.vault.publicStateJson,
    manifest: bundle.fixture.manifest,
    stage,
    sequence: bundle.solution.sequence,
    locktime: bundle.solution.locktime,
  };
  const parameters = reference({ ...context, action: "export" });
  const candidate =
    stage === "pinning"
      ? `sequence=${context.sequence}\nlocktime=${context.locktime}\n`
      : "indices=" +
        bundle.solution[stage].map((i) => 149 - i).join(",") +
        "\n";
  const attempt =
    stage === "pinning"
      ? Math.floor((context.sequence - 0x80000000) / 16)
      : Number(subsetRank(bundle.solution[stage]) / BigInt(chunkSize));
  const request = { ...parameters, stage, attempt, searchVersion: "ranked-v2" };
  const identity = {
    jobName: "qsb-" + token,
    inputKey: `inputs/${token}.json`,
    inputSha256: createHash("sha256")
      .update(JSON.stringify({ input: request }))
      .digest("hex"),
    queue,
    definition,
  };
  const output = {
    status: "completed",
    checkpoint: "candidate",
    stage,
    attempt,
    workRange: workRange(stage, attempt),
    candidates: [candidate],
  };
  const job = {
    jobId: token,
    jobName: identity.jobName,
    jobQueue: queue,
    jobDefinition: definition,
    status: "SUCCEEDED",
    tags: {
      Project: "qsb-gpu",
      QsbRequest: token,
      InputSha256: identity.inputSha256,
    },
    container: {
      environment: [
        { name: "QSB_INPUT_KEY", value: identity.inputKey },
        { name: "QSB_INPUT_SHA256", value: identity.inputSha256 },
      ],
    },
  };
  let raw = JSON.stringify({
    jobId: token,
    inputSha256: identity.inputSha256,
    executionTime: 0,
    output,
  });
  const calls: string[] = [];
  const batch = {
    send: async (command: any) => {
      calls.push(command.constructor.name);
      assert.equal(command.constructor.name, "DescribeJobsCommand");
      assert.deepEqual(command.input, { jobs: [token] });
      return { jobs: [job] };
    },
  };
  const s3 = {
    send: async (command: any) => {
      calls.push(command.constructor.name);
      assert.equal(command.constructor.name, "GetObjectCommand");
      assert.deepEqual(command.input, {
        Bucket: "qsb-replay",
        Key: `outputs/${token}.json`,
      });
      return {
        ContentLength: Buffer.byteLength(raw),
        Body: { transformToString: async () => raw },
      };
    },
  };
  const noSubmit = {
    send: async () => {
      throw Error("Paid submission forbidden in historical replay");
    },
  };
  const provider = new AwsBatch(
    queue,
    definition,
    "qsb-replay",
    batch as any,
    s3 as any,
    noSubmit as any,
  );
  const accepted = await provider.status(token, identity);
  assert.equal(accepted.status, "COMPLETED");
  const verdict = reference({
    ...context,
    action: "verify",
    candidates: (accepted.output as typeof output).candidates,
  });
  assert.equal(verdict.valid, true);
  if (stage === "pinning") {
    assert.equal(verdict.sequence, context.sequence);
    assert.equal(verdict.locktime, context.locktime);
  } else
    assert.deepEqual(
      verdict.indices,
      [...bundle.solution[stage]].sort((a, b) => a - b),
    );
  const invalid = reference({
    ...context,
    action: "verify",
    candidates: [
      stage === "pinning"
        ? "sequence=0\nlocktime=0\n"
        : "indices=1,1,1,1,1,1,1,1,1\n",
    ],
  });
  assert.equal(invalid.valid, false);
  const alteredContext = reference({
    ...context,
    locktime: context.locktime + 1,
    action: "verify",
    candidates: [candidate],
  });
  // Pinning records supply their own sequence/locktime; subset records must bind the context.
  if (stage !== "pinning") assert.equal(alteredContext.valid, false);
  await assert.rejects(
    provider.status(token, { ...identity, inputSha256: "f".repeat(64) }),
    /ProviderRequestIdentityMismatch/,
  );
  raw = JSON.stringify({
    jobId: token,
    inputSha256: "f".repeat(64),
    executionTime: 0,
    output,
  });
  await assert.rejects(
    provider.status(token, identity),
    /ComputeOutputIdentityMismatch/,
  );
  assert(
    calls.every((x) => ["DescribeJobsCommand", "GetObjectCommand"].includes(x)),
  );
  rows.push({
    stage,
    attempt,
    parameterSha256: parameters.parameterSha256,
    positiveHitVerified: true,
    invalidCandidateRejected: true,
    alteredContextRejected: stage === "pinning" ? null : true,
    requestMismatchRejected: true,
    outputMismatchRejected: true,
  });
}
console.log(
  JSON.stringify(
    {
      schema: "qsb-batch-public-hit-replay-v1",
      scope:
        "mocked AWS Batch/S3 transport and real local CPU reference; public historical replay only",
      liveAwsCalls: 0,
      paidSubmissions: 0,
      rangeCredits: 0,
      freshSearch: false,
      coreOrMinerProof: false,
      rows,
    },
    null,
    2,
  ),
);
