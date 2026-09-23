import { z } from "zod";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { publicVaultSchema, type PublicVault } from "./model";
import { decryptRecovery } from "./backup";
import { validateRecovery, lockQsb } from "./qsb";
import { BITCOIN_NETWORK, NETWORK_ID } from "./network";
import type { Wallet } from "./wallet";

const bytes = z.string().regex(/^(?:[0-9a-f]{2})+$/);
// Never use passthrough schemas here: these fields become shareable data.
const scalar = z.number().positive().finite();
const publicStateSchema = z
  .object({
    config: z.literal("A"),
    hash_mode: z.literal("sha256"),
    n: z.literal(150),
    t1s: z.literal(8),
    t1b: z.literal(1),
    t2s: z.literal(7),
    t2b: z.literal(2),
    hors_commitments: z.array(z.array(bytes.length(40)).length(150)).length(2),
    dummy_sigs: z.array(z.array(bytes.max(146)).length(150)).length(2),
    pin_r: scalar,
    pin_s: scalar,
    pin_sig: bytes.max(146),
    round_sigs: z
      .array(z.object({ r: scalar, s: scalar, sig: bytes.max(146) }).strict())
      .length(2),
    full_script_hex: bytes.max(20000),
  })
  .strict();
export const offlineRequestSchema = z
  .object({
    format: z.literal("qsb-offline-fixture-request-v1"),
    fixtureChain: z.literal("regtest"),
    id: z.string().uuid(),
    wallet: z
      .object({
        address: z.string(),
        publicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/i),
        type: z.enum(["p2wpkh", "p2sh"]),
      })
      .strict(),
    vault: publicVaultSchema,
  })
  .strict();
export type OfflineRequest = z.infer<typeof offlineRequestSchema>;
export function validatedOfflineWallet(wallet: Wallet): Wallet {
  if (NETWORK_ID !== "mainnet")
    throw new Error(
      "Open this check in the original mainnet app. No mainnet coins will be used.",
    );
  const pub = hex.decode(wallet.publicKey);
  const native = btc.p2wpkh(pub, BITCOIN_NETWORK),
    nested = btc.p2sh(native, BITCOIN_NETWORK);
  const expected =
    wallet.address === native.address
      ? "p2wpkh"
      : wallet.address === nested.address
        ? "p2sh"
        : undefined;
  if (!expected || wallet.type.toLowerCase() !== expected)
    throw new Error(
      "The payment address must match its P2WPKH or nested SegWit public key.",
    );
  return {
    address: wallet.address,
    publicKey: wallet.publicKey,
    type: expected,
  };
}
export function createOfflineRequest(
  wallet: Wallet,
  vault: PublicVault,
): OfflineRequest {
  const request = offlineRequestSchema.parse({
    format: "qsb-offline-fixture-request-v1",
    fixtureChain: "regtest",
    id: vault.id,
    wallet: validatedOfflineWallet(wallet),
    vault,
  });
  const state = publicStateSchema.parse(JSON.parse(vault.publicStateJson));
  if (
    vault.funding ||
    vault.status !== "unfunded" ||
    vault.name !== "Offline signing test — never fund" ||
    vault.paymentAddress !== wallet.address ||
    state.full_script_hex !== vault.scriptHex ||
    hex.encode(sha256(hex.decode(vault.scriptHex))) !== vault.scriptHash
  )
    throw new Error("Offline fixture metadata or script commitment mismatch.");
  // Preserve the original JSON string: parsing/serializing its large public integers would lose precision.
  return request;
}
export async function verifyOfflineBackup(
  text: string,
  expectedEncrypted: string,
  password: string,
  request: OfflineRequest,
): Promise<void> {
  try {
    if (text !== expectedEncrypted)
      throw new Error("Select the exact private backup you just downloaded.");
    const recovery = await decryptRecovery(text, password);
    if (
      recovery.authorization ||
      JSON.stringify(recovery.vault) !== JSON.stringify(request.vault)
    )
      throw new Error("Backup belongs to a different fixture.");
    createOfflineRequest(request.wallet, recovery.vault);
    if (
      (await validateRecovery(recovery.stateJson)) !== request.vault.scriptHash
    )
      throw new Error("Recovery script commitment mismatch.");
  } finally {
    lockQsb();
  }
}
export function downloadOfflineFile(contents: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
