import { z } from "zod";
import { workRange } from "../search-ranges";

/** Retained hit records the host is willing to publish. Not an unlimited buffer. */
export const HOST_HIT_CAPACITY = 64;
export const PINNING_ATTEMPTS = 134217728;
export const SUBSET_ATTEMPTS = 4829;
export const SUBSET_TOTAL = 82947113349100n;
const MAX_INTERVALS = 64;
const MAX_SEARCH_PINS = 64;
const MAX_ACCOUNTS = 8;

export type SearchStage = "pinning" | "round1" | "round2";

export type Interval = { start: number; end: number };

export type CoverageScope = {
  sessionId: string;
  solverPin: string;
  /** Sequence and locktime of the chosen pin. Null during the pinning sweep. */
  searchPin: string | null;
};

export type RangeOutcome =
  | { kind: "range-complete"; hitCount: number }
  | { kind: "deterministic-failure" }
  | { kind: "unsupported-geometry" }
  | { kind: "host-error" }
  | { kind: "publication-failure" }
  | { kind: "hit-capacity"; hitCount: number }
  | { kind: "exceptional-unresolved" }
  | { kind: "retry" };

const intervalSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();

const roundsSchema = z
  .object({
    round1: z.array(intervalSchema).max(MAX_INTERVALS),
    round2: z.array(intervalSchema).max(MAX_INTERVALS),
  })
  .strict();

const accountSchema = z
  .object({
    sessionId: z.string().min(1).max(300),
    solverPin: z.string().min(1).max(200),
    pinning: z.array(intervalSchema).max(MAX_INTERVALS),
    subsets: z.record(z.string().min(1).max(80), roundsSchema),
    stopped: z.boolean(),
    stopReason: z.string().max(200).nullable(),
  })
  .strict();

export const coverageLedgerSchema = z
  .object({
    accounts: z.array(accountSchema).max(MAX_ACCOUNTS),
  })
  .strict();

export type CoverageLedger = z.infer<typeof coverageLedgerSchema>;
type Account = CoverageLedger["accounts"][number];

export type CreditDecision = {
  ledger: CoverageLedger;
  credited: boolean;
  stop: boolean;
  reason: string;
  /** A credited batch, a hit, or a finished stage is not whole-range coverage. */
  wholeRangeCovered: false;
};

export function emptyLedger(): CoverageLedger {
  return { accounts: [] };
}

export function stageAttemptCount(stage: SearchStage): number {
  return stage === "pinning" ? PINNING_ATTEMPTS : SUBSET_ATTEMPTS;
}

export function publishedHitRecords(candidates: readonly string[]): number {
  let count = 0;
  for (const text of candidates) {
    const marks = text.match(/^indices=/gm);
    count += marks?.length ?? (text.length ? 1 : 0);
    if (count > HOST_HIT_CAPACITY) return count;
  }
  return count;
}

/** Closed form of the ranked batches. Every domain element is in exactly one batch. */
export function partitionIdentity(stage: SearchStage): {
  attempts: number;
  start: bigint;
  end: bigint;
} {
  const attempts = stageAttemptCount(stage);
  const first = workRange(stage, 0);
  const last = workRange(stage, attempts - 1);
  if (stage === "pinning") {
    const end =
      BigInt(last.sequence ?? 0) + BigInt(last.sequenceCount ?? 0);
    return { attempts, start: BigInt(first.sequence ?? 0), end };
  }
  return {
    attempts,
    start: BigInt(first.start),
    end: BigInt(last.start) + BigInt(last.count),
  };
}

export function coversPartition(
  intervals: readonly Interval[],
  stage: SearchStage,
): boolean {
  return (
    intervals.length === 1 &&
    intervals[0]?.start === 0 &&
    intervals[0]?.end === stageAttemptCount(stage)
  );
}

export function subsetAccounted(
  ledger: CoverageLedger,
  scope: CoverageScope,
): { round1: boolean; round2: boolean; both: boolean } {
  const account = findAccount(ledger, scope.sessionId, scope.solverPin);
  const rounds =
    scope.searchPin && account ? account.subsets[scope.searchPin] : undefined;
  const round1 = rounds ? coversPartition(rounds.round1, "round1") : false;
  const round2 = rounds ? coversPartition(rounds.round2, "round2") : false;
  return { round1, round2, both: round1 && round2 };
}

export function creditedAttempts(
  ledger: CoverageLedger,
  scope: CoverageScope,
  stage: SearchStage,
): readonly Interval[] {
  const account = findAccount(ledger, scope.sessionId, scope.solverPin);
  if (!account) return [];
  if (stage === "pinning") return account.pinning;
  if (!scope.searchPin) return [];
  return account.subsets[scope.searchPin]?.[stage] ?? [];
}

/**
 * A replacement session starts empty. Credits already stored for another
 * session id stay there and are not copied.
 */
