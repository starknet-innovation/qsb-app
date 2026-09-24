import { assertSolverPin, solverRelease } from "../src/lib/provenance";
/** Operator-created regtest jobs only. No browser/API route can create these records. */
import { z } from "zod";
import type { Row, Store } from "./store";
import type { Runpod } from "./providers";
import { release, type Job, type PublicVault } from "../src/lib/model";
import { searchVersion, workRange, subsetRank } from "./search-ranges";
import {
  type CoverageScope,
  type SearchStage,
  applyRange,
  coverageAccountStopped,
  coverageLedgerSchema,
  coversPartition,
  creditedAttempts,
  emptyLedger,
  publishedHitRecords,
} from "./runtime/coverage-ledger";
import { checkoutRoot, readHoldSolverBinding } from "./runtime/solver-review";
const slot = z.object({
  attempt: z.number().int().nonnegative(),
  id: z.string().optional(),
});
const stateSchema = z.object({
  network: z.literal("regtest"),
  slots: z.number().int().min(1).max(32),
  nextAttempt: z.number().int().nonnegative(),
  active: z.array(slot).max(32),
  cancel: z.array(z.string()).max(32),
  interrupted: z.array(slot).max(32).default([]),
  retry: z.array(z.number().int().nonnegative()).max(32).default([]),
  completed: z.number().int().nonnegative(),
  candidatesChecked: z.number().int().nonnegative(),
  coverageLedger: coverageLedgerSchema.optional(),
  nextPinAttempt: z.number().int().nonnegative().default(0),
  pinRestarts: z.number().int().nonnegative().default(0),
  parameters: z
    .object({
      parameterBase64: z.string().max(140000),
      parameterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
type Event = { owner: string; jobId: string; revision: number; polls?: number };
type Cpu = (input: unknown) => Promise<any>;
export async function validationTick(
  event: Event,
  row: Row,
  store: Store,
  runpod: Runpod,
  cpu: Cpu,
) {
  if (!event.owner.startsWith("regtest:"))
    throw Error("InvalidValidationOwner");
  const state = stateSchema.parse(row.validation),
    job = row.job as Job;
  if (event.revision !== job.revision) return { ...event, done: true };
  const vaultRow = await store.get(row.pk, `VAULT#${job.vaultId}`);
  if (vaultRow?.validationNetwork !== "regtest")
    throw Error("InvalidValidationVault");
  const vault = vaultRow.vault as PublicVault;
  const save = async () => {
    const version = row.version;
    row = { ...row, job, validation: state, version: version + 1 };
    await store.put(row, version);
  };
  const finish = (done: boolean, waitSeconds = 5) => ({
    ...event,
    done,
    waitSeconds,
    polls: (event.polls || 0) + 1,
  });
  const holdSolver = readHoldSolverBinding(checkoutRoot);
  const haltStopped = async (message: string, accountedUnitId?: string) => {
    if (accountedUnitId !== undefined)
      state.active = state.active.filter((unit) => unit.id !== accountedUnitId);
    job.status = "failed";
    job.error = message;
    await save();
    return finish(false, 0);
  };
  // Drain only ids submitted by this run before starting a new phase or stopping.
  if (state.cancel.length) {
    const id = state.cancel[0];
    const status = await runpod.status(id);
    if (["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) {
      await runpod.cancel(id);
      return finish(false, 5); // Confirm terminal status before releasing this id.
    }
    job.computeSeconds += (status.executionTime || 0) / 1000;
    state.cancel.shift();
    await save();
    return finish(false, 0);
  }
  if (["paused", "failed", "awaiting_authorization"].includes(job.status)) {
    state.interrupted = [...state.interrupted, ...state.active];
    state.cancel = state.active.flatMap((x) => (x.id ? [x.id] : []));
    state.active = [];
    await save();
    return finish(!state.cancel.length, 0);
  }
  if (state.active.some((x) => !x.id)) {
    job.status = "paused";
    job.error =
      "Validation submission outcome unknown; reconcile before resuming.";
    await save();
    return finish(false, 0);
  }
  if (vault.configuration && !job.solver) throw new Error("SolverPinRequired");
  // Legacy jobs retain the historical release explicitly, never the current default.
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.kernelCommit !== release.kernelCommit ||
    selected.generatorCommit !== release.qsbCommit
  )
    throw new Error("SolverRuntimeMismatch");
  const input = {
    publicStateJson: vault.publicStateJson,
    manifest: job.manifest,
    stage: job.stage,
    ...(job.solution
      ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
      : {}),
  };
  // Read all outstanding requests once per tick. Never resubmit an uncertain id.
  const results = await Promise.all(
    state.active.map(async (unit) => ({
      unit,
      result: await runpod.status(unit.id!),
    })),
  );
  for (const { unit, result } of results) {
    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(result.status)) {
      // Retain completed coverage; the failed unit goes back through the same
      // durable submit-intent mechanism. Failure never advances its attempt.

      job.error = `Validation compute ${result.status}; operator resume required for attempt ${unit.attempt}.`;
      job.status = "paused";
      await save();
      return finish(false, 0);
    }
    if (result.status !== "COMPLETED") continue;
    const output = z
      .object({
        status: z.string(),
        stage: z.string(),
        manifestHash: z.string(),
        attempt: z.number().int(),
        kernelCommit: z.literal(release.kernelCommit),
        checkpoint: z.string(),
        candidates: z.array(z.string().max(16384)).max(32),
        workRange: z.record(z.string(), z.unknown()),
      })
      .parse(result.output);
    const stage = searchStage(job.stage);
    const expected = workRange(stage, unit.attempt);
    if (
      output.stage !== job.stage ||
      output.manifestHash !== job.manifestHash ||
      output.attempt !== unit.attempt ||
      !sameWorkRange(output.workRange, expected)
    )
      throw Error("ValidationRangeMismatch");
    const records = publishedHitRecords(output.candidates);
    const scope = coverageScope(event, job, selected.id);
    if (records > 64) {
      const decision = applyRange(
        state.coverageLedger ?? emptyLedger(),
        scope,
        stage,
        unit.attempt,
        { kind: "hit-capacity", hitCount: records },
        holdSolver,
      );
      state.coverageLedger = decision.ledger;
      return haltStopped("Validation hit output exceeds supported capacity.");
    }
    const checked = output.candidates.length
      ? await cpu({ ...input, action: "verify", candidates: output.candidates })
      : { valid: false };
    state.candidatesChecked += output.candidates.length;
    job.computeSeconds += (result.executionTime || 0) / 1000;
    if (checked.valid === true) {
      if (output.status !== "completed" || output.checkpoint !== "range-complete") {
        const decision = applyRange(
          state.coverageLedger ?? emptyLedger(),
          scope,
          stage,
          unit.attempt,
          { kind: "deterministic-failure" },
          holdSolver,
        );
        state.coverageLedger = decision.ledger;
        return haltStopped(
          "Validation range or candidate needs independent review.",
          unit.id,
        );
      }
      const decision = applyRange(
        state.coverageLedger ?? emptyLedger(),
        scope,
        stage,
        unit.attempt,
        { kind: "range-complete", hitCount: records },
        holdSolver,
      );
      state.coverageLedger = decision.ledger;
      if (decision.stop) {
        return haltStopped(
          `Validation range stopped without credit: ${decision.reason}`,
          unit.id,
        );
      }
      if (decision.credited) state.completed++;
      if (job.stage === "pinning") {
        const hit = z
          .object({
            sequence: z
              .number()
              .int()
              .min(expected.sequence!)
              .max(expected.sequence! + expected.sequenceCount! - 1),
            locktime: z.number().int().min(500000000).max(1744599999),
          })
          .parse(checked);
        job.solution = { ...hit, round1: [], round2: [] };
        state.nextPinAttempt = unit.attempt + 1;
        job.stage = "round1";
      } else {
        const indices = z
          .array(z.number().int().min(0).max(149))
          .length(9)
          .parse(checked.indices);
        const rank = subsetRank(indices);
        if (
          rank < BigInt(expected.start) ||
          rank >= BigInt(expected.start) + BigInt(expected.count)
        )
          throw new Error("ValidationCandidateOutsideRange");
        if (new Set(indices).size !== 9 || !job.solution)
          throw Error("InvalidValidationHit");
        if (job.stage === "round1") {
          job.solution.round1 = indices;
          job.stage = "round2";
        } else if (job.stage === "round2") {
          job.solution.round2 = indices;
          job.stage = "verification";
        } else throw Error("InvalidValidationStage");
      }
      state.cancel = state.active
        .filter((x) => x.id !== unit.id)
        .flatMap((x) => (x.id ? [x.id] : []));
      state.active = [];
      state.nextAttempt = 0;
      delete state.parameters;
      delete job.error;
      job.status =
        job.stage === "verification" ? "awaiting_authorization" : "queued";
      job.attempt = 0;
      await save();
      return finish(false, 0);
    }
    if (
      (output.candidates.length && checked.derOnly !== true) ||
      output.status !== "completed" ||
      output.checkpoint !== "range-complete"
    ) {
      const decision = applyRange(
        state.coverageLedger ?? emptyLedger(),
        scope,
        stage,
        unit.attempt,
        { kind: "deterministic-failure" },
        holdSolver,
      );
      state.coverageLedger = decision.ledger;
      return haltStopped(
        "Validation range or candidate needs independent review.",
        unit.id,
      );
    }
    const decision = applyRange(
      state.coverageLedger ?? emptyLedger(),
      scope,
      stage,
      unit.attempt,
      { kind: "range-complete", hitCount: records },
      holdSolver,
    );
    state.coverageLedger = decision.ledger;
    if (decision.stop) {
      return haltStopped(
        `Validation range stopped without credit: ${decision.reason}`,
        unit.id,
      );
    }
    state.active = state.active.filter((x) => x.id !== unit.id);
    if (decision.credited) state.completed++;
  }
  if (
    coverageAccountStopped(
      state.coverageLedger,
      coverageScope(event, job, selected.id),
    )
  ) {
    return haltStopped(
      "Validation coverage stopped; this account cannot resume.",
    );
  }
  if (state.interrupted.some((unit) => !unit.id)) {
    job.status = "paused";
    job.error =
      "Validation submission outcome unknown; reconcile before resuming.";
    await save();
    return finish(false, 0);
  }
  const busy = new Set([
    ...state.active.map((unit) => unit.attempt),
    ...state.retry,
  ]);
  for (const unit of state.interrupted) {
    if (unit.id && !busy.has(unit.attempt)) {
      state.retry.push(unit.attempt);
      busy.add(unit.attempt);
    }
  }
  state.interrupted = [];
  job.updatedAt = new Date().toISOString();
  job.attempt = state.nextAttempt;
  await save();
  if (state.active.length >= state.slots) return finish(false);
  const retryAttempt = state.retry.shift();
  let attempt: number;
  if (retryAttempt !== undefined) {
    attempt = retryAttempt;
  } else {
    try {
      workRange(job.stage, state.nextAttempt);
    } catch {
      if (state.active.length) return finish(false);
      const stage = searchStage(job.stage);
      const covered = coversPartition(
        creditedAttempts(
          state.coverageLedger ?? emptyLedger(),
          coverageScope(event, job, selected.id),
          stage,
        ),
        stage,
      );
      if (!covered) {
        return haltStopped(
          "Validation stage cannot be exhausted while a range is uncredited.",
        );
      }
      if (job.stage === "round1" || job.stage === "round2") {
        // A particular pin need not have a usable digest solution. No HORS
        // secrets have been disclosed, so select a fresh pin and try again.
        job.stage = "pinning";
        job.status = "queued";
        delete job.solution;
        delete state.parameters;
        state.nextAttempt = state.nextPinAttempt;
        state.pinRestarts++;
        await save();
        return finish(false, 0);
      }
      job.status = "paused";
      job.error = "Validation stage exhausted its complete range.";
      await save();
      return finish(true);
    }
    attempt = state.nextAttempt;
  }
  if (!state.parameters) {
    state.parameters = stateSchema.shape.parameters
      .unwrap()
      .parse(await cpu({ ...input, action: "export" }));
    await save();
  }
  if (retryAttempt === undefined) state.nextAttempt++;
  const unit: { attempt: number; id?: string } = { attempt };
  state.active.push(unit);
  job.status = "searching";
  await save(); // A crash after this point pauses; it never duplicates paid work.
  const response = await runpod.run({
    protocol: selected.protocol,
    kernelCommit: selected.kernelCommit,
    manifestHash: job.manifestHash,
    stage: job.stage,
    attempt: unit.attempt,
    searchVersion,
    ...state.parameters,
    ...(job.solution
      ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
      : {}),
  });
  unit.id = response.id;
  await save();
  return finish(false, state.active.length < state.slots ? 0 : 5);
}

function sameWorkRange(
  actual: Record<string, unknown>,
  expected: {
    version: string;
    start: string;
    count: number;
    sequence?: number;
    sequenceCount?: number;
    locktime?: number;
  },
): boolean {
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every(
    (key, index) =>
      key === actualKeys[index] && actual[key] === expectedRecord[key],
  );
}

function searchStage(stage: string): SearchStage {
  if (stage === "pinning" || stage === "round1" || stage === "round2") return stage;
  throw new Error("InvalidValidationStage");
}

function coverageScope(
  event: Event,
  job: Job,
  solverPin: string,
): CoverageScope {
  return {
    sessionId: `${event.owner}/${event.jobId}`,
    solverPin,
    searchPin:
      job.stage === "pinning" || !job.solution
        ? null
        : `${job.solution.sequence}:${job.solution.locktime}`,
  };
}
