import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { reconciliationEnvironmentError } from "./reconciliation-environment";
import { release, type Job, type PublicVault } from "../src/lib/model";
import { NETWORK_ID } from "../src/lib/network";
import { assertSolverPin, solverRelease } from "../src/lib/provenance";
import { rehearsalAddressAllowed, transactionsEnabled } from "./network";
import { Runpod, RUNPOD_JOB_TTL_MS } from "./providers";
import { searchVersion, workRange } from "./search-ranges";
import { store as defaultStore, type Store } from "./store";

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}
const evidence = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[\x20-\x7e]+$/);
export const reconciliationDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider-id"),
      providerId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      operator: evidence,
      evidence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("not-submitted"),
      reason: z.enum(["rejected-before-acceptance", "ttl-expired"]),
      httpStatus: z.number().int().min(400).max(499).optional(),
      operator: evidence,
      evidence,
    })
    .strict()
    .superRefine((decision, ctx) => {
      if (decision.reason === "rejected-before-acceptance" && decision.httpStatus === undefined)
        ctx.addIssue({ code: "custom", path: ["httpStatus"], message: "Recorded HTTP 4xx required" });
      if (decision.reason === "ttl-expired" && decision.httpStatus !== undefined)
        ctx.addIssue({ code: "custom", path: ["httpStatus"], message: "HTTP status is only valid for rejected-before-acceptance" });
    }),
]);
export type ReconciliationDecision = z.infer<
  typeof reconciliationDecisionSchema
>;
export type SubmissionLookup = {
  status(id: string): Promise<{ id: string; status: string; output?: unknown }>;
  health(): Promise<{ jobs: { inQueue: number; inProgress: number } }>;
};
export type PollingStart = { started: boolean; reason?: string };
export type ReconciliationLog = {
  action: string;
  jobId: string;
  owner: string;
  reason?: string;
  providerId?: string;
};
export type ReconciliationResult = {
  outcome: "provider-id" | "not-submitted";
  resubmitted: false;
  providerId?: string;
  pollingStarted: boolean;
  reason?: string;
};
export function pollingStartAllowed(owner: string): boolean {
  return transactionsEnabled && rehearsalAddressAllowed(owner);
}
/** Operator-only reconciliation. Never submits or cancels work. The provider's
 * requests list is not submission history and status need not echo input.
 */
