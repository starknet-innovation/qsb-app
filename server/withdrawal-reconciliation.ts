import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Job } from "../src/lib/model";
import type { Esplora } from "./chain";
import type { Slipstream } from "./providers";
import type { Store } from "./store";
import {
  assertStoredJobSpend,
  buildStoredSpendRecord,
} from "./job-spend-record";
import { transactionId } from "./runtime/miner-inclusion";
import { observeWithdrawal } from "./withdrawal-status";

const text = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[\x20-\x7e]+$/);
export class WithdrawalReconciliationError extends Error {}
/** Observe the original intent only. No POST, new signature, reservation release or paid work. */
export async function reconcileWithdrawal(input: {
  store: Store;
  owner: string;
  jobId: string;
  operator: string;
  evidence: string;
  chain: Esplora;
  miner: Pick<Slipstream, "status">;
  now?: string;
}) {
  const { store, owner, jobId, chain, miner } = input;
  const operator = text.parse(input.operator),
    evidence = text.parse(input.evidence);
  if (!owner || !jobId || owner.length > 200 || jobId.length > 200)
    throw new WithdrawalReconciliationError("OwnerAndJobRequired");
  const pk = `OWNER#${owner}`,
    jobRow = await store.get(pk, `JOB#${jobId}`),
    job = jobRow?.job as Job | undefined;
  if (!jobRow || !job || job.owner !== owner || job.id !== jobId || !job.txid)
    throw new WithdrawalReconciliationError("OriginalWithdrawalJobRequired");
  const intent = await store.get(pk, `TX#${job.txid}`);
  if (
    !intent ||
    intent.kind !== "exact-withdrawal" ||
    intent.jobId !== jobId ||
    intent.txid !== job.txid ||
    typeof intent.rawTxHex !== "string"
  )
    throw new WithdrawalReconciliationError("OriginalWithdrawalIntentRequired");
  const raw = intent.rawTxHex;
  if (
    transactionId(raw) !== job.txid ||
    createHash("sha256").update(raw.toLowerCase()).digest("hex") !==
      intent.rawHash
  )
    throw new WithdrawalReconciliationError("IntentBytesMismatch");
  assertStoredJobSpend(job, raw);
  if (
    !isDeepStrictEqual(buildStoredSpendRecord(job), intent.spend) ||
    !isDeepStrictEqual(job.manifest, intent.manifest)
  )
    throw new WithdrawalReconciliationError("IntentBindingMismatch");
  const observation = await observeWithdrawal(intent, chain, miner);
  const now = input.now ?? new Date().toISOString();
  const receipt = {
    operator,
    evidence,
    observedAt: now,
    resubmitted: false as const,
    ...observation,
  };
  await store.atomicPut([
    {
      row: {
        ...intent,
        version: intent.version + 1,
        status: observation.status,
        observation: receipt,
        includedTxid: observation.includedTxid,
      },
      expected: intent.version,
    },
    observation.status === "confirmed" || job.status === "confirmed"
      ? {
          row: {
            ...jobRow,
            version: jobRow.version + 1,
            job: {
              ...job,
              status:
                observation.status === "confirmed" ? "confirmed" : "submitted",
              updatedAt: now,
            },
          },
          expected: jobRow.version,
        }
      : {
          row: { ...jobRow, version: jobRow.version + 1 },
          expected: jobRow.version,
        },
  ]);
  return {
    txid: job.txid,
    status: observation.status,
    resubmitted: false as const,
    ...(observation.includedTxid
      ? { includedTxid: observation.includedTxid }
      : {}),
    ...(observation.alert ? { alert: observation.alert } : {}),
  };
}
