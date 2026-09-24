import { spawn } from "node:child_process";
import {
  fingerprint,
  vaultConfiguration,
  type SolverPin,
} from "../../src/lib/provenance";
import type { PublicVault, Withdrawal } from "../../src/lib/model";
import { HISTORICAL_CUDA_PROGRAM_ID } from "../../src/lib/cuda-program";
import { Conflict, type Store } from "../store";
import contract from "../mainnet-capability.json";
import { compareDirectoryIdentity } from "./host-requirements";
import { validateSolvedState } from "../../src/mainnet/solvedContract";
import { coreSourceDigest } from "./package-release";
import {
  type EvidenceDirectoryIdentity,
  type LaunchBindings,
  type LaunchRecord,
  type LocalLossKind,
  type RuntimeView,
  type SimulatedHitFacts,
  isSearchRunning,
  launchBindingsSchema,
  launchRecordSchema,
  runtimeView,
  simulatedHitFactsSchema,
} from "./types";

export type SupervisedJob = {
  id: string;
  owner: string;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "queued"
    | "searching"
    | "paused"
    | "failed"
    | "awaiting_authorization"
    | "submitted"
    | "confirmed";
  stage: "pinning" | "round1" | "round2" | "verification";
  manifest: Withdrawal;
  manifestHash: string;
  mainnetRequestHash: string;
  reservationAuthorityGeneration: number;
  solver?: SolverPin;
  execution: {
    kind: "qsb-supervised-service-v1";
    network: "mainnet";
    profile: {
      id:
        | typeof HISTORICAL_CUDA_PROGRAM_ID
        | "qsb-supervised-pin-v4-subset-v5";
    };
    sourceManifestFormat: "qsb-source-release-manifest-v1";
    coreSourceManifest: string;
    nativeBinariesEnrolled: false;
    broadcastAuthorized: false;
  };
  runtime: RuntimeView;
  solverFacts: "simulated" | "not-run";
  chainFacts: "simulated" | "not-run";
  coverage: "none" | "verified-hit-not-whole-range";
  attempt: number;
  computeSeconds: number;
  revision: number;
  /** Slot that owns the single billable provider submission for this request. */
  paidProviderSlot?: number;
  error?: string;
  solution?: {
    sequence: number;
    locktime: number;
    round1: number[];
    round2: number[];
  };
};

export class OwnedProcessError extends Error {
  readonly processId?: string;
  constructor(message: string, processId?: string) {
    super(message);
    this.name = "OwnedProcessError";
    this.processId = processId;
  }
}

/** Spawn failed before a child existed. Any other pid-less failure stays stuck. */
export class SpawnNotStarted extends Error {
  constructor() {
    super("ProcessIdentityMissing");
    this.name = "SpawnNotStarted";
  }
}

export type OwnedProcessStart = () => Promise<{
  processId: string;
  /** Rejects if stdout is not exactly the acknowledgement for the process lifetime. */
  stdoutExclusive?: Promise<void>;
}>;
export type ProcessStop = (processId: string) => Promise<void>;

const PROCESS_HISTORY_LIMIT = 8;

function watchExclusiveStdout(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  started: { processId: string; stdoutExclusive?: Promise<void> },
): void {
  if (!started.stdoutExclusive) return;
  void started.stdoutExclusive.catch(async () => {
    for (;;) {
      try {
        const current = await loadPair(store, owner, requestId, slot);
        if (
          current.launch.processId !== started.processId ||
          current.launch.bindings.inputHash !== inputHash ||
          current.launch.state === "replacing" ||
          current.launch.replacement ||
          current.launch.stdoutProtocol === "violated"
        )
          return;
        const submissionInProgress =
          current.launch.state === "uncertain" &&
          current.launch.submission === "in-progress" &&
          current.launch.providerOutcome === "uncertain";
        if (current.launch.state === "uncertain" && !submissionInProgress) return;
        const next: LaunchRecord = {
          ...current.launch,
          stdoutProtocol: "violated",
        };
        if (current.launch.state === "terminal") delete next.evidence;
        else next.state = "uncertain";
        await commit(store, current, next);
        return;
      } catch (error) {
        if (error instanceof Conflict) continue;
        return;
      }
    }
  });
}
export type ProviderSubmit = () => Promise<{ providerId: string }>;

const pkOf = (owner: string) => `OWNER#${owner}`;
const launchSk = (requestId: string, slot: number) =>
  `LAUNCH#${requestId}#${slot}`;
