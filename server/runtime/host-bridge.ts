import { spawn } from "node:child_process";
import {
  fingerprint,
  vaultConfiguration,
  type SolverPin,
} from "../../src/lib/provenance";
import type { PublicVault, Withdrawal } from "../../src/lib/model";
import { Conflict, type Store } from "../store";
import { validateSolvedState } from "../../src/mainnet/solvedContract";
import {
  type LaunchBindings,
  type LaunchRecord,
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
  solver?: SolverPin;
  execution: {
    kind: "qsb-supervised-service-v1";
    network: "mainnet";
    profile: { id: "qsb-supervised-pin-v4-subset-v5" };
    sourceManifestFormat: "qsb-source-release-manifest-v1";
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
          current.launch.state === "terminal" ||
          current.launch.state === "uncertain" ||
          current.launch.state === "replacing" ||
          current.launch.replacement
        )
          return;
        await commit(store, current, { ...current.launch, state: "uncertain" });
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
      return next;
    case "uncertain":
      next.status = "paused";
      next.error =
        launch.providerSubmissions === 0
          ? "Submission outcome unknown. Reconcile the owned process before resuming."
          : "Submission outcome unknown. Reconcile the provider id before resuming.";
      return next;
    case "running":
      next.status = isSearchRunning(launch) ? "searching" : "queued";
      delete next.error;
      return next;
    case "terminal":
      if (launch.evidence?.outcome === "verified-hit" && launch.evidence.bundle) {
        next.status = "awaiting_authorization";
        next.solverFacts = "simulated";
        next.chainFacts = "simulated";
        next.coverage = "verified-hit-not-whole-range";
        next.solution = validateSolvedState(launch.evidence.bundle).solution;
        delete next.error;
        return next;
      }
      next.status = "paused";
      next.coverage = "none";
      return next;
    default: {
      const neverState: never = launch.state;
      throw new Error(`Unhandled launch state: ${neverState}`);
    }
  }
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
  const loaded = await loadPair(store, owner, requestId, slot);
  const { launch, job } = loaded;
  if (launch.bindings.inputHash !== inputHash || job.mainnetRequestHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
  if (launch.state !== "claimed" || launch.processStarts !== 0 || launch.replacement)
    throw new Error("LaunchRefused");
  await commit(store, loaded, {
    ...launch,
    state: "launching",
    processStarts: launch.processStarts + 1,
  });
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
    const processId = started?.processId;
    for (;;) {
      const current = await loadPair(store, owner, requestId, slot);
      if (processId && current.launch.processId === processId) break;
      if (current.launch.state !== "launching") break;
      try {
        await commit(store, current, {
          ...current.launch,
          state: "uncertain",
          ...(processId ? { processId } : {}),
        });
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
    const current = await loadPair(store, owner, requestId, slot);
    if (
      current.launch.providerId ||
      current.launch.providerSubmissions !== 1 ||
      current.launch.replacement ||
      current.launch.state === "replacing"
    )
      throw new Error("DuplicatePaidSubmission");
    return await commit(store, current, {
      ...current.launch,
      state: "running",
      providerId: submitted.providerId,
      providerOutcome: "submitted",
    });
  } catch (error) {
    const current = await loadPair(store, owner, requestId, slot);
    if (current.launch.providerOutcome !== "uncertain")
      throw new Error("DuplicatePaidSubmission");
    throw error;
  }
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
  if (
    launch.state !== "uncertain" ||
    launch.replacement ||
    launch.providerOutcome !== "uncertain" ||
    launch.providerSubmissions !== 1 ||
    launch.providerId
  )
    throw new Error("DuplicatePaidSubmission");
  return commit(store, loaded, {
    ...launch,
    state: "running",
    providerId,
    providerOutcome: "submitted",
  });
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
    const replaced = await commit(store, current, {
      ...rest,
      state: priorState,
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
    if (startedId && startedId !== launch.processId) {
      try {
        await stop(startedId);
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
  const primary = await loadPair(store, owner, requestId, 0);
  if (primary.launch.bindings.inputHash !== inputHash)
    throw new Error("ImmutableInputMismatch");
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
  await store.put({
    pk: pkOf(owner),
    sk: launchSk(requestId, 1),
    version: 0,
    launch,
  });
  return launch;
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
        reject(new Error("ProcessIdentityMissing"));
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
        reject(new Error("AcknowledgementTimeout"));
      }, boundMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else {
          acked = true;
          resolve({ processId, stdoutExclusive });
        }
      };
      const violate = () => {
        rejectExclusive(new Error("AcknowledgementRejected"));
        child.kill("SIGKILL");
        if (!acked) finish(new Error("AcknowledgementRejected"));
      };
      const consider = () => {
        if (text.endsWith("\r")) return;
        const normalized = text.replace(/\r\n/g, "\n");
        if (acked) {
          if (normalized !== expected) violate();
          return;
        }
        if (normalized === expected) finish();
        else if (!expected.startsWith(normalized))
          finish(new Error("AcknowledgementRejected"));
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
      child.on("exit", () => {
        const normalized = text.replace(/\r\n/g, "\n");
        if (normalized === expected) resolveExclusive();
        else if (acked) violate();
        else finish(new Error("ProcessExitedBeforeAck"));
      });
    });
  return { start, exits };
}