export async function reconcileUnknownSubmission(input: {
  store: Store;
  owner: string;
  jobId: string;
  decision: ReconciliationDecision;
  lookup: SubmissionLookup;
  log: (entry: ReconciliationLog) => void;
  resumePolling: (job: Job) => Promise<PollingStart>;
  pollingAllowed?: (owner: string) => boolean;
  now?: string;
}): Promise<ReconciliationResult> {
  const { store, owner, jobId, lookup, log } = input;
  const decision = reconciliationDecisionSchema.parse(input.decision);
  if (decision.kind === "provider-id" &&
      !(input.pollingAllowed ?? pollingStartAllowed)(owner))
    throw new ReconciliationError("PollingNotAllowed");
  const pk = `OWNER#${owner}`,
    sk = `JOB#${jobId}`;
  const row = await store.get(pk, sk),
    job = row?.job as Job | undefined;
  if (!row || !job) throw new ReconciliationError("JobNotFound");
  if (job.owner !== owner || job.id !== jobId)
    throw new ReconciliationError("JobIdentityMismatch");
  const recorded =
    decision.kind === "provider-id" &&
    job.status === "searching" &&
    job.runpodId === decision.providerId;
  if (
    !recorded &&
    !(
      job.status === "paused" &&
      !job.runpodId &&
      job.error?.includes("Submission outcome unknown")
    )
  )
    throw new ReconciliationError("UnknownSubmissionRequired");
  if (job.oneSubmissionAllowed)
    throw new ReconciliationError("DecisionAlreadyRecorded");
  const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
  const vault = vaultRow?.vault as PublicVault | undefined;
  if (!vault || vault.network !== NETWORK_ID)
    throw new ReconciliationError("VaultNetworkMismatch");
  if (vault.configuration && !job.solver)
    throw new ReconciliationError("SolverPinRequired");
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.kernelCommit !== release.kernelCommit ||
    selected.generatorCommit !== release.qsbCommit
  )
    throw new ReconciliationError("SolverRuntimeMismatch");
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now)))
    throw new ReconciliationError("InvalidTime");
  if (decision.kind === "provider-id") {
    const result = await lookup.status(decision.providerId);
    if (result.id !== decision.providerId)
      throw new ReconciliationError("ProviderIdMismatch");
    if (
      ![
        "IN_QUEUE",
        "IN_PROGRESS",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "TIMED_OUT",
      ].includes(result.status)
    )
      throw new ReconciliationError("ProviderStatusInvalid");
    // Completed results must carry the worker's context. CPU validation and range
    // credit still happen only in the coordinator, never in this command.
    if (result.status === "COMPLETED") {
      const output = z
        .object({
          manifestHash: z.string(),
          stage: z.string(),
          attempt: z.number(),
          kernelCommit: z.string(),
          workRange: z.record(z.string(), z.unknown()),
        })
        .parse(result.output);
      const range = workRange(job.stage, job.attempt);
      if (
        output.manifestHash !== job.manifestHash ||
        output.stage !== job.stage ||
        output.attempt !== job.attempt ||
        output.kernelCommit !== selected.kernelCommit ||
        Object.entries(range).some(([k, v]) => output.workRange[k] !== v) ||
        Object.keys(output.workRange).some((k) => !(k in range))
      )
        throw new ReconciliationError("ProviderContextMismatch");
    }
    if (recorded) {
      const polling = await input.resumePolling(job);
      return {
        outcome: "provider-id",
        providerId: decision.providerId,
        resubmitted: false,
        pollingStarted: polling.started,
        ...(!polling.started ? { reason: polling.reason ?? "polling-not-started" } : {}),
      };
    }
    job.runpodId = decision.providerId;
    job.status = "searching";
    delete job.error;
  } else {
    // A list miss, a timeout or a 5xx alone is not proof of non-acceptance.
    // Only an explicitly recorded HTTP 4xx may bypass the TTL. All other
    // outcomes require the durable full TTL; both paths still require drain.
    const health = await lookup.health();
    if (health.jobs.inQueue !== 0 || health.jobs.inProgress !== 0)
      throw new ReconciliationError("EndpointNotDrained");
    const started = Date.parse(job.submissionStartedAt ?? "");
    if (
      decision.reason === "ttl-expired" &&
      (!Number.isFinite(started) || Date.parse(now) < started + RUNPOD_JOB_TTL_MS)
    )
      throw new ReconciliationError("SubmissionTtlNotExpired");
    job.oneSubmissionAllowed = true;
  }
  const priorRevision = job.revision;
  job.revision += 1;
  job.updatedAt = now;
  delete job.retryRequested;
  job.submissionReconciliation = {
    ...decision,
    at: now,
    revision: job.revision,
  };
  await store.atomicPut([
    { row: { ...row, job, version: row.version + 1 }, expected: row.version },
    {
      row: {
        pk,
        sk: `RECONCILIATION#${jobId}#${priorRevision}`,
        version: 0,
        decision: job.submissionReconciliation,
      },
    },
  ]);
  log({
    action: decision.kind,
    owner,
    jobId,
    ...(decision.kind === "provider-id"
      ? { providerId: decision.providerId }
      : { reason: decision.reason }),
  });
  const polling =
    decision.kind === "provider-id"
      ? await input.resumePolling(job)
      : { started: false };
  return {
    outcome: decision.kind,
    resubmitted: false,
    pollingStarted: polling.started,
    ...(decision.kind === "provider-id" && !polling.started
      ? { reason: polling.reason ?? "polling-not-started" } : {}),
    ...(decision.kind === "provider-id"
      ? { providerId: decision.providerId }
      : {}),
  };
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
    const environmentError = reconciliationEnvironmentError(process.env);
    if (environmentError) throw new ReconciliationError(environmentError);
    const [owner, jobId, ...flags] = args;
    if (
      !owner ||
      !jobId ||
      !/^[\x21-\x7e]{1,200}$/.test(owner) ||
      !/^[\x21-\x7e]{1,200}$/.test(jobId)
    )
      throw new ReconciliationError("OwnerAndJobRequired");
    const options: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i],
        value = flags[i + 1];
      if (
        !key ||
        !value ||
        ![
          "--provider-id",
          "--not-submitted",
          "--operator",
          "--evidence",
          "--http-status",
        ].includes(key) ||
        key in options
      )
        throw new ReconciliationError("InvalidOptions");
      options[key] = value;
    }
    if (
      Boolean(options["--provider-id"]) === Boolean(options["--not-submitted"])
    )
      throw new ReconciliationError("ExplicitDecisionRequired");
    const decision = reconciliationDecisionSchema.parse({
      ...(options["--provider-id"]
        ? { kind: "provider-id", providerId: options["--provider-id"] }
        : { kind: "not-submitted", reason: options["--not-submitted"] }),
      ...(options["--http-status"] !== undefined
        ? { httpStatus: /^\d{3}$/.test(options["--http-status"]) ? Number(options["--http-status"]) : NaN }
        : {}),
      operator: options["--operator"],
      evidence: options["--evidence"],
    });
    if (decision.kind === "provider-id" && !pollingStartAllowed(owner))
      throw new ReconciliationError("PollingNotAllowed");
    const endpoint = await openRunpod();
    const result = await reconcileUnknownSubmission({
      store: defaultStore,
      owner,
      jobId,
      decision,
      lookup: {
        status: (id) => endpoint.status(id),
        health: () => endpoint.health(),
      },
      log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
      resumePolling: startPolling,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === "provider-id" && !result.pollingStarted)
      process.exitCode = 1;
  } catch (error) {
    const reason =
      error instanceof ReconciliationError
        ? error.message
        : "ReconciliationFailed";
    process.stderr.write(`${JSON.stringify({ action: "refuse", reason })}\n`);
    process.exitCode = 1;
  }
}