const jobSk = (requestId: string) => `JOB#${requestId}`;

function asJob(value: unknown): SupervisedJob {
  return value as SupervisedJob;
}

function parseLaunch(value: unknown): LaunchRecord {
  return launchRecordSchema.parse(value);
}

async function loadPair(store: Store, owner: string, requestId: string, slot: number) {
  const pk = pkOf(owner);
  const launchRow = await store.get(pk, launchSk(requestId, slot));
  const jobRow = await store.get(pk, jobSk(requestId));
  if (!launchRow || !jobRow) throw new Error("LaunchNotFound");
  return {
    pk,
    launchRow,
    jobRow,
    launch: parseLaunch(launchRow.launch),
    job: asJob(jobRow.job),
  };
}

function jobForLaunch(job: SupervisedJob, launch: LaunchRecord): SupervisedJob {
  if (launch.bindings.slot !== 0 && launch.providerSubmissions > 0)
    throw new Error("DuplicatePaidSubmission");
  if (
    launch.providerSubmissions > 0 &&
    job.paidProviderSlot !== undefined &&
    job.paidProviderSlot !== launch.bindings.slot
  )
    throw new Error("DuplicatePaidSubmission");
  const paidProviderSlot =
    launch.providerSubmissions > 0 ? launch.bindings.slot : job.paidProviderSlot;
  if (launch.bindings.slot !== 0)
    return {
      ...job,
      ...(paidProviderSlot !== undefined ? { paidProviderSlot } : {}),
      updatedAt: new Date().toISOString(),
    };
  const next: SupervisedJob = {
    ...job,
    ...(paidProviderSlot !== undefined ? { paidProviderSlot } : {}),
    updatedAt: new Date().toISOString(),
    runtime: runtimeView(launch),
  };
  switch (launch.state) {
    case "claimed":
    case "launching":
    case "acknowledged":
    case "replacing":
      next.status = isSearchRunning(launch) ? "searching" : "queued";
      delete next.error;
      return withRefusedStdout(next, launch);
    case "uncertain":
      if (isSearchRunning(launch)) {
        next.status = "searching";
        delete next.error;
        return withRefusedStdout(next, launch);
      }
      next.status = "paused";
      next.error =
        launch.providerSubmissions === 0
          ? "Submission outcome unknown. Reconcile the owned process before resuming."
          : "Submission outcome unknown. Reconcile the provider id before resuming.";
      return withRefusedStdout(next, launch);
    case "running":
      next.status = isSearchRunning(launch) ? "searching" : "queued";
      delete next.error;
      return withRefusedStdout(next, launch);
    case "terminal":
      if (launch.evidence?.outcome === "verified-hit" && launch.evidence.bundle) {
        next.status = "awaiting_authorization";
        next.solverFacts = "simulated";
        next.chainFacts = "simulated";
        next.coverage = "verified-hit-not-whole-range";
        next.solution = validateSolvedState(launch.evidence.bundle).solution;
        delete next.error;
        return withRefusedStdout(next, launch);
      }
      next.status = "paused";
      next.coverage = "none";
      return withRefusedStdout(next, launch);
    default: {
      const neverState: never = launch.state;
      throw new Error(`Unhandled launch state: ${neverState}`);
    }
  }
}

function withRefusedStdout(job: SupervisedJob, launch: LaunchRecord): SupervisedJob {
  if (launch.stdoutProtocol !== "violated") return job;
  const providerId = launch.providerId ?? "unknown";
  return {
    ...job,
    error: `stdout protocol violated; provider result refused; stop provider ${providerId}`,
  };
}

type LoadedPair = Awaited<ReturnType<typeof loadPair>>;

async function commit(store: Store, loaded: LoadedPair, next: LaunchRecord) {
  const parsed = launchRecordSchema.parse(next);
  if (parsed.bindings.inputHash !== loaded.job.mainnetRequestHash)
    throw new Error("ImmutableInputMismatch");
  const nextJob = jobForLaunch(loaded.job, parsed);
  const reservesProvider =
    parsed.providerSubmissions > 0 && loaded.job.paidProviderSlot !== parsed.bindings.slot;
  const writes: Parameters<Store["atomicPut"]>[0] = [
    {
      row: {
        ...loaded.launchRow,
        launch: parsed,
        version: loaded.launchRow.version + 1,
      },
      expected: loaded.launchRow.version,
    },
  ];
  if (parsed.bindings.slot === 0 || reservesProvider) {
    writes.push({
      row: {
        ...loaded.jobRow,
        job: nextJob,
        version: loaded.jobRow.version + 1,
      },
      expected: loaded.jobRow.version,
    });
  }
  await store.atomicPut(writes);
  return parsed;
}

