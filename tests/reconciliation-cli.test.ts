import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { Job } from "../src/lib/model";
import { reconciliationEnvironmentError } from "../server/reconciliation-environment";

const mocks = vi.hoisted(() => ({ secret: vi.fn(), workflow: vi.fn(), allowed: vi.fn(() => true) }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class {},
  SecretsManagerClient: class { send = mocks.secret; },
}));
vi.mock("@aws-sdk/client-sfn", () => ({
  StartExecutionCommand: class {},
  SFNClient: class { send = mocks.workflow; },
}));
vi.mock("../server/network", async (original) => ({ ...await original<typeof import("../server/network")>(), transactionsEnabled: true, rehearsalAddressAllowed: mocks.allowed }));
vi.mock("../server/store", async (original) => {
  const actual = await original<typeof import("../server/store")>();
  return { ...actual, store: new actual.MemoryStore() };
});
import { store } from "../server/store";
import { AwsBatch } from "../server/aws-batch";
import { reconcileSubmissionCli, reconcileUnknownSubmission } from "../server/reconcile-submission";

const required = {
  TABLE_NAME: "dummy-table", AWS_REGION: "us-east-1", AWS_BATCH_JOB_DEFINITION: "arn:aws:batch:eu-west-1:905846953990:job-definition/qsb-gpu-solver:1", AWS_BATCH_JOB_BUCKET: "qsb-gpu-jobs",
  AWS_BATCH_JOB_QUEUE: "arn:aws:batch:eu-west-1:905846953990:job-queue/qsb-gpu", WORKFLOW_ARN: "dummy-workflow", QSB_NETWORK: "mainnet", QSB_MAINNET_ENABLED: "true",
};
const args = ["owner", "job", "--provider-id", "provider-1", "--operator", "test", "--evidence", "audit://test"];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); mocks.allowed.mockReturnValue(true); process.exitCode = undefined; });

it.each(Object.entries({ TABLE_NAME: "TableNameRequired", AWS_REGION: "AwsRegionRequired", AWS_BATCH_JOB_DEFINITION: "BatchDefinitionRequired", AWS_BATCH_JOB_BUCKET: "BatchBucketRequired", AWS_BATCH_JOB_QUEUE: "BatchQueueRequired", WORKFLOW_ARN: "WorkflowArnRequired", QSB_NETWORK: "QsbNetworkRequired" }))(
  "refuses missing %s through the real CLI before importing application configuration",
  (name, reason) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...required, AWS_EC2_METADATA_DISABLED: "true" };
    delete env[name];
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/reconcile-submission.ts", ...args], { env, encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ action: "refuse", reason });
    expect(result.stdout).toBe("");
  },
);
it("reports invalid network before module initialization", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/reconcile-submission.ts", ...args], { env: { PATH: process.env.PATH, ...required, QSB_NETWORK: "invalid" }, encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr).reason).toBe("QsbNetworkInvalid");
});
it("refuses a disabled polling route before credentials or storage reads", async () => {
  for (const [key, value] of Object.entries(required)) vi.stubEnv(key, value);
  mocks.allowed.mockReturnValue(false);
  const get = vi.spyOn(store, "get"), secretCalls = mocks.secret.mock.calls.length;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await reconcileSubmissionCli(args);
  expect(process.exitCode).toBe(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("PollingNotAllowed"));
  expect(get).not.toHaveBeenCalled();
  expect(mocks.secret.mock.calls.length).toBe(secretCalls);
});
it("the library default also refuses disabled polling before any read", async () => {
  mocks.allowed.mockReturnValue(false);
  const get = vi.spyOn(store, "get");
  await expect(reconcileUnknownSubmission({ store, owner: "owner", jobId: "job", decision: { kind: "provider-id", providerId: "provider-1", operator: "test", evidence: "audit://test" }, lookup: { status: vi.fn(), health: vi.fn() }, log: vi.fn(), resumePolling: vi.fn() })).rejects.toThrow("PollingNotAllowed");
  expect(get).not.toHaveBeenCalled();
});
it("prints the polling refusal reason, exits nonzero and preserves the attached ID", async () => {
  for (const [key, value] of Object.entries(required)) vi.stubEnv(key, value);
  const job = { id: "job", owner: "owner", vaultId: "v", status: "paused", stage: "pinning", attempt: 0, revision: 3, computeSeconds: 0, manifestHash: "a".repeat(64), manifest: {}, error: "Submission outcome unknown" } as Job;
  await store.put({ pk: "OWNER#owner", sk: "JOB#job", version: 0, job });
  await store.put({ pk: "OWNER#owner", sk: "VAULT#v", version: 0, vault: { network: "mainnet" } });
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: "public-test-placeholder" }) });
  mocks.workflow.mockRejectedValue(Object.assign(new Error(), { name: "ExecutionAlreadyExists" }));
  vi.spyOn(AwsBatch.prototype, "status").mockResolvedValue({ id: "provider-1", status: "IN_PROGRESS" });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await reconcileSubmissionCli(args);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(stdout.mock.calls[0][0] as string)).toMatchObject({ pollingStarted: false, reason: "execution-already-exists", providerId: "provider-1" });
  expect((await store.get("OWNER#owner", "JOB#job"))?.job).toMatchObject({ runpodId: "provider-1", status: "searching" });
});

