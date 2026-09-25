import { createHash } from "node:crypto";
import { createApp } from "../server/app";
import { Slipstream } from "../server/providers";
import { release } from "../src/lib/model";
import { describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { submitExact, type SubmitDependencies } from "../server/submit-exact";
import { consumeExactSubmitPermit } from "../server/exact-submit-permit";
import {
  buildStoredSpendRecord,
  type StoredSpendRecord,
} from "../server/job-spend-record";
import type { Job, PublicVault, Withdrawal } from "../src/lib/model";
import { outputScript } from "../src/lib/transactions";

const address = btc.p2wpkh(
  hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  ),
).address!;
const manifest: Withdrawal = {
  vaultId: "11111111-1111-4111-8111-111111111111",
  funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
  helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
  destination: address,
  outputScript: hex.encode(outputScript(address)),
  outputValue: "90000",
  fee: "20000",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  costAccepted: true,
};
const solution = {
  sequence: 0x80000000,
  locktime: 500000000,
  round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  round2: [9, 10, 11, 12, 13, 14, 15, 16, 17],
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: manifest.idempotencyKey,
    owner: address,
    vaultId: manifest.vaultId,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    status: "awaiting_authorization",
    stage: "verification",
    manifest,
    manifestHash: "ab".repeat(32),
    attempt: 0,
    computeSeconds: 0,
    solution,
    revision: 0,
    ...overrides,
  };
}

