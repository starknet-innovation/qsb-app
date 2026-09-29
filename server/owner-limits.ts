import type { Job } from "../src/lib/model";
import { Conflict, type AtomicWrite, type Row, type Store } from "./store";

/**
 * Per-owner switches for the partner phase (#85). Each one is off when unset or empty, which keeps
 * today's behaviour. They come from the deployment environment, never from a request, and they only
 * add refusals: the per-job GPU cap and every other check still apply.
 */
export type OwnerLimits = {
  /** QSB_OWNER_ALLOWLIST: when set, only these owners may register vaults, deposit, or create or resume withdrawals. */
  allowlist: ReadonlySet<string> | null;
  /** QSB_OWNER_MAX_ACTIVE_JOBS: withdrawals one owner may have queued, searching or paused at once. */
  maxActiveJobs: number | null;
  /** QSB_OWNER_MAX_GPU_SECONDS: GPU seconds reserved across all of one owner's withdrawals. Never refunded. */
  maxGpuSeconds: number | null;
};
type Env = Record<string, string | undefined>;

export class OwnerLimitsInvalid extends Error {}

function positive(env: Env, name: string): number | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new OwnerLimitsInvalid(`${name} must be a positive integer.`);
  return Number(value);
}

export function ownerAllowlist(env: Env = process.env): ReadonlySet<string> | null {
  const owners = (env.QSB_OWNER_ALLOWLIST ?? "")
    .split(",")
    .map((owner) => owner.trim())
    .filter(Boolean);
  return owners.length ? new Set(owners) : null;
}

/** True unless an allowlist is set and doesn't list this owner, exactly as signed in. */
export function ownerAllowed(owner: string, env: Env = process.env): boolean {
  return ownerAllowlist(env)?.has(owner) ?? true;
}

/** A malformed number throws: a bad deployment value refuses instead of lifting a limit. */
export function ownerLimits(env: Env = process.env): OwnerLimits {
  return {
    allowlist: ownerAllowlist(env),
    maxActiveJobs: positive(env, "QSB_OWNER_MAX_ACTIVE_JOBS"),
    maxGpuSeconds: positive(env, "QSB_OWNER_MAX_GPU_SECONDS"),
  };
}

/** Statuses whose GPU search is over for good. A withdrawal holds its owner's slot until it reaches one. */
export const SLOT_RELEASED: readonly string[] = [
  "failed",
  "awaiting_authorization",
  "submitted",
  "confirmed",
];
export const ACTIVE_JOBS_SK = "LIMIT#ACTIVE_JOBS";

/**
 * A conditional write on the owner's fence row that claims a withdrawal slot, for the same
 * transaction as the new job and its reservations; undefined when the owner holds `max` slots.
 * The fence is read before the jobs are counted, so of two creations racing for the last slot
 * one fails its transaction. A slot is released by the job's own status write: released
 * statuses never return to queued, searching or paused.
 */
export async function claimWithdrawalSlot(
  store: Store,
  owner: string,
  jobId: string,
  max: number,
): Promise<AtomicWrite | undefined> {
  const pk = `OWNER#${owner}`;
  const fence = await store.get(pk, ACTIVE_JOBS_SK);
  const active = (await store.list(pk, "JOB#")).filter(
    (row) => !SLOT_RELEASED.includes((row.job as Job | undefined)?.status as string),
  ).length;
  if (active >= max) return undefined;
  return {
    row: {
      pk,
      sk: ACTIVE_JOBS_SK,
      version: (fence?.version ?? -1) + 1,
      jobId,
      updatedAt: new Date().toISOString(),
    },
    expected: fence?.version,
  };
}

export const GPU_SECONDS_SK = "LIMIT#GPU_SECONDS";
export const OWNER_GPU_BUDGET_REACHED =
  "Owner GPU-time budget reached. Further GPU work needs a reviewed budget change.";
const OWNER_GPU_INVALID = "Owner GPU-time accounting invalid; reconcile before resuming.";

const seconds = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * One owner's GPU-seconds budget. Each paid submission charges the owner what the job has reserved
 * beyond `ownerGpuChargedSeconds`, in the same conditional write as the per-job reservation, so the
 * owner row always equals the sum of its jobs' `ownerGpuChargedSeconds`. A job that started before
 * the limit was set is charged its earlier reservations at its next paid submission.
 */
