import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore, Conflict } from "../server/store";
import { Esplora } from "../server/chain";
import { buildStoredSpendRecord } from "../server/job-spend-record";
import type { Job } from "../src/lib/model";
import { reconcileWithdrawal } from "../server/withdrawal-reconciliation";
import { observeWithdrawal } from "../server/withdrawal-status";
import { withdrawalReconciliationEnvironmentError } from "../scripts/reconcile-withdrawal";
vi.mock("../server/withdrawal-status", () => ({ observeWithdrawal: vi.fn() }));
async function fixture() {
  const destination = btc.p2wpkh(
    hex.decode(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ),
  );
  const manifest = {
    vaultId: "11111111-1111-4111-8111-111111111111",
    funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
    destination: destination.address!,
    outputScript: hex.encode(destination.script),
    outputValue: "90000",
    fee: "20000",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    costAccepted: true,
  };
  const job = {
    id: manifest.idempotencyKey,
    owner: destination.address!,
    vaultId: manifest.vaultId,
    manifest,
    status: "submitted",
    solution: {
      sequence: 0x80000000,
      locktime: 500000000,
      round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      round2: [9, 10, 11, 12, 13, 14, 15, 16, 17],
    },
  } as Job;
  const tx = new btc.Transaction({
    version: 1,
    lockTime: 500000000,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  tx.addInput({ txid: manifest.helper.txid, index: 1, sequence: 0xfffffffe });
  tx.addInput({ txid: manifest.funding.txid, index: 0, sequence: 0x80000000 });
  tx.addOutput({ script: destination.script, amount: 90000n });
  tx.updateInput(
    0,
    { finalScriptWitness: [new Uint8Array([0x30, 1]), new Uint8Array([2])] },
    true,
  );
  tx.updateInput(1, { finalScriptSig: new Uint8Array([1]) }, true);
  const raw = hex.encode(tx.toBytes(true, true));
  job.txid = tx.id;
  const store = new MemoryStore(),
    pk = "OWNER#" + job.owner;
  await store.put({ pk, sk: "JOB#" + job.id, version: 0, job });
  await store.put({
    pk,
    sk: "TX#" + job.txid,
    version: 0,
    kind: "exact-withdrawal",
    jobId: job.id,
    txid: job.txid,
    rawTxHex: raw,
    rawHash: createHash("sha256").update(raw).digest("hex"),
    manifest: job.manifest,
    spend: buildStoredSpendRecord(job),
    status: "uncertain",
  });
  // Assert that reconciliation writes only OWNER rows and cannot release reservations.
  const read = vi.spyOn(store, "get"),
    writes = vi.spyOn(store, "atomicPut");
  vi.mocked(observeWithdrawal).mockResolvedValue({
    status: "uncertain",
    chain: { confirmed: false, confirmations: 0 },
    miner: null,
    alert: undefined,
    includedTxid: undefined,
  });
  const input = {
    store,
    owner: job.owner,
    jobId: job.id,
    operator: "operator",
    evidence: "audit://incident",
    chain: new Esplora(),
    miner: { status: vi.fn() },
    now: "2026-09-25T00:00:00.000Z",
  };
  return { input, store, pk, job, raw, read, writes };
}
it("records uncertain observation on original intent without granting repost or releasing reservations", async () => {
  const f = await fixture();
  expect(await reconcileWithdrawal(f.input)).toMatchObject({
    status: "uncertain",
    resubmitted: false,
  });
  const intent = await f.store.get(f.pk, "TX#" + f.job.txid);
  expect(intent).toMatchObject({
    rawTxHex: f.raw,
    status: "uncertain",
    observation: {
      operator: "operator",
      evidence: "audit://incident",
      resubmitted: false,
    },
  });
  expect(
    f.writes.mock.calls
      .flatMap((c) => c[0])
      .every((w) => w.row.pk === f.pk && !w.remove),
  ).toBe(true);
});
it("records confirmed alternate txid while preserving original bytes/id", async () => {
  const f = await fixture();
  vi.mocked(observeWithdrawal).mockResolvedValue({
    status: "confirmed",
    chain: {
      confirmed: true,
      confirmations: 1,
      outpointMatched: true,
      outputMatched: true,
    },
    miner: null,
    alert: undefined,
    includedTxid: "aa".repeat(32),
  });
  await reconcileWithdrawal(f.input);
  expect(await f.store.get(f.pk, "TX#" + f.job.txid)).toMatchObject({
    txid: f.job.txid,
    rawTxHex: f.raw,
    includedTxid: "aa".repeat(32),
  });
  expect((await f.store.get(f.pk, "JOB#" + f.job.id))?.job).toMatchObject({
    txid: f.job.txid,
    status: "confirmed",
  });
});
it("records foreign-spend alert rather than submitting replacement", async () => {
  const f = await fixture();
  vi.mocked(observeWithdrawal).mockResolvedValue({
    status: "alert",
    chain: { confirmed: false, confirmations: 0 },
    miner: null,
    includedTxid: undefined,
    alert: "Funding spent by different outputs",
  });
  expect(await reconcileWithdrawal(f.input)).toMatchObject({
    status: "alert",
    alert: "Funding spent by different outputs",
    resubmitted: false,
  });
});
it("refuses changed bytes and owner/job mismatch before observation", async () => {
  const f = await fixture();
  vi.mocked(observeWithdrawal).mockClear();
  const row = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
  await f.store.put({ ...row, version: 1, rawHash: "00".repeat(32) }, 0);
  await expect(reconcileWithdrawal(f.input)).rejects.toThrow(
    "IntentBytesMismatch",
  );
  await expect(
    reconcileWithdrawal({ ...f.input, owner: "another" }),
  ).rejects.toThrow("OriginalWithdrawalJobRequired");
  expect(observeWithdrawal).not.toHaveBeenCalled();
});
it("does not overwrite concurrent intent change", async () => {
  const f = await fixture();
  vi.mocked(observeWithdrawal).mockImplementation(async () => {
    const row = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
    await f.store.put({ ...row, version: 1, status: "submitted" }, 0);
    return {
      status: "uncertain",
      chain: null,
      miner: null,
      alert: undefined,
      includedTxid: undefined,
    };
  });
  await expect(reconcileWithdrawal(f.input)).rejects.toBeInstanceOf(Conflict);
  expect((await f.store.get(f.pk, "TX#" + f.job.txid))?.status).toBe(
    "submitted",
  );
});
it("CLI requires explicit persistent mainnet environment without provider secret variables", () => {
  expect(withdrawalReconciliationEnvironmentError({})).toBe(
    "MainnetEnvironmentRequired",
  );
  expect(
    withdrawalReconciliationEnvironmentError({
      QSB_NETWORK: "mainnet",
      TABLE_NAME: "records",
      AWS_REGION: "eu-west-1",
    }),
  ).toBeUndefined();
});
it("a changed job version prevents publishing an observation to the intent", async () => {
  const f = await fixture();
  vi.mocked(observeWithdrawal).mockImplementation(async () => {
    const row = (await f.store.get(f.pk, "JOB#" + f.job.id))!;
    await f.store.put({ ...row, version: 1 }, 0);
    return {
      status: "uncertain",
      chain: null,
      miner: null,
      alert: undefined,
      includedTxid: undefined,
    };
  });
  await expect(reconcileWithdrawal(f.input)).rejects.toBeInstanceOf(Conflict);
  expect((await f.store.get(f.pk, "TX#" + f.job.txid))?.version).toBe(0);
});
it("accepts equivalent DynamoDB map key ordering but rejects changed manifest", async () => {
  const f = await fixture(),
    row = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
  const reversed = Object.fromEntries(
    Object.entries(row.spend as Record<string, unknown>).reverse(),
  );
  await f.store.put({ ...row, version: 1, spend: reversed }, 0);
  await reconcileWithdrawal(f.input);
  const current = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
  await f.store.put(
    {
      ...current,
      version: current.version + 1,
      manifest: { ...(current.manifest as object), fee: "1" },
    },
    current.version,
  );
  await expect(reconcileWithdrawal(f.input)).rejects.toThrow(
    "IntentBindingMismatch",
  );
});
it("downgrades prior confirmation after reorg without replacing transaction or clearing reservations", async () => {
  const f = await fixture(),
    jobRow = (await f.store.get(f.pk, "JOB#" + f.job.id))!,
    intent = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
  await f.store.put(
    { ...jobRow, version: 1, job: { ...f.job, status: "confirmed" } },
    0,
  );
  await f.store.put(
    {
      ...intent,
      version: 1,
      status: "confirmed",
      includedTxid: "aa".repeat(32),
    },
    0,
  );
  await reconcileWithdrawal(f.input);
  expect((await f.store.get(f.pk, "JOB#" + f.job.id))?.job).toMatchObject({
    status: "submitted",
    txid: f.job.txid,
  });
  const updated = await f.store.get(f.pk, "TX#" + f.job.txid);
  expect(updated).toMatchObject({ status: "uncertain", rawTxHex: f.raw });
  expect(updated?.includedTxid).toBeUndefined();
});

it.each(["conflict", "confirmed"])(
  "an outage after %s only updates the last checked time",
  async (status) => {
    const f = await fixture();
    const row = (await f.store.get(f.pk, "TX#" + f.job.txid))!;
    const saved = {
      ...row,
      status,
      version: 1,
      alert: "retained evidence",
      observation: { evidence: "original" },
    };
    await f.store.put(saved, 0);
    const jobBefore = await f.store.get(f.pk, "JOB#" + f.job.id);
    vi.mocked(observeWithdrawal).mockResolvedValue({
      status,
      chain: null,
      miner: null,
      chainUnavailable: true,
      alert: saved.alert,
      includedTxid: undefined,
    });
    await reconcileWithdrawal(f.input);
    expect(await f.store.get(f.pk, saved.sk)).toEqual({
      ...saved,
      version: 2,
      checkedAt: f.input.now,
    });
    expect(await f.store.get(f.pk, "JOB#" + f.job.id)).toEqual(jobBefore);
  },
);