function assertBindingsMatch(job: SupervisedJob, vault: PublicVault, bindings: LaunchBindings) {
  if (job.owner !== bindings.owner || job.id !== bindings.requestId)
    throw new Error("OwnerMismatch");
  if (job.revision !== bindings.revision) throw new Error("RevisionMismatch");
  if (job.mainnetRequestHash !== bindings.inputHash)
    throw new Error("ImmutableInputMismatch");
  if (job.stage !== bindings.phase) throw new Error("PhaseMismatch");
  if (job.execution.profile.id !== bindings.release.profileId)
    throw new Error("ReleaseMismatch");
  const digest = coreSourceDigest(process.cwd());
  if (
    bindings.release.coreSourceManifest !== digest ||
    bindings.release.coreSourceManifest !== contract.coreSourceManifest ||
    job.execution.coreSourceManifest !== digest
  )
    throw new Error("ReleaseMismatch");
  if (
    job.execution.broadcastAuthorized !== false ||
    bindings.release.broadcastAuthorized !== false ||
    bindings.release.nativeBinariesEnrolled !== false
  )
    throw new Error("BroadcastRefused");
  if (bindings.capability !== "search-only") throw new Error("CapabilityMismatch");
  const expected = [job.manifest.funding, job.manifest.helper]
    .map((point) => `${point.txid.toLowerCase()}:${point.vout}`)
    .sort()
    .join("|");
  const actual = bindings.reservations
    .map((point) => `${point.txid.toLowerCase()}:${point.vout}`)
    .sort()
    .join("|");
  if (expected !== actual) throw new Error("ReservationMismatch");
  const configuration = vault.configuration ?? vaultConfiguration(vault);
  if (fingerprint(configuration) !== bindings.configurationHash)
    throw new Error("ConfigurationMismatch");
}

export async function claimLaunch(
  store: Store,
  vault: PublicVault,
  bindingsInput: LaunchBindings,
): Promise<LaunchRecord> {
  const bindings = launchBindingsSchema.parse(bindingsInput);
  const pk = pkOf(bindings.owner);
  const jobRow = await store.get(pk, jobSk(bindings.requestId));
  if (!jobRow) throw new Error("JobNotFound");
  const job = asJob(jobRow.job);
  assertBindingsMatch(job, vault, bindings);
  if (await store.get(pk, launchSk(bindings.requestId, bindings.slot)))
    throw new Error("LaunchExists");
  const launch: LaunchRecord = {
    bindings,
    state: "claimed",
    previousProcessIds: [],
    providerOutcome: "not-submitted",
    providerSubmissions: 0,
    processStarts: 0,
  };
  await store.atomicPut([
    { row: { pk, sk: launchSk(bindings.requestId, bindings.slot), version: 0, launch } },
    {
      row: {
        ...jobRow,
        job: jobForLaunch(job, launch),
        version: jobRow.version + 1,
      },
      expected: jobRow.version,
    },
  ]);
  return launch;
}

function canStartOwnedProcess(launch: LaunchRecord): boolean {
  if (
    launch.replacement ||
    launch.localLoss ||
    launch.providerId ||
    launch.providerSubmissions !== 0
  )
    return false;
  if (launch.providerOutcome !== "not-submitted") return false;
  if (launch.state === "claimed" && launch.processStarts === 0) return true;
  return (
    launch.state === "uncertain" &&
    launch.processId === undefined &&
    launch.spawn === "not-started"
  );
}