export function replaceSession(
  ledger: CoverageLedger,
  next: { sessionId: string; solverPin: string },
): CoverageLedger {
  if (findAccount(ledger, next.sessionId, next.solverPin)) return ledger;
  if (ledger.accounts.length >= MAX_ACCOUNTS) return ledger;
  return {
    accounts: [
      ...ledger.accounts,
      {
        sessionId: next.sessionId,
        solverPin: next.solverPin,
        pinning: [],
        subsets: {},
        stopped: false,
        stopReason: null,
      },
    ],
  };
}

export function applyRange(
  ledger: CoverageLedger,
  scope: CoverageScope,
  stage: SearchStage,
  attempt: number,
  outcome: RangeOutcome,
): CreditDecision {
  const next = structuredClone(ledger);
  const account = ensureAccount(next, scope);
  if (!account) {
    return {
      ledger: next,
      credited: false,
      stop: true,
      reason: "coverage-account-full",
      wholeRangeCovered: false,
    };
  }
  const refuse = (reason: string, stop: boolean): CreditDecision => {
    if (stop && !account.stopped) {
      account.stopped = true;
      account.stopReason = reason;
    }
    return {
      ledger: next,
      credited: false,
      stop: account.stopped,
      reason: account.stopReason ?? reason,
      wholeRangeCovered: false,
    };
  };
  if (account.stopped) return refuse(account.stopReason ?? "stopped", true);
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= stageAttemptCount(stage))
    return refuse("unsupported-geometry", true);
  if ((stage === "round1" || stage === "round2") && !scope.searchPin)
    return refuse("unsupported-geometry", true);
  switch (outcome.kind) {
    case "retry":
      return {
        ledger: next,
        credited: false,
        stop: false,
        reason: "retry-without-credit",
        wholeRangeCovered: false,
      };
    case "deterministic-failure":
    case "unsupported-geometry":
    case "host-error":
    case "publication-failure":
    case "exceptional-unresolved":
      return refuse(outcome.kind, true);
    case "hit-capacity":
      return refuse("hit-capacity", true);
    case "range-complete": {
      if (
        !Number.isSafeInteger(outcome.hitCount) ||
        outcome.hitCount < 0 ||
        outcome.hitCount > HOST_HIT_CAPACITY
      )
        return refuse("hit-capacity", true);
      const placed = placeAttempt(account, scope, stage, attempt);
      if (placed === "overflow") return refuse("coverage-account-full", true);
      return {
        ledger: next,
        credited: placed === "added",
        stop: false,
        reason: placed === "added" ? "credited" : "already-credited",
        wholeRangeCovered: false,
      };
    }
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`Unhandled range outcome: ${JSON.stringify(neverOutcome)}`);
    }
  }
}

function findAccount(
  ledger: CoverageLedger,
  sessionId: string,
  solverPin: string,
): Account | undefined {
  return ledger.accounts.find(
    (account) =>
      account.sessionId === sessionId && account.solverPin === solverPin,
  );
}

function ensureAccount(
  ledger: CoverageLedger,
  scope: CoverageScope,
): Account | undefined {
  const found = findAccount(ledger, scope.sessionId, scope.solverPin);
  if (found) return found;
  if (ledger.accounts.length >= MAX_ACCOUNTS) return undefined;
  const created: Account = {
    sessionId: scope.sessionId,
    solverPin: scope.solverPin,
    pinning: [],
    subsets: {},
    stopped: false,
    stopReason: null,
  };
  ledger.accounts.push(created);
  return created;
}

function placeAttempt(
  account: Account,
  scope: CoverageScope,
  stage: SearchStage,
  attempt: number,
): "added" | "present" | "overflow" {
  if (stage === "pinning") {
    const placed = insertAttempt(account.pinning, attempt);
    if (placed.overflow) return "overflow";
    account.pinning = placed.intervals;
    return placed.added ? "added" : "present";
  }
  const pin = scope.searchPin;
  if (!pin) return "overflow";
  if (!account.subsets[pin] && Object.keys(account.subsets).length >= MAX_SEARCH_PINS)
    return "overflow";
  const rounds = account.subsets[pin] ?? { round1: [], round2: [] };
  const placed = insertAttempt(rounds[stage], attempt);
  if (placed.overflow) return "overflow";
  rounds[stage] = placed.intervals;
  account.subsets[pin] = rounds;
  return placed.added ? "added" : "present";
}

export function insertAttempt(
  intervals: readonly Interval[],
  attempt: number,
): { intervals: Interval[]; added: boolean; overflow: boolean } {
  const next = intervals.map((interval) => ({ ...interval }));
  let index = 0;
  while (index < next.length && next[index]!.start <= attempt) index += 1;
  const previous = index > 0 ? next[index - 1] : undefined;
  if (previous && attempt < previous.end)
    return { intervals: next, added: false, overflow: false };
  next.splice(index, 0, { start: attempt, end: attempt + 1 });
  const merged: Interval[] = [];
  for (const interval of next) {
    const last = merged[merged.length - 1];
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  if (merged.length > MAX_INTERVALS)
    return {
      intervals: intervals.map((interval) => ({ ...interval })),
      added: false,
      overflow: true,
    };
  return { intervals: merged, added: true, overflow: false };
}
