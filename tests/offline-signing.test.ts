import { describe, it, expect, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { createOfflineRequest } from "../src/lib/offline-fixture";
import {
  validateOfflineSigningBundle,
  prepareOfflineSigning,
  unlockVerifiedOfflineSigning,
} from "../src/lib/offline-signing";
import { encryptRecovery } from "../src/lib/backup";
import { assembleQsb, validateRecovery, lockQsb } from "../src/lib/qsb";
vi.mock("../src/lib/qsb", () => ({
  lockQsb: vi.fn(),
  validateRecovery: vi.fn(),
  assembleQsb: vi.fn(),
}));
const publicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const payment = btc.p2wpkh(hex.decode(publicKey)),
  wallet = { publicKey, address: payment.address!, type: "p2wpkh" };
function bundle() {
  const scriptHex = "51".repeat(100),
    id = crypto.randomUUID();
  const state = {
    config: "A",
    hash_mode: "sha256",
    n: 150,
    t1s: 8,
    t1b: 1,
    t2s: 7,
    t2b: 2,
    hors_commitments: Array.from({ length: 2 }, () =>
      Array(150).fill("00".repeat(20)),
    ),
    dummy_sigs: Array.from({ length: 2 }, () => Array(150).fill("3000")),
    pin_r: 1,
    pin_s: 1,
    pin_sig: "3000",
    round_sigs: [
      { r: 1, s: 1, sig: "3000" },
      { r: 1, s: 1, sig: "3000" },
    ],
    full_script_hex: scriptHex,
  };
  const vault = {
    id,
    name: "Offline signing test — never fund",
    createdAt: new Date().toISOString(),
    network: "mainnet" as const,
    config: "A" as const,
    scriptHex,
    scriptHash: hex.encode(sha256(hex.decode(scriptHex))),
    publicStateJson: JSON.stringify(state),
    paymentAddress: wallet.address,
    status: "unfunded" as const,
  };
  const tx = new btc.Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  tx.addInput({
    txid: "00".repeat(32),
    index: 0,
  });
  tx.addOutput({ amount: 100000n, script: hex.decode(scriptHex) });
  tx.addOutput({ amount: 10000n, script: payment.script });
  tx.updateInput(0, { finalScriptSig: new Uint8Array([0x51]) });
  return {
    format: "qsb-offline-signing-bundle-v1",
    request: createOfflineRequest(wallet, vault),
    fixture: {
      network: "regtest",
      fundingRawTx: hex.encode(tx.toBytes(true, true)),
      manifest: {
        vaultId: id,
        funding: { txid: tx.id, vout: 0, value: "100000" },
        helper: { txid: tx.id, vout: 1, value: "10000" },
        destination: wallet.address,
        outputScript: hex.encode(payment.script),
        outputValue: "90000",
        fee: "20000",
        idempotencyKey: crypto.randomUUID(),
        costAccepted: true,
      },
    },
    solution: {
      sequence: 1,
      locktime: 0,
      round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      round2: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    },
  };
}
describe("offline signing strict boundaries", () => {
  it("accepts an exact public offline fixture", () => {
    const b = bundle();
    expect(validateOfflineSigningBundle(b, wallet).fixture.network).toBe(
      "regtest",
    );
  });
  it("rejects wrong chain, payout, amounts, input identity, script and solution indices", () => {
    const edits = [
      (b: any) => (b.fixture.network = "mainnet"),
      (b: any) => (b.fixture.manifest.fee = "19999"),
      (b: any) => (b.fixture.manifest.outputValue = "90001"),
      (b: any) => (b.fixture.manifest.helper.value = "20000"),
      (b: any) => (b.fixture.manifest.helper.vout = 0),
      (b: any) => (b.fixture.manifest.funding.txid = "ff".repeat(32)),
      (b: any) => (b.fixture.manifest.outputScript = "51"),
      (b: any) => (b.request.id = crypto.randomUUID()),
      (b: any) => (b.solution.round1[1] = 0),
      (b: any) => (b.solution.sequence = 1.5),
      (b: any) => (b.solution.private = "forbidden"),
    ];
    for (const edit of edits) {
      const b = bundle();
      edit(b);
      expect(() => validateOfflineSigningBundle(b, wallet)).toThrow();
    }
  });
  it("fails before private recovery processing and always terminates worker", async () => {
    const b = bundle();
    b.fixture.manifest.fee = "1";
    await expect(
      prepareOfflineSigning(b, wallet, "not-a-backup", "passphrase"),
    ).rejects.toThrow();
    await expect(
      unlockVerifiedOfflineSigning(
        bundle(),
        wallet,
        "wrong",
        "expected",
        "passphrase",
      ),
    ).rejects.toThrow("exact signing backup");
    expect(lockQsb).toHaveBeenCalledTimes(2);
  });
  it("seals authorization before PSBT reveal and rejects a conflicting restored intent", async () => {
    const b = bundle(),
      pass = "disposable offline signing password";
    const recovery = {
      format: "qsb-recovery-v1" as const,
      vault: b.request.vault,
      stateJson: "disposable secret mock",
    };
    const encrypted = await encryptRecovery(recovery, pass);
    const raw = new btc.Transaction({
      version: 1,
      lockTime: 0,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    raw.addInput({
      txid: b.fixture.manifest.helper.txid,
      index: 1,
      sequence: 0xfffffffe,
    });
    raw.addInput({
      txid: b.fixture.manifest.funding.txid,
      index: 0,
      sequence: 1,
    });
    raw.addOutput({ amount: 90000n, script: payment.script });
    raw.updateInput(1, { finalScriptSig: Uint8Array.of(0x51) }, true);
    vi.mocked(validateRecovery).mockResolvedValue(b.request.vault.scriptHash);
    vi.mocked(assembleQsb).mockResolvedValue(
      hex.encode(raw.toBytes(true, true)),
    );
    const staged = await prepareOfflineSigning(b, wallet, encrypted, pass);
    expect(Object.keys(staged).sort()).toEqual([
      "encryptedSigningBackup",
      "id",
      "manifestHash",
      "rawTxHash",
    ]);
    const ready = await unlockVerifiedOfflineSigning(
      b,
      wallet,
      staged.encryptedSigningBackup,
      staged.encryptedSigningBackup,
      pass,
    );
    expect(ready.transaction.inputsLength).toBe(2);
    expect(hex.encode(ready.transaction.getInput(1).finalScriptSig!)).toBe(
      "51",
    );
    await expect(
      unlockVerifiedOfflineSigning(b, wallet, encrypted, encrypted, pass),
    ).rejects.toThrow("sealed signing commitment");
    const conflicting = structuredClone(b);
    conflicting.fixture.manifest.idempotencyKey = crypto.randomUUID();
    await expect(
      prepareOfflineSigning(
        conflicting,
        wallet,
        staged.encryptedSigningBackup,
        pass,
      ),
    ).rejects.toThrow("another withdrawal");
  });
});