export async function launchOwnedProcess(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  start: OwnedProcessStart,
  now: Date,
  boundMs: number,
): Promise<LaunchRecord> {
  let loaded = await loadPair(store, owner, requestId, slot);
  const { launch, job } = loaded;
  if (launch.bindings.inputHash !== inputHash || job.mainnetRequestHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  for (;;) {
    if (!canStartOwnedProcess(loaded.launch)) throw new Error("LaunchRefused");
    const launching: LaunchRecord = {
      ...loaded.launch,
      state: "launching",
      processStarts: loaded.launch.processStarts + 1,
    };
    delete launching.spawn;
    try {
      await commit(store, loaded, launching);
      break;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      const current = await loadPair(store, owner, requestId, slot);
      if (!canStartOwnedProcess(current.launch)) throw error;
      loaded = current;
    }
  }
  let started: { processId: string; stdoutExclusive?: Promise<void> } | undefined;
  try {
    const startedProcess = await start();
    if (!startedProcess.processId) throw new Error("ProcessIdentityMissing");
    started = startedProcess;
    const acknowledged = await acknowledgeSpawned(
      store,
      owner,
      requestId,
      slot,
      inputHash,
      started.processId,
      now,
      boundMs,
    );
    watchExclusiveStdout(store, owner, requestId, slot, inputHash, started);
    return acknowledged;
  } catch (error) {
    const processId =
      started?.processId ??
      (error instanceof OwnedProcessError ? error.processId : undefined);
    const notStarted = !processId && error instanceof SpawnNotStarted;
    for (;;) {
      const current = await loadPair(store, owner, requestId, slot);
      if (processId && current.launch.processId === processId) break;
      if (current.launch.state !== "launching") break;
      const uncertain: LaunchRecord = {
        ...current.launch,
        state: "uncertain",
        ...(processId ? { processId } : {}),
      };
      if (notStarted) uncertain.spawn = "not-started";
      else delete uncertain.spawn;
      try {
        await commit(store, current, uncertain);
        break;
      } catch (persistError) {
        if (persistError instanceof Conflict) continue;
        throw persistError;
      }
    }
    throw error;
  }
}

async function acknowledgeSpawned(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  processId: string,
  now: Date,
  boundMs: number,
): Promise<LaunchRecord> {
  for (;;) {
    const current = await loadPair(store, owner, requestId, slot);
    if (current.launch.processId === processId && current.launch.state === "acknowledged")
      return current.launch;
    if (current.launch.state !== "launching") throw new Error("LaunchRefused");
    try {
      return await commit(store, current, {
        ...current.launch,
        state: "acknowledged",
        processId,
        acknowledgement: {
          kind: "process-started",
          processId,
          deadline: new Date(now.getTime() + boundMs).toISOString(),
          inputHash,
          searchSuccess: false,
          wholeRangeCovered: false,
        },
      });
    } catch (error) {
      if (error instanceof Conflict) continue;
      throw error;
    }
  }
}

export function acknowledgementExpired(launch: LaunchRecord, now: Date): boolean {
  if (!launch.acknowledgement) return false;
  return Date.parse(launch.acknowledgement.deadline) <= now.getTime();
}

export async function submitProviderOnce(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  submit: ProviderSubmit,
): Promise<LaunchRecord> {
  if (slot !== 0) throw new Error("DuplicatePaidSubmission");
  for (;;) {
    const loaded = await loadPair(store, owner, requestId, slot);
    const { launch, job } = loaded;
    if (launch.bindings.inputHash !== inputHash)
      throw new Error("ImmutableInputMismatch");
    if (job.paidProviderSlot !== undefined && job.paidProviderSlot !== slot)
      throw new Error("DuplicatePaidSubmission");
    if (
      launch.state !== "acknowledged" ||
      launch.replacement ||
      launch.localLoss ||
      launch.providerSubmissions !== 0 ||
      launch.providerOutcome !== "not-submitted" ||
      launch.providerId
    )
      throw new Error("DuplicatePaidSubmission");
    try {
      await commit(store, loaded, {
        ...launch,
        state: "uncertain",
        providerOutcome: "uncertain",
        providerSubmissions: 1,
        submission: "in-progress",
      });
      break;
    } catch (error) {
      if (error instanceof Conflict) continue;
      throw error;
    }
  }
  try {
    const submitted = await submit();
    if (!submitted.providerId) throw new Error("ProviderIdentityMissing");
    for (;;) {
      const current = await loadPair(store, owner, requestId, slot);
      if (current.launch.stdoutProtocol === "violated") {
        try {
          await persistViolatedProvider(store, current, submitted.providerId);
        } catch (error) {
          if (error instanceof Conflict) continue;
          throw error;
        }
        throw new Error("AcknowledgementRejected");
      }
      if (
        current.launch.providerId ||
        current.launch.providerSubmissions !== 1 ||
        current.launch.replacement ||
        current.launch.state === "replacing" ||
        current.launch.state !== "uncertain" ||
        current.launch.providerOutcome !== "uncertain" ||
        current.launch.submission !== "in-progress"
      )
        throw new Error("DuplicatePaidSubmission");
      const next = {
        ...current.launch,
        state: "running" as const,
        providerId: submitted.providerId,
        providerOutcome: "submitted" as const,
      };
      delete next.submission;
      try {
        return await commit(store, current, next);
      } catch (error) {
        if (error instanceof Conflict) continue;
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "AcknowledgementRejected") throw error;
    const current = await loadPair(store, owner, requestId, slot);
    if (current.launch.providerOutcome !== "uncertain")
      throw new Error("DuplicatePaidSubmission");
    throw error;
  }
}

async function persistViolatedProvider(
  store: Store,
  loaded: LoadedPair,
  providerId: string,
): Promise<void> {
  const { launch } = loaded;
  if (!providerId) throw new Error("ProviderIdentityMissing");
  if (
    launch.state === "uncertain" &&
    launch.stdoutProtocol === "violated" &&
    launch.providerOutcome === "submitted" &&
    launch.providerId === providerId &&
    launch.submission === undefined
  )
    return;
  if (
    launch.state !== "uncertain" ||
    launch.replacement ||
    launch.providerOutcome !== "uncertain" ||
    launch.providerSubmissions !== 1 ||
    launch.providerId ||
    launch.submission !== "in-progress" ||
    launch.stdoutProtocol !== "violated"
  )
    throw new Error("DuplicatePaidSubmission");
  const next: LaunchRecord = {
    ...launch,
    state: "uncertain",
    providerId,
    providerOutcome: "submitted",
    stdoutProtocol: "violated",
  };
  delete next.submission;
  await commit(store, loaded, next);
}

export async function recordLateProviderId(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  providerId: string,
): Promise<LaunchRecord> {
  if (slot !== 0) throw new Error("DuplicatePaidSubmission");
  const loaded = await loadPair(store, owner, requestId, slot);
  const { launch } = loaded;
  if (launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (!providerId) throw new Error("ProviderIdentityMissing");
  if (launch.stdoutProtocol === "violated") {
    await persistViolatedProvider(store, loaded, providerId);
    throw new Error("AcknowledgementRejected");
  }
  if (
    launch.state !== "uncertain" ||
    launch.replacement ||
    launch.providerOutcome !== "uncertain" ||
    launch.providerSubmissions !== 1 ||
    launch.providerId ||
    launch.submission !== "in-progress"
  )
    throw new Error("DuplicatePaidSubmission");
  const next = {
    ...launch,
    state: "running" as const,
    providerId,
    providerOutcome: "submitted" as const,
  };
  delete next.submission;
  return commit(store, loaded, next);
}

export async function replaceOwnedProcess(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  start: OwnedProcessStart,
  now: Date,
  boundMs: number,
  stop: ProcessStop,
): Promise<LaunchRecord> {
  const loaded = await loadPair(store, owner, requestId, slot);
  const { launch } = loaded;
  if (launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (
    (launch.state !== "acknowledged" &&
      launch.state !== "running" &&
      launch.state !== "uncertain") ||
    !launch.processId ||
    launch.replacement ||
    launch.previousProcessIds.length >= PROCESS_HISTORY_LIMIT
  )
    throw new Error("ReplaceRefused");
  // A paid submission may still be in flight. Replacing now would make its
  // provider id unrecordable, and replacement clears stdoutProtocol, which
  // would re-open a result that a stdout violation refused. Reconcile it first.
  if (launch.providerOutcome === "uncertain")
    throw new Error("ProviderSubmissionUnresolved");
  // A violated paid launch stays refused. Replacement must not clear that marker.
  if (launch.stdoutProtocol === "violated" && launch.providerOutcome === "submitted")
    throw new Error("ReplaceRefused");
  const priorState = launch.state;
  const providerSubmissions = launch.providerSubmissions;
  const providerId = launch.providerId;
  await commit(store, loaded, {
    ...launch,
    state: "replacing",
    replacement: "starting",
    processStarts: launch.processStarts + 1,
  });
  let startedId: string | undefined;
  try {
    const started = await start();
    startedId = started.processId;
    if (!started.processId || started.processId === launch.processId)
      throw new Error("ProcessIdentityMissing");
    await stop(launch.processId);
    const current = await loadPair(store, owner, requestId, slot);
    if (
      current.launch.state !== "replacing" ||
      current.launch.replacement !== "starting" ||
      current.launch.providerSubmissions !== providerSubmissions ||
      current.launch.providerId !== providerId
    )
      throw new Error("DuplicatePaidSubmission");
    const previous = current.launch.processId
      ? [...current.launch.previousProcessIds, current.launch.processId]
      : current.launch.previousProcessIds;
    const rest = { ...current.launch };
    delete rest.replacement;
    delete rest.stdoutProtocol;
    const providerFree = providerSubmissions === 0 && providerId === undefined;
    if (providerFree) delete rest.submission;
    const state = priorState === "uncertain" && providerFree ? "acknowledged" : priorState;
    const replaced = await commit(store, current, {
      ...rest,
      state,
      processId: started.processId,
      previousProcessIds: previous,
      acknowledgement: {
        kind: "process-started",
        processId: started.processId,
        deadline: new Date(now.getTime() + boundMs).toISOString(),
        inputHash,
        searchSuccess: false,
        wholeRangeCovered: false,
      },
    });
    watchExclusiveStdout(store, owner, requestId, slot, inputHash, started);
    return replaced;
  } catch (error) {
    const carried = error instanceof OwnedProcessError ? error.processId : undefined;
    const orphan = startedId ?? carried;
    if (orphan && orphan !== launch.processId) {
      try {
        await stop(orphan);
      } catch {
        // The new process is not current. The launch stays uncertain below.
      }
    }
    const current = await loadPair(store, owner, requestId, slot);
    if (current.launch.replacement === "starting") {
      await commit(store, current, {
        ...current.launch,
        state: "uncertain",
        replacement: "uncertain",
      });
    }
    throw error;
  }
}

export async function recordProcessExit(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  processId: string,
  exitCode: number,
): Promise<LaunchRecord> {
  const loaded = await loadPair(store, owner, requestId, slot);
  const { launch } = loaded;
  if (launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (
    launch.state !== "acknowledged" ||
    launch.replacement ||
    launch.processId !== processId ||
    launch.acknowledgement?.searchSuccess !== false
  )
    throw new Error("AcknowledgementIsNotSuccess");
  return commit(store, loaded, {
    ...launch,
    state: "terminal",
    evidence: {
      format: "qsb-terminal-evidence-v1",
      inputHash,
      processId,
      outcome: "process-exit",
      hitVerified: false,
      wholeRangeCovered: false,
      solverFacts: "not-run",
      chainFacts: "not-run",
      cpuVerification: "not-run",
      binariesProduced: false,
      freshSearch: false,
    },
  });
}

export async function publishSimulatedVerifiedHit(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  processId: string,
  factsInput: SimulatedHitFacts,
  bundle: unknown,
): Promise<LaunchRecord> {
  if (slot !== 0) throw new Error("DuplicatePaidSubmission");
  const facts = simulatedHitFactsSchema.parse(factsInput);
  const solved = validateSolvedState(bundle);
  if (fingerprint(solved.request) !== inputHash)
    throw new Error("ImmutableInputMismatch");
  const loaded = await loadPair(store, owner, requestId, slot);
  const { launch } = loaded;
  if (launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (launch.processId !== processId) throw new Error("StaleProcess");
  if (launch.replacement || launch.state === "replacing")
    throw new Error("ReplaceInProgress");
  if (launch.state !== "running" || !isSearchRunning(launch))
    throw new Error("AcknowledgementIsNotSuccess");
  if (launch.acknowledgement?.searchSuccess !== false)
    throw new Error("AcknowledgementIsNotSuccess");
  if (facts.wholeRangeCovered !== false || facts.freshSearch !== false)
    throw new Error("CoverageRejected");
  return commit(store, loaded, {
    ...launch,
    state: "terminal",
    evidence: {
      format: "qsb-terminal-evidence-v1",
      inputHash,
      processId,
      outcome: "verified-hit",
      hitVerified: true,
      wholeRangeCovered: false,
      solverFacts: facts.solverFacts,
      chainFacts: facts.chainFacts,
      cpuVerification: facts.cpuVerification,
      binariesProduced: false,
      freshSearch: false,
      bundle: solved,
    },
  });
}

export async function openSiblingSlot(
  store: Store,
  owner: string,
  requestId: string,
  inputHash: string,
): Promise<LaunchRecord> {
  for (;;) {
    const primary = await loadPair(store, owner, requestId, 0);
    if (primary.launch.bindings.inputHash !== inputHash)
      throw new Error("ImmutableInputMismatch");
    if (primary.launch.state === "terminal") throw new Error("PrimaryTerminal");
    if (await store.get(pkOf(owner), launchSk(requestId, 1)))
      throw new Error("LaunchExists");
    const launch: LaunchRecord = {
      bindings: { ...primary.launch.bindings, slot: 1 },
      state: "claimed",
      previousProcessIds: [],
      providerOutcome: "not-submitted",
      providerSubmissions: 0,
      processStarts: 0,
    };
    try {
      await store.atomicPut([
        {
          row: {
            pk: pkOf(owner),
            sk: launchSk(requestId, 1),
            version: 0,
            launch,
          },
        },
        {
          row: {
            ...primary.launchRow,
            version: primary.launchRow.version + 1,
          },
          expected: primary.launchRow.version,
        },
      ]);
      return launch;
    } catch (error) {
      if (error instanceof Conflict) continue;
      throw error;
    }
  }
}

export async function drainSibling(
  store: Store,
  owner: string,
  requestId: string,
  inputHash: string,
  stop?: ProcessStop,
): Promise<LaunchRecord> {
  const loaded = await loadPair(store, owner, requestId, 1);
  const { launch } = loaded;
  if (launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (launch.providerSubmissions !== 0 || launch.providerId)
    throw new Error("SiblingProviderMustBeReconciled");
  if (launch.replacement || launch.state === "replacing")
    throw new Error("ReplaceInProgress");
  if (launch.state === "terminal") {
    if (
      launch.evidence?.outcome === "process-exit" &&
      launch.providerSubmissions === 0 &&
      !launch.providerId &&
      launch.evidence.hitVerified === false &&
      launch.evidence.freshSearch === false
    ) {
      return commit(store, loaded, {
        ...launch,
        evidence: { ...launch.evidence, outcome: "drained" },
      });
    }
    return launch;
  }
  const live =
    launch.state === "launching" ||
    (launch.processId !== undefined &&
      (launch.state === "acknowledged" ||
        launch.state === "running" ||
        launch.state === "uncertain"));
  if (live) {
    if (!stop || !launch.processId) throw new Error("SiblingProcessStillLive");
    await stop(launch.processId);
    const current = await loadPair(store, owner, requestId, 1);
    if (current.launch.replacement || current.launch.state === "replacing")
      throw new Error("ReplaceInProgress");
    if (
      current.launch.processId !== launch.processId ||
      current.launch.providerSubmissions !== 0 ||
      current.launch.providerId ||
      current.launch.state === "terminal"
    )
      throw new Error("SiblingProcessStillLive");
    return commit(store, current, {
      ...current.launch,
      state: "terminal",
      evidence: {
        format: "qsb-terminal-evidence-v1",
        inputHash,
        processId: launch.processId,
        outcome: "drained",
        hitVerified: false,
        wholeRangeCovered: false,
        solverFacts: "not-run",
        chainFacts: "not-run",
        cpuVerification: "not-run",
        binariesProduced: false,
        freshSearch: false,
      },
    });
  }
  return commit(store, loaded, {
    ...launch,
    state: "terminal",
    evidence: {
      format: "qsb-terminal-evidence-v1",
      inputHash,
      processId: launch.processId ?? "not-started",
      outcome: "drained",
      hitVerified: false,
      wholeRangeCovered: false,
      solverFacts: "not-run",
      chainFacts: "not-run",
      cpuVerification: "not-run",
      binariesProduced: false,
      freshSearch: false,
    },
  });
}

export function acknowledgementLine(inputHash: string): string {
  return `QSB_ACK ${inputHash}\n`;
}

function providerTouched(launch: LaunchRecord): boolean {
  return (
    launch.providerSubmissions > 0 ||
    launch.providerOutcome !== "not-submitted" ||
    launch.providerId !== undefined
  );
}

export function applyLocalLoss(
  launch: LaunchRecord,
  kind: LocalLossKind,
  observedProcessId?: string,
): LaunchRecord {
  if (kind === "process-not-alive") {
    if (!launch.processId) throw new Error("ProcessIdentityMissing");
    if (observedProcessId && observedProcessId !== launch.processId)
      throw new Error("StaleProcess");
  }
  const next: LaunchRecord = {
    ...launch,
    localLoss: {
      kind,
      remoteStopProven: false,
      providerIdentityPreserved: true,
    },
  };
  delete next.spawn;
  if (providerTouched(launch)) {
    if (next.state !== "terminal") next.state = "uncertain";
    if (next.replacement === "starting") next.replacement = "uncertain";
  } else if (
    (kind === "evidence-directory-replaced" ||
      kind === "evidence-directory-missing") &&
    next.state !== "terminal"
  ) {
    next.state = "uncertain";
    delete next.replacement;
  } else if (launch.state === "replacing" || launch.replacement === "starting") {
    next.state = "uncertain";
    delete next.replacement;
  } else if (
    kind === "process-not-alive" &&
    launch.state === "acknowledged" &&
    launch.processId
  ) {
    next.state = "terminal";
    next.evidence = {
      format: "qsb-terminal-evidence-v1",
      inputHash: launch.bindings.inputHash,
      processId: launch.processId,
      outcome: "process-exit",
      hitVerified: false,
      wholeRangeCovered: false,
      solverFacts: "not-run",
      chainFacts: "not-run",
      cpuVerification: "not-run",
      binariesProduced: false,
      freshSearch: false,
    };
  }
  if (
    next.providerId !== launch.providerId ||
    next.providerOutcome !== launch.providerOutcome ||
    next.providerSubmissions !== launch.providerSubmissions ||
    next.processId !== launch.processId ||
    next.evidenceDirectory?.inode !== launch.evidenceDirectory?.inode
  )
    throw new Error("ProviderIdentityChanged");
  return launchRecordSchema.parse(next);
}

export async function recordLocalLoss(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  kind: LocalLossKind,
  observedProcessId?: string,
): Promise<LaunchRecord> {
  const loaded = await loadPair(store, owner, requestId, slot);
  if (loaded.launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  return commit(
    store,
    loaded,
    applyLocalLoss(loaded.launch, kind, observedProcessId),
  );
}

export async function bindEvidenceDirectory(
  store: Store,
  owner: string,
  requestId: string,
  slot: number,
  inputHash: string,
  identity: EvidenceDirectoryIdentity,
): Promise<LaunchRecord> {
  const loaded = await loadPair(store, owner, requestId, slot);
  if (loaded.launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  const existing = loaded.launch.evidenceDirectory;
  if (!existing)
    return commit(store, loaded, {
      ...loaded.launch,
      evidenceDirectory: identity,
    });
  if (compareDirectoryIdentity(existing, identity) === "intact")
    return commit(store, loaded, loaded.launch);
  return commit(
    store,
    loaded,
    applyLocalLoss(loaded.launch, "evidence-directory-replaced"),
  );
}

export function localAckStarter(
  command: string,
  args: string[],
  boundMs: number,
  inputHash: string,
): { start: OwnedProcessStart; exits: Promise<number>[] } {
  const exits: Promise<number>[] = [];
  const start: OwnedProcessStart = () =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      if (!child.pid) {
        child.once("error", () => undefined);
        reject(new SpawnNotStarted());
        return;
      }
      const processId = String(child.pid);
      exits.push(
        new Promise((resolveExit) => {
          child.once("exit", (code) => resolveExit(code ?? 1));
        }),
      );
      let text = "";
      let settled = false;
      let acked = false;
      const expected = acknowledgementLine(inputHash);
      let rejectExclusive: (error: Error) => void = () => undefined;
      let resolveExclusive: () => void = () => undefined;
      const stdoutExclusive = new Promise<void>((resolve, reject) => {
        resolveExclusive = resolve;
        rejectExclusive = reject;
      });
      stdoutExclusive.catch(() => undefined);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new OwnedProcessError("AcknowledgementTimeout", processId));
      }, boundMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(
            error instanceof OwnedProcessError
              ? error
              : new OwnedProcessError(error.message, processId),
          );
        } else {
          acked = true;
          resolve({ processId, stdoutExclusive });
        }
      };
      const violate = () => {
        rejectExclusive(new Error("AcknowledgementRejected"));
        child.kill("SIGKILL");
        if (!acked) finish(new OwnedProcessError("AcknowledgementRejected", processId));
      };
      const consider = () => {
        if (text.endsWith("\r")) return;
        const normalized = text.replace(/\r\n/g, "\n");
        if (acked) {
          if (normalized !== expected) violate();
          return;
        }
        if (normalized === expected) finish();
        else if (!expected.startsWith(normalized)) violate();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        consider();
      });
      child.stderr.on("data", () => {
        // Discard diagnostics so a full stderr pipe cannot stall the child.
      });
      child.on("error", (error) => {
        if (acked) rejectExclusive(error);
        else finish(error);
      });
      child.on("close", () => {
        if (settled && !acked) return;
        const normalized = text.replace(/\r\n/g, "\n");
        if (normalized === expected) resolveExclusive();
        else if (acked) violate();
        else finish(new OwnedProcessError("ProcessExitedBeforeAck", processId));
      });
    });
  return { start, exits };
}
