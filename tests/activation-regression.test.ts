import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  decryptRecovery,
  encryptRecovery,
  recoveryBackupFilename,
} from "../src/lib/backup";
import type { Recovery, Withdrawal } from "../src/lib/model";
import { persistentGuard } from "../src/mainnet/guard";
import {
  exactSigningIntentDisplay,
  prepareApprovedMainnetPsbt,
} from "../src/mainnet/intent";
import { finalizeMainnetHelper } from "../src/mainnet/finalizer";
import { judgeInRepoRegression } from "../server/runtime/activation";

const publicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const address = btc.p2wpkh(hex.decode(publicKey)).address!;
const passphrase = "long test passphrase";
const vaultId = "11111111-1111-4111-8111-111111111111";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

async function recovery(): Promise<Recovery> {
  const manifest: Withdrawal = {
    vaultId,
    funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "20000" },
    destination: address,
    outputScript: hex.encode(btc.p2wpkh(hex.decode(publicKey)).script),
    outputValue: "110000",
    fee: "10000",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    costAccepted: true,
  };
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
    stateJson: '{"hors_secrets":["private-only"]}',
    vault: {
      id: vaultId,
      name: "Activation regression",
      createdAt: "2026-09-23T00:00:00.000Z",
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

function signingIntent() {
  const options = { allowUnknownInputs: true, allowUnknownOutputs: true };
  const vaultScript = "51".repeat(100);
  const previous = new btc.Transaction(options);
  previous.addInput({ txid: "55".repeat(32), index: 0 });
  previous.addOutputAddress(address, 20000n);
  previous.addOutput({ script: hex.decode(vaultScript), amount: 100000n });
  const previousTxHex = hex.encode(previous.toBytes(true, true));
  const outputScript = hex.encode(btc.p2wpkh(hex.decode(publicKey)).script);
  const manifest: Withdrawal = {
    vaultId,
    funding: { txid: previous.id, vout: 1, value: "100000" },
    helper: { txid: previous.id, vout: 0, value: "20000" },
    destination: address,
    outputScript,
    outputValue: "110000",
    fee: "10000",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    costAccepted: true,
  };
  const sequence = 2147483648;
  const locktime = 500000000;
  const tx = new btc.Transaction({ ...options, version: 1, lockTime: locktime });
  tx.addInput({ txid: previous.id, index: 0, sequence: 0xfffffffe });
  tx.addInput({ txid: previous.id, index: 1, sequence });
  tx.addOutput({ script: hex.decode(outputScript), amount: 110000n });
  tx.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
  return {
    format: "qsb-mainnet-signing-intent-v1" as const,
    network: "mainnet" as const,
    genesisHash:
      "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    manifest,
    assembledTxHex: hex.encode(tx.toBytes(true, true)),
    fundingPreviousTxHex: previousTxHex,
    helperPreviousTxHex: previousTxHex,
    vaultScriptHex: vaultScript,
    helperPublicKey: publicKey,
    helperAddress: address,
    sequence,
    locktime,
  };
}

describe("section 8 in-repo regressions", () => {
  it("downloads and reimports a backup without writing the secret into the file", async () => {
    const original = await recovery();
    const downloaded = await encryptRecovery(original, passphrase);
    expect(recoveryBackupFilename(original.vault.id)).toBe(
      `qsb-recovery-${original.vault.id}.json`,
    );
    expect(downloaded).not.toContain(passphrase);
    expect(downloaded).not.toContain("private-only");
    const reimported = await decryptRecovery(downloaded, passphrase);
    expect(reimported).toEqual(original);
    await expect(decryptRecovery(downloaded, "wrong passphrase!!")).rejects.toThrow(
      "Unable to unlock",
    );
  });

  it("refuses a second one-time commitment for the same vault", async () => {
    const original = await recovery();
    const guard = persistentGuard(memoryStorage());
    guard.claim(original.vault.scriptHash, original.authorization!.manifestHash);
    expect(() =>
      guard.claim(original.vault.scriptHash, "ff".repeat(32)),
    ).toThrow("different withdrawal");
    const dropping = {
      getItem: () => null,
      setItem: () => undefined,
    };
    expect(() => persistentGuard(dropping).claim("vault", "commitment")).toThrow(
      "one-time authorization",
    );
    const downloaded = await encryptRecovery(original, passphrase);
    const restored = await decryptRecovery(downloaded, passphrase);
    expect(restored.authorization?.manifestHash).toBe(
      original.authorization?.manifestHash,
    );
    restored.authorization!.manifestHash = "ff".repeat(32);
    await expect(encryptRecovery(restored, passphrase)).rejects.toThrow(
      "inconsistent",
    );
  });

  it("shows the exact signing intent and refuses a wallet-changed transaction", () => {
    const intent = signingIntent();
    const displayed = exactSigningIntentDisplay(intent);
    const lines = Object.fromEntries(
      displayed.lines.map((line) => [line.label, line.value]),
    );
    expect(lines).toEqual({
      Chain: "Bitcoin mainnet",
      "Helper outpoint": `${intent.manifest.helper.txid}:0`,
      "Funding outpoint": `${intent.manifest.funding.txid}:1`,
      "Helper input (sats)": "20000",
      "Vault input (sats)": "100000",
      Destination: address,
      "Output (sats)": "110000",
      "Fee (sats)": "10000",
      "Exact intent hash": displayed.intentHash,
    });
    expect(displayed.broadcastAuthorized).toBe(false);
    expect(displayed.mainnetEnabled).toBe(false);
    expect(
      BigInt(lines["Helper input (sats)"]!) +
        BigInt(lines["Vault input (sats)"]!) -
        BigInt(lines["Output (sats)"]!),
    ).toBe(BigInt(lines["Fee (sats)"]!));
    const changed = {
      ...intent,
      manifest: { ...intent.manifest, fee: "9999" },
    };
    expect(() => exactSigningIntentDisplay(changed)).toThrow("Fee mismatch");

    const approval = {
      format: "qsb-mainnet-exact-approval-v1" as const,
      network: "mainnet" as const,
      intentHash: displayed.intentHash,
      action: "request-xverse-signature" as const,
      approved: true as const,
    };
    const prepared = prepareApprovedMainnetPsbt(intent, approval);
    expect(prepared.broadcastAuthorized).toBe(false);
    const source = btc.Transaction.fromPSBT(prepared.psbt, {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    const walletChanged = (amount: bigint, fundingScript: Uint8Array) => {
      const tx = new btc.Transaction({
        version: source.version,
        lockTime: source.lockTime,
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      for (let i = 0; i < source.inputsLength; i++) {
        const input = source.getInput(i);
        tx.addInput({
          txid: input.txid,
          index: input.index,
          sequence: input.sequence,
        });
      }
      const output = source.getOutput(0);
      tx.addOutput({ script: output.script, amount });
      const helper = source.getInput(0);
      const funding = source.getInput(1);
      tx.updateInput(
        0,
        {
          nonWitnessUtxo: helper.nonWitnessUtxo,
          witnessUtxo: helper.witnessUtxo,
        },
        true,
      );
      tx.updateInput(
        1,
        { nonWitnessUtxo: funding.nonWitnessUtxo, finalScriptSig: fundingScript },
        true,
      );
      return tx.toPSBT();
    };
    expect(() =>
      finalizeMainnetHelper(
        intent,
        approval,
        walletChanged(109999n, source.getInput(1).finalScriptSig!),
      ),
    ).toThrow("Wallet changed unsigned transaction");
    expect(() =>
      finalizeMainnetHelper(
        intent,
        approval,
        walletChanged(110000n, hex.decode("0102")),
      ),
    ).toThrow("Wallet changed QSB authorization");
    expect(
      judgeInRepoRegression({
        backupReimported: true,
        oneTimeCommitmentRefused: true,
        walletChangeRefused: true,
        exactIntentDisplayed: true,
      }),
    ).toMatchObject({
      inRepoRegressionPassed: true,
      closesDeployedUiApiItem: false,
      observedDeployedUi: false,
      observedDeployedApi: false,
    });
  });
});
