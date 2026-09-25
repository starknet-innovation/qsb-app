import { describe, expect, it, vi } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { MemoryStore } from "../server/store";
import { release, type Job, type PublicVault, type Withdrawal } from "../src/lib/model";
import { outputScript } from "../src/lib/transactions";
import {
  assertStoredJobSpend,
  buildStoredSpendRecord,
  type StoredSpendRecord,
} from "../server/job-spend-record";
import { assertWithdrawalSpendAgainstJob } from "../server/transaction-checks";

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
          Uint8Array.of(0x30, change.helperSighash ?? 0x01),
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

function assertMismatch(rawTxHex: string, stored: Job = job()) {
  expect(() => assertWithdrawalSpendAgainstJob(stored, rawTxHex)).toThrow(
    "ExactSpendMismatch",
  );
}

describe("stored withdrawal spend record", () => {
  it("builds the record from the stored manifest and verified solution", () => {
    expect(buildStoredSpendRecord(job())).toEqual({
      helper: { txid: "22".repeat(32), vout: 1, valueSats: "10000" },
      funding: { txid: "11".repeat(32), vout: 0, valueSats: "100000" },
      outputScript: manifest.outputScript,
      outputValue: "90000",
      fee: "20000",
      sequence: solution.sequence,
      locktime: solution.locktime,
    });
    const record = buildStoredSpendRecord(job());
    expect(() =>
      assertStoredJobSpend(job(), signedTx(record)),
    ).not.toThrow();
    expect(release.mainnetEnabled).toBe(false);
    expect("broadcastAuthorized" in release).toBe(false);
  });

  it("rejects a wrong destination", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(
      signedTx(record, { outputScript: "0014" + "44".repeat(20) }),
    );
  });

  it("rejects a stored destination that differs from its unchanged output script", () => {
    const record = buildStoredSpendRecord(job());
    const otherAddress = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(7))).address!;
    const mismatched = job({ manifest: { ...manifest, destination: otherAddress } });
    assertMismatch(signedTx(record), mismatched);
    expect(() => buildStoredSpendRecord(mismatched)).toThrow("ExactSpendMismatch");
  });

  it("rejects a wrong amount when the stored fee still matches that output", () => {
    const record = buildStoredSpendRecord(job());
    const outputValue = 89999n;
    assertMismatch(signedTx(record, { outputValue }));
  });

  it("rejects a wrong fee when the signed output amount matches", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(
      signedTx(record),
      job({
        manifest: {
          ...manifest,
          outputValue: "89999",
          fee: "20001",
        },
      }),
    );
  });

  it("rejects an extra output even when the stored fee matches the summed outputs", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(
      signedTx(record, { extraOutput: true }),
      job({
        manifest: { ...manifest, fee: "19999" },
      }),
    );
  });

  it("rejects a zero-sat extra output", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { zeroSatExtraOutput: true }));
  });

  it("rejects transaction version other than 1", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { version: 2 }));
  });

  it("rejects swapped helper and funding input order", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { swapInputOrder: true }));
  });

  it("rejects a helper input sequence other than 0xfffffffe", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { helperSequence: 0x80000000 }));
  });

  it("rejects wrong inputs", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { helperTxid: "33".repeat(32) }));
    assertMismatch(
      signedTx(record, { fundingSequence: record.sequence + 1 }),
    );
  });

  it("rejects an unbalanced stored fee before trusting the signed bytes", () => {
    const unbalanced = job({
      manifest: { ...manifest, fee: "20001" },
    });
    expect(() =>
      assertStoredJobSpend(unbalanced, "00"),
    ).toThrow("ExactSpendMismatch");
  });

  it("rejects a helper signature that is not SIGHASH_ALL", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { helperSighash: 0x03 }));
  });

  it("rejects a locktime that does not match the verified solution", () => {
    const record = buildStoredSpendRecord(job());
    assertMismatch(signedTx(record, { locktime: record.locktime + 1 }));
  });

  it("binds spend for a submitted job read from storage", () => {
    const record = buildStoredSpendRecord(job());
    const submitted = job({ status: "submitted" });
    expect(() =>
      assertStoredJobSpend(submitted, signedTx(record)),
    ).not.toThrow();
  });
});