function signedTx(
  record: StoredSpendRecord,
  change: {
    outputScript?: string;
    outputValue?: bigint;
    extraOutput?: boolean;
    zeroSatExtraOutput?: boolean;
    helperTxid?: string;
    fundingTxid?: string;
    swapInputOrder?: boolean;
    fundingSequence?: number;
    helperSequence?: number;
    locktime?: number;
    version?: number;
    helperSighash?: number;
    witnessByte?: number;
    omitWitness?: boolean;
    omitVaultScript?: boolean;
  } = {},
): string {
  const helperInput = {
    txid: change.helperTxid ?? record.helper.txid,
    index: record.helper.vout,
    sequence: change.helperSequence ?? 0xfffffffe,
  };
  const fundingInput = {
    txid: change.fundingTxid ?? record.funding.txid,
    index: record.funding.vout,
    sequence: change.fundingSequence ?? record.sequence,
  };
  const tx = new btc.Transaction({
    version: change.version ?? 1,
    lockTime: change.locktime ?? record.locktime,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  const inputs = change.swapInputOrder
    ? [fundingInput, helperInput]
    : [helperInput, fundingInput];
  for (const input of inputs) tx.addInput(input);
  tx.addOutput({
    script: hex.decode(change.outputScript ?? record.outputScript),
    amount: change.outputValue ?? BigInt(record.outputValue),
  });
  if (change.extraOutput)
    tx.addOutput({
      script: hex.decode("51"),
      amount: 1n,
    });
  if (change.zeroSatExtraOutput)
    tx.addOutput({
      script: hex.decode("51"),
      amount: 0n,
    });
  const helperIndex = change.swapInputOrder ? 1 : 0;
  const fundingIndex = change.swapInputOrder ? 0 : 1;
  if (!change.omitWitness) {
    tx.updateInput(
      helperIndex,
      {
        finalScriptWitness: [
          Uint8Array.of(
            change.witnessByte ?? 0x30,
            change.helperSighash ?? 0x01,
          ),
          Uint8Array.of(0x02),
        ],
      },
      true,
    );
  }
  if (!change.omitVaultScript)
    tx.updateInput(fundingIndex, { finalScriptSig: Uint8Array.of(0x01) }, true);
  return hex.encode(tx.toBytes(true, true));
}

async function fixture() {
  const store = new MemoryStore();
  const stored = job(),
    pk = `OWNER#${stored.owner}`;
  const vault = {
    id: stored.vaultId,
    network: "mainnet",
    scriptHex: "51",
    paymentAddress: address,
    status: "confirmed",
    funding: manifest.funding,
  } as PublicVault;
  await store.put({ pk, sk: `JOB#${stored.id}`, version: 0, job: stored });
  await store.put({ pk, sk: `VAULT#${stored.vaultId}`, version: 0, vault });
  const chain = new Esplora("https://example.invalid");
  const unspent = vi
    .spyOn(chain, "unspent")
    .mockResolvedValue({ previousTxHex: "00", confirmations: 1 });
  const consensus = { verify: vi.fn(async () => {}) };
  const miner = {
    submit: vi.fn(async (_raw: string, _permit: unknown): Promise<unknown> => ({
      accepted: true,
    })),
  };
  const deps: SubmitDependencies = {
    store,
    chain,
    consensus,
    miner,
    enabled: true,
  };
  const raw = signedTx(buildStoredSpendRecord(stored));
  const id = btc.Transaction.fromRaw(hex.decode(raw), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  }).id;
  return { store, stored, pk, consensus, miner, deps, raw, id, unspent };
}
describe("submitExact durable one-shot submission", () => {
  it("persists intent and job pointer before the only miner POST and supplies a one-use exact permit", async () => {
    const f = await fixture();
    f.consensus.verify.mockImplementation(async () => {
      expect(await f.store.get(f.pk, `TX#${f.id}`)).toBeUndefined();
    });
    f.miner.submit.mockImplementation(async (raw, permit) => {
      expect(f.consensus.verify).toHaveBeenCalledOnce();
      const intent = await f.store.get(f.pk, `TX#${f.id}`);
      expect(intent).toMatchObject({
        kind: "exact-withdrawal",
        rawTxHex: f.raw,
        status: "uncertain",
      });
      expect(
        (await f.store.get(f.pk, `JOB#${f.stored.id}`))?.job,
      ).toMatchObject({ txid: f.id, status: "submitted" });
      consumeExactSubmitPermit(permit, raw);
      expect(() => consumeExactSubmitPermit(permit, raw)).toThrow();
      return { accepted: true };
    });
    expect(
      await submitExact(f.stored.owner, f.stored.id, f.raw, f.deps),
    ).toEqual({ txid: f.id, status: "submitted" });
    expect(f.miner.submit).toHaveBeenCalledOnce();
    expect(f.unspent).toHaveBeenCalledTimes(2);
  });
  it("disabled configuration makes no chain, consensus, or miner call", async () => {
    const f = await fixture();
    await expect(
      submitExact(f.stored.owner, f.stored.id, f.raw, {
        ...f.deps,
        enabled: false,
      }),
    ).rejects.toThrow("disabled");
    expect(f.unspent).not.toHaveBeenCalled();
    expect(f.consensus.verify).not.toHaveBeenCalled();
    expect(f.miner.submit).not.toHaveBeenCalled();
    expect(await f.store.get(f.pk, `TX#${f.id}`)).toBeUndefined();
  });
  it("consensus failure leaves no intent or job pointer and never posts", async () => {
    const f = await fixture();
    f.consensus.verify.mockRejectedValue(new Error("Invalid script"));
    await expect(
      submitExact(f.stored.owner, f.stored.id, f.raw, f.deps),
    ).rejects.toThrow("Invalid script");
    expect(await f.store.get(f.pk, `TX#${f.id}`)).toBeUndefined();
    expect(
      (await f.store.get(f.pk, `JOB#${f.stored.id}`))?.job,
    ).not.toHaveProperty("txid");
    expect(f.miner.submit).not.toHaveBeenCalled();
  });
  it("concurrent submissions both resolve but only one wins permission to POST", async () => {
    const f = await fixture();
    const outcomes = await Promise.all(
      [0, 1].map(() => submitExact(f.stored.owner, f.stored.id, f.raw, f.deps)),
    );
    expect(outcomes.every((result) => result.txid === f.id)).toBe(true);
    expect(f.miner.submit).toHaveBeenCalledOnce();
    expect(await f.store.list(f.pk, "TX#")).toHaveLength(1);
  });
  it("retains uncertain intent after timeout and never reposts on retry", async () => {
    const f = await fixture();
    f.miner.submit.mockRejectedValue(new Error("Timed out"));
    const first = await submitExact(f.stored.owner, f.stored.id, f.raw, f.deps);
    expect(first).toEqual({ txid: f.id, status: "uncertain" });
    expect(
      await submitExact(f.stored.owner, f.stored.id, f.raw, f.deps),
    ).toEqual(first);
    expect(f.miner.submit).toHaveBeenCalledOnce();
    expect(f.consensus.verify).toHaveBeenCalledOnce();
  });
  it.each([
    { outputValue: 89999n },
    { outputScript: "51" },
    { extraOutput: true },
    { fundingSequence: 0x80000001 },
  ])(
    "rejects changed exact spend %# before consensus or POST",
    async (change) => {
      const f = await fixture();
      const raw = signedTx(buildStoredSpendRecord(f.stored), change);
      await expect(
        submitExact(f.stored.owner, f.stored.id, raw, f.deps),
      ).rejects.toThrow("ExactSpendMismatch");
      expect(f.consensus.verify).not.toHaveBeenCalled();
      expect(f.miner.submit).not.toHaveBeenCalled();
      expect(await f.store.list(f.pk, "TX#")).toHaveLength(0);
    },
  );
  it("does not treat different witness bytes with the same txid as the same authorization", async () => {
    const f = await fixture();
    await submitExact(f.stored.owner, f.stored.id, f.raw, f.deps);
    const changed = signedTx(buildStoredSpendRecord(f.stored), {
      witnessByte: 0x31,
    });
    expect(
      btc.Transaction.fromRaw(hex.decode(changed), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      }).id,
    ).toBe(f.id);
    await expect(
      submitExact(f.stored.owner, f.stored.id, changed, f.deps),
    ).rejects.toThrow("intent differs");
    expect(f.miner.submit).toHaveBeenCalledOnce();
  });
  it.each(["JOB", "VAULT"])(
    "refuses a %s revision race before acquiring the intent",
    async (kind) => {
      const f = await fixture();
      f.consensus.verify.mockImplementation(async () => {
        const sk =
          kind === "JOB" ? `JOB#${f.stored.id}` : `VAULT#${f.stored.vaultId}`;
        const row = (await f.store.get(f.pk, sk))!;
        await f.store.put({ ...row, version: row.version + 1 }, row.version);
      });
      await expect(
        submitExact(f.stored.owner, f.stored.id, f.raw, f.deps),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, `TX#${f.id}`)).toBeUndefined();
      expect(f.miner.submit).not.toHaveBeenCalled();
    },
  );
});

