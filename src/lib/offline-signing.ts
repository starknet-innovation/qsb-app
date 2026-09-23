import { z } from "zod";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { withdrawalSchema, type Recovery } from "./model";
import {
  offlineRequestSchema,
  createOfflineRequest,
  validatedOfflineWallet,
} from "./offline-fixture";
import {
  decryptRecovery,
  encryptRecovery,
  assertRecoveryAuthorization,
  bindRecoveryAssembly,
  assertRecoveryAssembly,
} from "./backup";
import { assembleQsb, validateRecovery, lockQsb } from "./qsb";
import {
  helperPsbt,
  outputScript,
  verifyWithdrawalCommitment,
} from "./transactions";
import type { Wallet } from "./wallet";
const indices = z
  .array(z.number().int().min(0).max(149))
  .length(9)
  .refine((v) => new Set(v).size === 9, "Duplicate HORS index");
const solutionSchema = z
  .object({
    sequence: z.number().int().min(0).max(0xffffffff),
    locktime: z.number().int().min(0).max(0xffffffff),
    round1: indices,
    round2: indices,
  })
  .strict();
export const offlineSigningBundleSchema = z
  .object({
    format: z.literal("qsb-offline-signing-bundle-v1"),
    request: offlineRequestSchema,
    fixture: z
      .object({
        network: z.literal("regtest"),
        fundingRawTx: z
          .string()
          .regex(/^(?:[0-9a-f]{2})+$/i)
          .max(2000000),
        manifest: withdrawalSchema,
      })
      .strict(),
    solution: solutionSchema,
  })
  .strict();
export type OfflineSigningBundle = z.infer<typeof offlineSigningBundleSchema>;
const digest = (text: string) =>
  hex.encode(sha256(new TextEncoder().encode(text)));
export function validateOfflineSigningBundle(
  value: unknown,
  wallet: Wallet,
): OfflineSigningBundle {
  const b = offlineSigningBundleSchema.parse(value),
    expectedWallet = validatedOfflineWallet(wallet);
  if (
    JSON.stringify(b.request.wallet) !== JSON.stringify(expectedWallet) ||
    b.request.id !== b.request.vault.id
  )
    throw Error("Offline signing request identity mismatch.");
  createOfflineRequest(b.request.wallet, b.request.vault);
  const m = b.fixture.manifest,
    tx = btc.Transaction.fromRaw(hex.decode(b.fixture.fundingRawTx), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  const ownerScript = hex.encode(outputScript(wallet.address));
  if (
    m.vaultId !== b.request.id ||
    m.destination !== wallet.address ||
    m.outputScript !== ownerScript ||
    m.outputValue !== "90000" ||
    m.fee !== "20000" ||
    m.funding.value !== "100000" ||
    m.helper.value !== "10000" ||
    m.funding.txid !== tx.id ||
    m.helper.txid !== tx.id ||
    m.funding.vout === m.helper.vout
  )
    throw Error("Offline fixture payout or outpoint mismatch.");
  for (const [point, script] of [
    [m.funding, b.request.vault.scriptHex],
    [m.helper, ownerScript],
  ] as const) {
    const output = tx.getOutput(point.vout);
    if (
      output.amount !== BigInt(point.value) ||
      !output.script ||
      hex.encode(output.script) !== script
    )
      throw Error("Offline fixture previous output mismatch.");
  }
  // The network label is an operator assertion. These checks do not prove chain inclusion.
  return b;
}
async function unlockBoundRecovery(
  backup: string,
  password: string,
  b: OfflineSigningBundle,
): Promise<Recovery> {
  const r = await decryptRecovery(backup, password);
  if (JSON.stringify(r.vault) !== JSON.stringify(b.request.vault))
    throw Error("Restore this fixture’s private backup.");
  if ((await validateRecovery(r.stateJson)) !== b.request.vault.scriptHash)
    throw Error("Private recovery does not match the fixture script.");
  const manifestJson = JSON.stringify(b.fixture.manifest),
    manifestHash = digest(manifestJson);
  await assertRecoveryAuthorization(r, manifestHash);
  return {
    ...r,
    authorization: { ...r.authorization, manifestJson, manifestHash },
  };
}
async function assembleBoundRecovery(r: Recovery, b: OfflineSigningBundle) {
  const raw = await assembleQsb(r.stateJson, b.fixture.manifest, b.solution);
  verifyWithdrawalCommitment(raw, b.fixture.manifest, b.solution);
  return { raw, bound: await bindRecoveryAssembly(r, b.solution, raw) };
}
/** No PSBT or authorization leaves this function. Save and reimport the returned private backup first. */
export async function prepareOfflineSigning(
  value: unknown,
  wallet: Wallet,
  privateBackup: string,
  password: string,
) {
  try {
    const bundle = validateOfflineSigningBundle(value, wallet);
    const recovery = await unlockBoundRecovery(privateBackup, password, bundle);
    const { bound } = await assembleBoundRecovery(recovery, bundle);
    return {
      id: bundle.request.id,
      manifestHash: bound.authorization!.manifestHash,
      rawTxHash: bound.authorization!.assembly!.rawTxHash,
      encryptedSigningBackup: await encryptRecovery(bound, password),
    };
  } finally {
    lockQsb();
  }
}
/** Call only after an explicit download + file selection in the UI. Never sends a signing request. */
export async function unlockVerifiedOfflineSigning(
  value: unknown,
  wallet: Wallet,
  reimportedSigningBackup: string,
  expectedSigningBackup: string,
  password: string,
) {
  try {
    if (reimportedSigningBackup !== expectedSigningBackup)
      throw Error("Reimport the exact signing backup you downloaded.");
    const bundle = validateOfflineSigningBundle(value, wallet);
    const original = await decryptRecovery(reimportedSigningBackup, password);
    if (!original.authorization?.assembly)
      throw Error("This backup has no sealed signing commitment.");
    const recovery = await unlockBoundRecovery(
      reimportedSigningBackup,
      password,
      bundle,
    );
    const { raw } = await assembleBoundRecovery(recovery, bundle);
    await assertRecoveryAssembly(original, bundle.solution, raw);
    const m = bundle.fixture.manifest;
    return {
      id: bundle.request.id,
      transaction: helperPsbt(
        raw,
        {
          ...m.helper,
          value: BigInt(m.helper.value),
          previousTxHex: bundle.fixture.fundingRawTx,
          publicKey: wallet.publicKey,
          address: wallet.address,
        },
        bundle.fixture.fundingRawTx,
      ),
      manifest: m,
      solution: bundle.solution,
    };
  } finally {
    lockQsb();
  }
}
