import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { release, type Job, type PublicVault } from "../src/lib/model";
import { NETWORK_ID } from "../src/lib/network";
import { assertSolverPin, solverRelease } from "../src/lib/provenance";
import { rehearsalAddressAllowed, transactionsEnabled } from "./network";
import { Runpod } from "./providers";
import { searchVersion } from "./search-ranges";
import { store as defaultStore, type Store } from "./store";

export class ReconciliationError extends Error {
  readonly logged: boolean;
  constructor(message: string, logged = false) {
    super(message);
    this.name = "ReconciliationError";
    this.logged = logged;
  }
}

export type ReconciliationLog = {
  action:
    | "load"
    | "check-runpod"
    | "record-provider-id"
    | "record-not-submitted"
    | "resume-polling"
    | "refuse";
  jobId: string;
  owner: string;
  providerId?: string;
  inspected?: string[];
  reason?: string;
  submissionsAllowed?: 1;
  started?: boolean;
};

export type SubmissionLookup = {
  requests(): Promise<Array<{ id: string }>>;
  status(id: string): Promise<{ id?: string; input?: unknown }>;
};

export type PollingStart = { started: boolean; reason?: string };

export type ReconciliationResult =
  | {
      outcome: "provider-id";
      providerId: string;
      resubmitted: false;
      pollingStarted: boolean;
    }
  | {
      outcome: "not-submitted";
      submissionsAllowed: 1;
      resubmitted: false;
    };

const unknownSubmission =
  "Submission outcome unknown. Reconcile Runpod before resuming.";

function refuse(message: string): never {
  throw new ReconciliationError(message, true);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownPause(job: Job): boolean {
  return (
    job.status === "paused" &&
    !job.runpodId &&
    job.error?.includes("Submission outcome unknown") === true
  );
}

function parameterKey(job: Job): string {
  return `${job.stage}:${job.solution?.sequence ?? ""}:${job.solution?.locktime ?? ""}`;
}

function selectedSolver(job: Job, vault: PublicVault) {
  if ((vault.network ?? "mainnet") !== NETWORK_ID)
    throw new ReconciliationError("VaultNetworkMismatch", true);
  if (vault.configuration && !job.solver)
    throw new ReconciliationError("SolverPinRequired", true);
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.kernelCommit !== release.kernelCommit ||
    selected.generatorCommit !== release.qsbCommit
  )
    throw new ReconciliationError("SolverRuntimeMismatch", true);
  return selected;
}

function expectedIdentity(job: Job, protocol: string, kernelCommit: string) {
  const parameterSha256 = job.parameterHashes?.[parameterKey(job)];
  if (!parameterSha256)
    throw new ReconciliationError("SubmissionIdentityUnavailable", true);
  return {
    protocol,
    kernelCommit,
    manifestHash: job.manifestHash,
    stage: job.stage,
    attempt: job.attempt,
    searchVersion,
    parameterSha256,
    ...(job.solution
      ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
      : {}),
  };
}