describe("authenticated exact submit route", () => {
  async function route(enabled: boolean) {
    const f = await fixture();
    const token = "A".repeat(43);
    await f.store.put({
      pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      network: "mainnet",
      owner: f.stored.owner,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const miner = new Slipstream();
    vi.spyOn(miner, "submit").mockImplementation(async (raw, permit) => {
      await f.miner.submit(raw, permit);
      return { status: "success", message: f.id };
    });
    const app = createApp(f.store, {
      chain: f.deps.chain,
      consensus: f.consensus,
      miner,
      exactSubmit: enabled,
    });
    const post = (authorization = true) =>
      app.request(`/api/jobs/${f.stored.id}/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ rawTxHex: f.raw }),
      });
    return { ...f, post };
  }
  it("explicit server switch reaches stub submit through auth even while legacy release remains disabled", async () => {
    const f = await route(true);
    expect(release.mainnetEnabled).toBe(false);
    f.miner.submit.mockImplementation(async (raw, permit) => {
      expect(await f.store.get(f.pk, `TX#${f.id}`)).toMatchObject({
        kind: "exact-withdrawal",
        status: "uncertain",
        rawTxHex: f.raw,
        jobId: f.stored.id,
      });
      expect(
        (await f.store.get(f.pk, `JOB#${f.stored.id}`))?.job,
      ).toMatchObject({ txid: f.id, status: "submitted" });
      consumeExactSubmitPermit(permit, raw);
      return { status: "success", message: f.id };
    });
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ txid: f.id, status: "submitted" });
    expect(f.consensus.verify).toHaveBeenCalledOnce();
    expect(f.miner.submit).toHaveBeenCalledOnce();
    const retry = await f.post();
    expect(retry.status).toBe(200);
    expect(f.miner.submit).toHaveBeenCalledOnce();
  });
  it("switch off refuses authenticated request before chain and miner calls", async () => {
    const f = await route(false);
    expect((await f.post()).status).toBe(503);
    expect(f.unspent).not.toHaveBeenCalled();
    expect(f.consensus.verify).not.toHaveBeenCalled();
    expect(f.miner.submit).not.toHaveBeenCalled();
    expect(await f.store.get(f.pk, `TX#${f.id}`)).toBeUndefined();
  });
  it("enabled switch does not bypass request authentication", async () => {
    const f = await route(true);
    expect((await f.post(false)).status).toBe(401);
    expect(f.unspent).not.toHaveBeenCalled();
    expect(f.consensus.verify).not.toHaveBeenCalled();
    expect(f.miner.submit).not.toHaveBeenCalled();
  });
});