export class OwnerGpuBudget {
  private constructor(
    private readonly store: Store,
    private readonly pk: string,
    private readonly max: number,
    private readonly invalid?: string,
    private row?: Row,
  ) {}

  /** Null when no owner budget is set, so reservations are saved exactly as before. */
  static async open(
    store: Store,
    owner: string,
    max?: number | null,
  ): Promise<OwnerGpuBudget | null> {
    const pk = `OWNER#${owner}`;
    if (max === undefined)
      try {
        max = positive(process.env, "QSB_OWNER_MAX_GPU_SECONDS");
      } catch (error) {
        // Refuse every reservation, like invalid per-job accounting.
        return new OwnerGpuBudget(store, pk, 0, `${(error as Error).message} Nothing was submitted.`);
      }
    if (max === null) return null;
    return new OwnerGpuBudget(store, pk, max, undefined, await store.get(pk, GPU_SECONDS_SK));
  }

  private total(job: Job, reservedSeconds: number): number {
    if (this.invalid) throw new Error(this.invalid);
    const used = this.row?.reservedSeconds ?? 0,
      charged = job.ownerGpuChargedSeconds ?? 0;
    if (!seconds(used) || !seconds(charged) || !seconds(reservedSeconds) || reservedSeconds < charged)
      throw new Error(OWNER_GPU_INVALID);
    const total = (used as number) + reservedSeconds - charged;
    if (!seconds(total)) throw new Error(OWNER_GPU_INVALID);
    return total;
  }

  /** Whether reserving `reservedSeconds` for this job would take its owner past the budget. */
  exceeds(job: Job, reservedSeconds: number): boolean {
    return this.total(job, reservedSeconds) > this.max;
  }

  /** Throws like the per-job check, for the same pause. */
  check(job: Job, reservedSeconds: number): void {
    if (this.exceeds(job, reservedSeconds)) throw new Error(OWNER_GPU_BUDGET_REACHED);
  }

  /**
   * Write the job row and the owner row in one transaction. `reserve` runs on a copy until it
   * commits. If another withdrawal of this owner reserved first, re-read the budget and check again.
   * Returns false, having written nothing, when the budget no longer allows it.
   */
  async save(
    row: Row,
    version: number,
    job: Job,
    reservedSeconds: number,
    reserve: (job: Job) => void,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const total = this.total(job, reservedSeconds);
      if (total > this.max) return false;
      const next = structuredClone(job);
      reserve(next);
      next.ownerGpuChargedSeconds = reservedSeconds;
      const budget: Row = {
        pk: this.pk,
        sk: GPU_SECONDS_SK,
        version: (this.row?.version ?? -1) + 1,
        reservedSeconds: total,
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.store.atomicPut([
          { row: { ...row, version: version + 1, job: next }, expected: version },
          { row: budget, expected: this.row?.version },
        ]);
      } catch (error) {
        // A changed job row (a pause, say) fails as a plain save would.
        if (!(error instanceof Conflict)) throw error;
        if ((await this.store.get(row.pk, row.sk))?.version !== version) throw error;
        this.row = await this.store.get(this.pk, GPU_SECONDS_SK);
        continue;
      }
      this.row = budget;
      reserve(job);
      job.ownerGpuChargedSeconds = reservedSeconds;
      return true;
    }
    throw new Conflict("Owner GPU-time budget kept changing; nothing was submitted.");
  }
}

/**
 * Save a paid submission's intent before its POST: `reserve` records the per-job reservation and the
 * never-resubmit marker. Without an owner budget this is the plain conditional job write.
 */
export async function saveGpuReservation(
  store: Store,
  row: Row,
  version: number,
  job: Job,
  reservedSeconds: number,
  budget: OwnerGpuBudget | null,
  reserve: (job: Job) => void,
): Promise<boolean> {
  if (budget) return budget.save(row, version, job, reservedSeconds, reserve);
  reserve(job);
  await store.put({ ...row, version: version + 1, job }, version);
  return true;
}