function inputMatches(
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const allowed = new Set([...Object.keys(expected), "parameterBase64"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return false;
  return Object.entries(expected).every(([key, value]) => input[key] === value);
}

export function pollingStartAllowed(owner: string): boolean {
  return transactionsEnabled && rehearsalAddressAllowed(owner);
}

/**
 * Check Runpod for a paused unknown submission and record one outcome.
 * This function never submits work.
 */
export async function reconcileUnknownSubmission(input: {
  store: Store;
  owner: string;
  jobId: string;
  lookup: SubmissionLookup;
  log: (entry: ReconciliationLog) => void;
  resumePolling: (job: Job) => Promise<PollingStart>;
  now?: string;
}): Promise<ReconciliationResult> {
  const { store, owner, jobId, lookup, log } = input;
  const pk = `OWNER#${owner}`;
  const sk = `JOB#${jobId}`;
  log({ action: "load", jobId, owner });
  const row = await store.get(pk, sk);
  const job = row?.job as Job | undefined;
  if (!row || !job) {
    log({ action: "refuse", jobId, owner, reason: "job-not-found" });
    return refuse("JobNotFound");
  }
  const recorded = job.status === "searching" && Boolean(job.runpodId);
  if (!unknownPause(job) && !recorded) {
    log({ action: "refuse", jobId, owner, reason: "not-unknown-submission" });
    return refuse("UnknownSubmissionRequired");
  }
  const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
  const vault = vaultRow?.vault as PublicVault | undefined;
  if (!vaultRow || !vault) {
    log({ action: "refuse", jobId, owner, reason: "vault-not-found" });
    return refuse("VaultNotFound");
  }
  let identity: ReturnType<typeof expectedIdentity>;
  try {
    const selected = selectedSolver(job, vault);
    identity = expectedIdentity(job, selected.protocol, selected.kernelCommit);
  } catch (error) {
    if (error instanceof ReconciliationError && error.logged) {
      log({ action: "refuse", jobId, owner, reason: error.message });
      throw error;
    }
    log({
      action: "refuse",
      jobId,
      owner,
      reason: "submission-identity-failed",
    });
    return refuse("SubmissionIdentityUnavailable");
  }
  let listed: Array<{ id: string }>;
  try {
    listed = await lookup.requests();
  } catch {
    log({ action: "refuse", jobId, owner, reason: "provider-check-failed" });
    return refuse("ProviderCheckIncomplete");
  }
  if (listed.length >= 1000) {
    log({ action: "refuse", jobId, owner, reason: "provider-list-truncated" });
    return refuse("ProviderCheckIncomplete");
  }
  const matches: string[] = [];
  const consider = async (providerId: string) => {
    let status: { id?: string; input?: unknown };
    try {
      status = await lookup.status(providerId);
    } catch {
      log({
        action: "refuse",
        jobId,
        owner,
        providerId,
        reason: "provider-status-failed",
      });
      return refuse("ProviderCheckIncomplete");
    }
    if (status.id && status.id !== providerId) {
      log({
        action: "refuse",
        jobId,
        owner,
        providerId,
        reason: "provider-id-mismatch",
      });
      return refuse("ProviderCheckIncomplete");
    }
    if (!isPlainObject(status.input)) {
      log({
        action: "refuse",
        jobId,
        owner,
        providerId,
        reason: "provider-input-unreadable",
      });
      return refuse("ProviderCheckIncomplete");
    }
    if (inputMatches(status.input, identity)) matches.push(providerId);
  };
  for (const request of listed) await consider(request.id);
  if (job.runpodId && !listed.some((request) => request.id === job.runpodId))
    await consider(job.runpodId);
  const found = [...new Set(matches)];
  log({
    action: "check-runpod",
    jobId,
    owner,
    inspected: listed.map((request) => request.id),
  });
  if (found.length > 1) {
    log({ action: "refuse", jobId, owner, reason: "ambiguous-provider-match" });
    return refuse("AmbiguousProviderMatch");
  }
  const now = input.now ?? new Date().toISOString();
  if (found.length === 1) {
    const providerId = found[0];
    if (!providerId) {
      log({ action: "refuse", jobId, owner, reason: "ambiguous-provider-match" });
      return refuse("AmbiguousProviderMatch");
    }
    if (recorded && job.runpodId !== providerId) {
      log({
        action: "refuse",
        jobId,
        owner,
        providerId,
        reason: "provider-id-differs",
      });
      return refuse("ProviderIdDiffers");
    }
    if (!recorded) {
      job.runpodId = providerId;
      job.status = "searching";
      delete job.error;
      delete job.oneSubmissionAllowed;
      delete job.retryRequested;
      job.revision += 1;
      job.updatedAt = now;
      await store.put({ ...row, version: row.version + 1, job }, row.version);
    }
    log({
      action: "record-provider-id",
      jobId,
      owner,
      providerId,
      ...(recorded ? { reason: "already-recorded" } : {}),
    });
    const polling = await input.resumePolling(job);
    log({
      action: "resume-polling",
      jobId,
      owner,
      providerId,
      started: polling.started,
      ...(polling.reason ? { reason: polling.reason } : {}),
    });
    return {
      outcome: "provider-id",
      providerId,
      resubmitted: false,
      pollingStarted: polling.started,
    };
  }
  if (recorded) {
    log({
      action: "refuse",
      jobId,
      owner,
      providerId: job.runpodId,
      reason: "recorded-provider-missing",
    });
    return refuse("ProviderCheckIncomplete");
  }
  job.oneSubmissionAllowed = true;
  job.status = "paused";
  job.error = unknownSubmission;
  delete job.runpodId;
  delete job.retryRequested;
  job.updatedAt = now;
  await store.put({ ...row, version: row.version + 1, job }, row.version);
  log({
    action: "record-not-submitted",
    jobId,
    owner,
    submissionsAllowed: 1,
  });
  return {
    outcome: "not-submitted",
    submissionsAllowed: 1,
    resubmitted: false,
  };
}

function assertIdentifier(value: string | undefined, label: string): string {
  if (!value || !/^[\x21-\x7e]{1,200}$/.test(value))
    throw new ReconciliationError(`Invalid${label}`);
  return value;
}

async function openRunpod(): Promise<Runpod> {
  const secretArn = process.env.RUNPOD_SECRET_ARN;
  const endpoint = process.env.RUNPOD_ENDPOINT_ID;
  if (!secretArn || !endpoint)
    throw new ReconciliationError("ComputeConfigurationRequired");
  try {
    const secret = await new SecretsManagerClient({
      region: process.env.AWS_REGION,
    }).send(new GetSecretValueCommand({ SecretId: secretArn }));
    const key = z
      .object({ apiKey: z.string().min(1) })
      .parse(JSON.parse(secret.SecretString || "{}")).apiKey;
    return new Runpod(endpoint, key);
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    throw new ReconciliationError("ComputeCredentialUnavailable");
  }
}

async function startPolling(job: Job): Promise<PollingStart> {
  if (!job.runpodId) return { started: false, reason: "provider-id-missing" };
  if (!pollingStartAllowed(job.owner))
    return { started: false, reason: "transactions-disabled" };
  const arn = process.env.WORKFLOW_ARN;
  if (!arn) return { started: false, reason: "workflow-unconfigured" };
  try {
    await new SFNClient({ region: process.env.AWS_REGION }).send(
      new StartExecutionCommand({
        stateMachineArn: arn,
        name: `${job.id}-r${job.revision}`,
        input: JSON.stringify({
          owner: job.owner,
          jobId: job.id,
          revision: job.revision,
        }),
      }),
    );
  } catch (error) {
    if ((error as Error).name === "ExecutionAlreadyExists")
      return { started: false, reason: "execution-already-exists" };
    throw new ReconciliationError("WorkflowStartFailed");
  }
  return { started: true };
}

export async function reconcileSubmissionCli(args: string[]): Promise<void> {
  try {
    if (args.length !== 2) {
      process.stderr.write(
        "Usage: npx tsx scripts/reconcile-submission.ts <owner> <job-id>\n",
      );
      process.exitCode = 1;
      return;
    }
    const owner = assertIdentifier(args[0], "owner");
    const jobId = assertIdentifier(args[1], "job-id");
    const endpoint = await openRunpod();
    const log = (entry: ReconciliationLog) => {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    };
    const result = await reconcileUnknownSubmission({
      store: defaultStore,
      owner,
      jobId,
      lookup: {
        requests: () => endpoint.requests(),
        status: (id) => endpoint.status(id),
      },
      log,
      resumePolling: (job) => startPolling(job),
    });
    switch (result.outcome) {
      case "provider-id":
      case "not-submitted":
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      default: {
        const neverOutcome: never = result;
        throw new ReconciliationError(
          `Unhandled reconciliation outcome: ${String(neverOutcome)}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof ReconciliationError) || !error.logged) {
      const reason =
        error instanceof ReconciliationError
          ? error.message
          : "reconciliation-failed";
      process.stderr.write(`${JSON.stringify({ action: "refuse", reason })}\n`);
    }
    process.exitCode = 1;
  }
}
