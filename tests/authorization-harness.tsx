// UI-only fixture: QSB assembly is stubbed by Playwright, never a consensus proof.
import { createRoot } from "react-dom/client";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import TransactionDialog from "../src/TransactionDialog";
import { encryptRecovery, bindRecoveryAssembly } from "../src/lib/backup";
import type { Recovery, Job, PublicVault, Withdrawal } from "../src/lib/model";
import { coordinatorPublicSolvedResult } from "../src/mainnet/coordinatorResult";
const password = "browser authorization passphrase";
export async function mount(changedSolution = false, localSolved = false) {
  const signingKey = new Uint8Array(32).fill(1);
  const publicKey = localSolved
    ? hex.encode(secp256k1.getPublicKey(signingKey))
    : "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const address = btc.p2wpkh(hex.decode(publicKey)).address!;
  const options = { allowUnknownInputs: true, allowUnknownOutputs: true };
  const previous = new btc.Transaction(options);
  previous.addInput({ txid: "55".repeat(32), index: 0 });
  previous.addOutputAddress(address, 20000n);
  previous.addOutput({ script: hex.decode("51".repeat(100)), amount: 100000n });
  const previousTxHex = hex.encode(previous.toBytes(true, true));
  const vault: PublicVault = {
    id: crypto.randomUUID(),
    name: "Authorization UI test",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex: "51".repeat(100),
    scriptHash: "aa".repeat(32),
    paymentAddress: address,
    publicStateJson: "{}",
    status: "confirmed",
    funding: { txid: previous.id, vout: 1, value: "100000" },
  };
  const manifest: Withdrawal = {
    vaultId: vault.id,
    funding: vault.funding!,
    helper: { txid: previous.id, vout: 0, value: "20000" },
    destination: address,
    outputScript: hex.encode(btc.p2wpkh(hex.decode(publicKey)).script),
    outputValue: "110000",
    fee: "10000",
    idempotencyKey: crypto.randomUUID(),
    costAccepted: true,
  };
  const solution = {
    sequence: 2147483648,
    locktime: 500000000,
    round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    round2: [10, 11, 12, 13, 14, 15, 16, 17, 18],
  };
  function assembly(hit: typeof solution) {
    const tx = new btc.Transaction({
      ...options,
      version: 1,
      lockTime: hit.locktime,
    });
    tx.addInput({ txid: previous.id, index: 0, sequence: 0xfffffffe });
    tx.addInput({ txid: previous.id, index: 1, sequence: hit.sequence });
    tx.addOutputAddress(address, 110000n);
    tx.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
    return hex.encode(tx.toBytes(true, true));
  }
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = hex.encode(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(manifestJson),
      ),
    ),
  );
  let recovery: Recovery = {
    format: "qsb-recovery-v1",
    vault,
    stateJson: '{"fixture":true}',
    authorization: { manifestJson, manifestHash },
  };
  if (changedSolution)
    recovery = await bindRecoveryAssembly(
      recovery,
      solution,
      assembly(solution),
    );
  const backup = await encryptRecovery(recovery, password);
  const job: Job = {
    id: manifest.idempotencyKey,
    owner: address,
    vaultId: vault.id,
    createdAt: vault.createdAt,
    updatedAt: vault.createdAt,
    status: "awaiting_authorization",
    stage: "verification",
    manifest,
    manifestHash,
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
    solution: changedSolution
      ? { ...solution, sequence: solution.sequence + 1 }
      : solution,
  };
  Object.assign(window, {
    authorizationFixture: { scriptHash: vault.scriptHash, assembly },
    walletCalls: 0,
    signSolvedPsbt: (psbt: string) => {
      const tx = btc.Transaction.fromPSBT(base64.decode(psbt), options);
      if (tx.getInput(0).sighashType !== 1)
        throw new Error("SIGHASH_ALL was not requested");
      if (!tx.signIdx(signingKey, 0)) throw new Error("local signature failed");
      return base64.encode(tx.toPSBT());
    },
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(
    <TransactionDialog
      vault={vault}
      wallet={{ address, publicKey, type: "p2wpkh" }}
      job={job}
      solvedResult={
        localSolved ? coordinatorPublicSolvedResult(job) : undefined
      }
      onClose={() => root.unmount()}
      onUpdated={() => {}}
    />,
  );
  return { backup, previousTxHex, password };
}