describe("submit route binds the stored spend", () => {
  const key = new Uint8Array(32).fill(7);
  const owner = btc.p2wpkh(secp256k1.getPublicKey(key)).address!;

  async function post(rawTxHex: string, stored: Job = job()) {
    const store = new MemoryStore();
    const chain = new Esplora();
    const miner = new Slipstream();
    const unspent = vi.spyOn(chain, "unspent");
    const raw = vi.spyOn(chain, "raw");
    const submit = vi.spyOn(miner, "submit");
    const test = vi.spyOn(miner, "test");
    const vault = {
      id: stored.vaultId,
      name: "Vault",
      createdAt: "2026-09-24T00:00:00.000Z",
      network: "mainnet",
      config: "A",
      scriptHex: "51",
      scriptHash: "00".repeat(32),
      paymentAddress: owner,
      publicStateJson: "{}",
      status: "confirmed",
    } as PublicVault;
    await store.put({
      pk: "OWNER#" + owner,
      sk: "VAULT#" + vault.id,
      version: 0,
      vault,
    });
    await store.put({
      pk: "OWNER#" + owner,
      sk: "JOB#" + stored.id,
      version: 0,
      job: { ...stored, owner },
    });
    const app = createApp(store, { chain, miner, enabled: true });
    const challenge = await (
      await app.request(
        new Request("http://localhost/api/auth/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: owner }),
        }),
      )
    ).json();
    const signature = Signer.sign(
      btc.WIF().encode(key),
      owner,
      challenge.message,
    );
    const session = await (
      await app.request(
        new Request("http://localhost/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: challenge.id, signature }),
        }),
      )
    ).json();
    const response = await app.request(
      new Request("http://localhost/api/jobs/" + stored.id + "/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + session.token,
        },
        body: JSON.stringify({ rawTxHex }),
      }),
    );
    return {
      status: response.status,
      body: await response.json(),
      unspent,
      raw,
      submit,
      test,
      store,
      owner,
    };
  }

  it("rejects each signed mismatch and does not broadcast", async () => {
    const record = buildStoredSpendRecord(job());
    const feeMatchedExtra = job({
      manifest: { ...manifest, fee: "19999" },
    });
    const cases: { rawTxHex: string; stored?: Job }[] = [
      {
        rawTxHex: signedTx(record, { outputScript: "0014" + "44".repeat(20) }),
      },
      { rawTxHex: signedTx(record, { outputValue: 1n }) },
      {
        rawTxHex: signedTx(record, { extraOutput: true }),
        stored: feeMatchedExtra,
      },
      { rawTxHex: signedTx(record, { helperTxid: "33".repeat(32) }) },
      { rawTxHex: signedTx(record, { version: 2 }) },
      { rawTxHex: signedTx(record, { swapInputOrder: true }) },
      { rawTxHex: signedTx(record, { helperSequence: 0x80000000 }) },
    ];
    for (const { rawTxHex, stored } of cases) {
      const result = await post(rawTxHex, stored ?? job());
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: "ExactSpendMismatch" });
      expect(result.submit).not.toHaveBeenCalled();
      expect(result.test).not.toHaveBeenCalled();
      expect(result.raw).not.toHaveBeenCalled();
      expect(result.unspent).not.toHaveBeenCalled();
      expect(
        (await result.store.get("OWNER#" + result.owner, "JOB#" + job().id))
          ?.job,
      ).toMatchObject({ status: stored?.status ?? "awaiting_authorization" });
    }
    const feeJob = job({ manifest: { ...manifest, fee: "20001" } });
    const feeResult = await post("00", feeJob);
    expect(feeResult.status).toBe(409);
    expect(feeResult.body).toMatchObject({ error: "ExactSpendMismatch" });
    expect(feeResult.submit).not.toHaveBeenCalled();
    expect(feeResult.unspent).not.toHaveBeenCalled();
    expect(release.mainnetEnabled).toBe(false);
  });

  it("accepts the binding and still refuses the permit and the miner", async () => {
    const record = buildStoredSpendRecord(job());
    const result = await post(signedTx(record));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "SpendAuthorizationRequired" });
    expect(result.submit).not.toHaveBeenCalled();
    expect(result.test).not.toHaveBeenCalled();
    expect(result.raw).not.toHaveBeenCalled();
    expect(result.unspent).not.toHaveBeenCalled();
    expect(
      (await result.store.get("OWNER#" + result.owner, "JOB#" + job().id))?.job,
    ).toMatchObject({ status: "awaiting_authorization" });
  });

  it("checks spend binding for a submitted job before refusing the permit", async () => {
    const record = buildStoredSpendRecord(job());
    const submitted = job({ status: "submitted" });
    const mismatch = await post(
      signedTx(record, { outputValue: 1n }),
      submitted,
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: "ExactSpendMismatch" });
    const match = await post(signedTx(record), submitted);
    expect(match.status).toBe(409);
    expect(match.body).toMatchObject({ error: "SpendAuthorizationRequired" });
  });
});