it.each(["400", "499"])("CLI records immediate HTTP %s recovery without waiting TTL", async (status) => {
  for (const [key, value] of Object.entries(required)) vi.stubEnv(key, value);
  const owner = `http-${status}`, pk = `OWNER#${owner}`;
  const job = { id: "job", owner, vaultId: "v", status: "paused", stage: "pinning", attempt: 0, revision: 3, computeSeconds: 0, manifestHash: "a".repeat(64), manifest: {}, submissionStartedAt: new Date().toISOString(), error: "Submission outcome unknown" } as Job;
  await store.put({ pk, sk: "JOB#job", version: 0, job });
  await store.put({ pk, sk: "VAULT#v", version: 0, vault: { network: "mainnet" } });
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: "public-test-placeholder" }) });
  vi.spyOn(AwsBatch.prototype, "health").mockResolvedValue({ jobs: { inQueue: 0, inProgress: 0 }, workers: {} } as any);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await reconcileSubmissionCli([owner, "job", "--not-submitted", "rejected-before-acceptance", "--http-status", status, "--operator", "test", "--evidence", "audit://http"]);
  expect(process.exitCode).toBeUndefined();
  const stored = (await store.get(pk, "JOB#job"))!.job as Job;
  expect(stored.oneSubmissionAllowed).toBe(true);
  expect(stored.submissionReconciliation?.httpStatus).toBe(Number(status));
  expect((await store.list(pk, "RECONCILIATION#"))[0]!.decision).toEqual(stored.submissionReconciliation);
});
it.each([undefined, "399", "500", "timeout", "400.5"])("CLI refuses invalid rejection status %s before credential access", async (status) => {
  for (const [key, value] of Object.entries(required)) vi.stubEnv(key, value);
  const calls = mocks.secret.mock.calls.length;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await reconcileSubmissionCli(["owner", "job", "--not-submitted", "rejected-before-acceptance", ...(status === undefined ? [] : ["--http-status", status]), "--operator", "test", "--evidence", "audit://http"]);
  expect(process.exitCode).toBe(1);
  expect(mocks.secret.mock.calls.length).toBe(calls);
});


it.each([undefined, "", " ", "TRUE", "1", "false ", " true", "enabled"])(
  "mainnet CLI refuses missing or malformed explicit switch %s before initialization",
  (value) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...required, AWS_EC2_METADATA_DISABLED: "true" };
    if (value === undefined) delete env.QSB_MAINNET_ENABLED;
    else env.QSB_MAINNET_ENABLED = value;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/reconcile-submission.ts", ...args], {
      env, encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      action: "refuse",
      reason: value?.trim() ? "QsbMainnetEnabledInvalid" : "QsbMainnetEnabledRequired",
    });
    expect(result.stdout).toBe("");
  },
);
it.each(["true", "false"])("accepts an explicit mainnet switch %s for later route checks", (value) => {
  expect(reconciliationEnvironmentError({ ...required, QSB_MAINNET_ENABLED: value })).toBeUndefined();
});
it.each([undefined, "true", "false", "invalid"])("preserves testnet preflight semantics with mainnet-only switch %s", (value) => {
  expect(reconciliationEnvironmentError({ ...required, QSB_NETWORK: "testnet4", QSB_MAINNET_ENABLED: value })).toBeUndefined();
});
