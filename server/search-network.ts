import type { Job } from "../src/lib/model";
import { attachedApiErrorCode } from "./api-errors";
import { chain, ChainError } from "./chain";

export type SearchEvent = {
  owner: string;
  jobId: string;
  revision: number;
  polls?: number;
  chainReadFailures?: number;
};

/** Retry only this read-only checkpoint, never a coordinator tick or a paid POST. */
export async function checkSearchNetwork(
  event: SearchEvent,
  job: Job,
  save: () => Promise<unknown>,
  hasProviderJobs: boolean,
  hasUnknownSubmission: boolean,
) {
  try {
    await chain.assertNetwork();
  } catch (error) {
    const code = error instanceof ChainError ? error.code : attachedApiErrorCode(error);
    if (code !== "chain_unavailable") throw error;
    const failures = (event.chainReadFailures ?? 0) + 1;
    if (failures < 3)
      return {
        ...event,
        chainReadFailures: failures,
        polls: (event.polls ?? 0) + 1,
        done: false,
        waitSeconds: 15,
      };

    job.status = "paused";
    const reason = "Chain provider unavailable. Resume after checking the provider.";
    // Keep the unknown-outcome fence even when the outage precedes reconciliation.
    if (hasUnknownSubmission) {
      job.error = `Submission outcome unknown. Reconcile compute provider before resuming. ${reason}`;
      delete job.oneSubmissionAllowed;
    } else {
      job.error = `${reason}${job.error ? ` ${job.error}` : ""}`;
    }
    job.updatedAt = new Date().toISOString();
    await save();
    // The next paused tick cancels and drains existing IDs without a chain read.
    return {
      ...event,
      chainReadFailures: failures,
      polls: (event.polls ?? 0) + 1,
      done: !hasProviderJobs,
      ...(hasProviderJobs ? { waitSeconds: 5 } : {}),
    };
  }
}
