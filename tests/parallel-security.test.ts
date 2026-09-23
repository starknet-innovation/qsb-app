import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import {
  assertRecoveryAuthorization,
  bindRecoveryAssembly,
  assertRecoveryAssembly,
  decryptRecovery,
  encryptRecovery,
} from "../src/lib/backup";
import { verifyWithdrawalCommitment } from "../src/lib/transactions";
import type { Recovery, Withdrawal } from "../src/lib/model";

const address = btc.p2wpkh(
  hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  ),
).address!;
const manifest: Withdrawal = {
  vaultId: "11111111-1111-4111-8111-111111111111",
  funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
  helper: { txid: "22".repeat(32), vout: 1, value: "20000" },
  destination: address,
  outputScript: hex.encode(
    btc.p2wpkh(
      hex.decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      ),
    ).script,
  ),
  outputValue: "110000",
  fee: "10000",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  costAccepted: true,
};
const solution = {
  sequence: 2147483648,
  locktime: 500000000,
  round1: [],
  round2: [],
};
async function recovery(): Promise<Recovery> {
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = hex.encode(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(manifestJson),
      ),
    ),
  );
  return {
    format: "qsb-recovery-v1",
    stateJson: "{}",
    vault: {
      id: manifest.vaultId,
      name: "Test",
      createdAt: "2026-09-18T00:00:00.000Z",
      network: "mainnet",
      config: "A",
      scriptHex: "51",
      scriptHash: "00".repeat(32),
      paymentAddress: address,
      publicStateJson: "{}",
      status: "unfunded",
    },
    authorization: { manifestJson, manifestHash },
  };
}
function assembled() {
  const tx = new btc.Transaction({
    version: 1,
    lockTime: solution.locktime,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  tx.addInput({
    txid: manifest.helper.txid,
    index: manifest.helper.vout,
    sequence: 0xfffffffe,
  });
  tx.addInput({
    txid: manifest.funding.txid,
    index: manifest.funding.vout,
    sequence: solution.sequence,
  });
  tx.addOutput({
    script: hex.decode(manifest.outputScript),
    amount: BigInt(manifest.outputValue),
  });
  tx.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
  return tx;
}
const raw = (tx: btc.Transaction) => hex.encode(tx.toBytes(true, true));
describe("restored one-time authorization", () => {
  it("binds an authorized backup on a fresh device without local storage", async () => {
    const r = await recovery();
    await expect(
      assertRecoveryAuthorization(r, r.authorization!.manifestHash),
    ).resolves.toBeUndefined();
    await expect(
      assertRecoveryAuthorization(r, "ff".repeat(32)),
    ).rejects.toThrow("one-time keys");
  });
  it("rejects changed manifests and cross-vault authorizations before encryption", async () => {
    const r = await recovery();
    r.authorization!.manifestJson = JSON.stringify({
      ...manifest,
      outputValue: "1",
    });
    await expect(encryptRecovery(r, "long test passphrase")).rejects.toThrow(
      "inconsistent",
    );
    const other = await recovery();
    other.vault.id = crypto.randomUUID();
    await expect(assertRecoveryAuthorization(other)).rejects.toThrow(
      "inconsistent",
    );
  });
});
describe("assembled transaction commitment", () => {
  it("accepts the intended layout", () =>
    expect(() =>
      verifyWithdrawalCommitment(raw(assembled()), manifest, solution),
    ).not.toThrow());
  it.each([
    "amount",
    "destination",
    "helper",
    "sequence",
    "authorization",
  ] as const)("rejects altered %s before wallet disclosure", (field) => {
    const tx = assembled();
    if (field === "amount") tx.updateOutput(0, { amount: 109999n }, true);
    if (field === "destination")
      tx.updateOutput(0, { script: hex.decode("51") }, true);
    if (field === "helper") tx.updateInput(0, { index: 2 }, true);
    if (field === "sequence") tx.updateInput(1, { sequence: 2147483649 }, true);
    if (field === "authorization")
      tx.updateInput(1, { finalScriptSig: new Uint8Array() }, true);
    expect(() =>
      verifyWithdrawalCommitment(raw(tx), manifest, solution),
    ).toThrow("approved intent");
  });
  it("rejects an inconsistent fee even when serialized bytes match", () => {
    expect(() =>
      verifyWithdrawalCommitment(
        raw(assembled()),
        { ...manifest, fee: "9999" },
        solution,
      ),
    ).toThrow("approved intent");
  });
});

describe("immutable one-time assembly backup", () => {
  const chosen = {
    ...solution,
    round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    round2: [10, 11, 12, 13, 14, 15, 16, 17, 18],
  };
  it("requires saving a bound backup and preserves it across encryption/restoration", async () => {
    const original = await recovery(),
      bytes = raw(assembled());
    await expect(
      assertRecoveryAssembly(original, chosen, bytes),
    ).rejects.toThrow("updated assembly backup");
    const bound = await bindRecoveryAssembly(original, chosen, bytes);
    const restored = await decryptRecovery(
      await encryptRecovery(bound, "long test passphrase"),
      "long test passphrase",
    );
    await expect(
      assertRecoveryAssembly(restored, chosen, bytes),
    ).resolves.toBeUndefined();
    expect(original.authorization?.assembly).toBeUndefined();
  });
  it("rejects alternate HORS subsets, locktimes, or assembly bytes under the same manifest", async () => {
    const bytes = raw(assembled()),
      bound = await bindRecoveryAssembly(await recovery(), chosen, bytes);
    await expect(
      bindRecoveryAssembly(
        bound,
        { ...chosen, round1: [0, 1, 2, 3, 4, 5, 6, 7, 9] },
        bytes,
      ),
    ).rejects.toThrow("another QSB solution");
    await expect(
      bindRecoveryAssembly(
        bound,
        { ...chosen, locktime: chosen.locktime + 1 },
        bytes,
      ),
    ).rejects.toThrow("another QSB solution");
    await expect(
      bindRecoveryAssembly(bound, chosen, bytes + "00"),
    ).rejects.toThrow("another QSB solution");
  });
  it("rejects malformed or duplicate HORS indices before creating a backup", async () => {
    await expect(
      bindRecoveryAssembly(
        await recovery(),
        { ...chosen, round1: [0, 0, 2, 3, 4, 5, 6, 7, 8] },
        raw(assembled()),
      ),
    ).rejects.toThrow("Duplicate HORS index");
  });
});
