import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { vaultConfiguration } from "../src/lib/provenance";
import { outputScript } from "../src/lib/transactions";
import { prepareMainnetSearchRequest } from "../src/mainnet/submission";
import { RELEASE } from "../src/mainnet/solvedContract";
import { MAINNET_SEARCH_PROFILE } from "../src/mainnet/submission";
import type { PublicVault } from "../src/lib/model";

export const privateKey = new Uint8Array(32).fill(1);
const publicKeyBytes = secp256k1.getPublicKey(privateKey);
export const publicKey = hex.encode(publicKeyBytes);
export const address = btc.p2wpkh(publicKeyBytes, btc.NETWORK).address!;

export const simulatedFacts = {
  solverFacts: "simulated" as const,
  chainFacts: "simulated" as const,
  cpuVerification: "simulated" as const,
  binariesProduced: false as const,
  freshSearch: false as const,
  wholeRangeCovered: false as const,
};

export function simulatedMainnetRequest(idempotencyKey = crypto.randomUUID()) {
  const scriptHex = "51";
  const scriptHash = createHash("sha256")
    .update(Buffer.from(scriptHex, "hex"))
    .digest("hex");
  const commitment = "ab".repeat(20);
  const commitments = Array.from({ length: 150 }, () => commitment);
  const dummies = Array.from({ length: 150 }, () => "51");
  const id = crypto.randomUUID();
  const vault: PublicVault = {
    id,
    name: "Research",
    createdAt: "2026-09-23T00:00:00.000Z",
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash,
    paymentAddress: address,
    publicStateJson: JSON.stringify({
      config: "A",
      hash_mode: "sha256",
      n: 150,
      t1s: 8,
      t1b: 1,
      t2s: 7,
      t2b: 2,
      hors_commitments: [commitments, commitments],
      dummy_sigs: [dummies, dummies],
      pin_r: 1,
      pin_s: 1,
      pin_sig: "51",
      round_sigs: [
        { r: 1, s: 1, sig: "51" },
        { r: 1, s: 1, sig: "51" },
      ],
      full_script_hex: scriptHex,
    }),
    status: "confirmed",
    funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
  };
  vault.configuration = vaultConfiguration(vault);
  const manifest = {
    vaultId: id,
    funding: vault.funding!,
    helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
    destination: address,
    outputScript: hex.encode(outputScript(address)),
    outputValue: "90000",
    fee: "20000",
    idempotencyKey,
    costAccepted: true as const,
  };
  const prepared = prepareMainnetSearchRequest({
    owner: address,
    vault,
    manifest,
    wallet: { address, publicKey, type: "p2wpkh" },
    releaseId: MAINNET_SEARCH_PROFILE,
  });
  const bundle = {
    format: "qsb-mainnet-solved-state-v1" as const,
    network: "mainnet" as const,
    request: prepared.request,
    solution: {
      sequence: 2147483648,
      locktime: 500000000,
      round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      round2: [9, 10, 11, 12, 13, 14, 15, 16, 17],
    },
    release: RELEASE,
  };
  return { vault: prepared.request.vault, prepared, bundle };
}
