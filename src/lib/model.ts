import type { SolverPin } from "./provenance";
import { NETWORK_ID } from "./network";
import { z } from "zod";
export const hex = z.string().regex(/^(?:[a-f0-9]{2})+$/i);
export const txid = z.string().regex(/^[a-f0-9]{64}$/i);
export const sats = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (v) => BigInt(v) <= 2100000000000000n,
    "Amount exceeds Bitcoin supply",
  );
export const outpoint = z
  .object({ txid, vout: z.number().int().min(0).max(0xffffffff), value: sats })
  .strict();
export const publicVaultSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(60),
    createdAt: z.string().datetime(),
    network: z.literal(NETWORK_ID),
    config: z.literal("A"),
    scriptHex: hex.max(20000),
    scriptHash: txid,
    paymentAddress: z.string().min(14).max(100),
    publicStateJson: z.string().max(60000),
    configuration: z
      .object({
        protocol: z.literal("qsb-config-a-v1"),
        generatorCommit: z.literal("2c9172051d5c150ef0a994ca6b988a08a3ef9e85"),
        network: z.string(),
        config: z.literal("A"),
        scriptHash: txid,
        scriptBytesHash: txid,
        publicStateHash: txid,
      })
      .strict()
      .optional(),
    funding: outpoint.optional(),
    status: z.enum(["unfunded", "submitted", "confirmed", "spent"]),
  })
  .strict();
export type PublicVault = z.infer<typeof publicVaultSchema>;
export const recoverySchema = z
  .object({
    format: z.literal("qsb-recovery-v1"),
    vault: publicVaultSchema,
    stateJson: z.string().max(100000),
    authorization: z
      .object({
        manifestJson: z.string().max(5000),
        manifestHash: txid,
        assembly: z
          .object({
            solutionJson: z.string().max(2000),
            rawTxHash: txid,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Recovery = z.infer<typeof recoverySchema>;
export const withdrawalSchema = z
  .object({
    vaultId: z.string().uuid(),
    funding: outpoint,
    helper: outpoint,
    destination: z.string().min(14).max(100),
    outputScript: hex.max(200),
    outputValue: sats,
    fee: sats,
    idempotencyKey: z.string().uuid(),
    costAccepted: z.literal(true),
  })
  .strict();
export type Withdrawal = z.infer<typeof withdrawalSchema>;
export type Job = {
  id: string;
  owner: string;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "queued"
    | "searching"
    | "paused"
    | "failed"
    | "awaiting_authorization"
    | "submitted"
    | "confirmed";
  stage: "pinning" | "round1" | "round2" | "verification";
  manifest: Withdrawal;
  manifestHash: string;
  solver?: SolverPin;
  parameterHashes?: Record<string, string>;
  attempt: number;
  /** Historical paid submission count; not the time budget. */
  gpuSubmissions?: number;
  /** Durable worst-case GPU seconds reserved before paid POSTs; never refunded. */
  gpuBudgetReservedSeconds?: number;
  runpodId?: string;
  txid?: string;
  retryRequested?: boolean;
  error?: string;
  computeSeconds: number;
  solution?: {
    sequence: number;
    locktime: number;
    round1: number[];
    round2: number[];
  };
  revision: number;
};
export const release = {
  protocol: "qsb-config-a-v1",
  qsbCommit: "2c9172051d5c150ef0a994ca6b988a08a3ef9e85",
  kernelCommit: "2791ed0588f5014ccd688d48ba5502df2879f2f1",
  mainnetEnabled: false,
  checks: [
    { id: "structure", label: "Script size and opcode budget", passed: true },
    { id: "gpu", label: "Native GPU differential tests", passed: true },
    { id: "funding", label: "Bitcoin Core funding inclusion", passed: true },
    {
      id: "consensus",
      label: "Full withdrawal consensus validation (offline regtest)",
      passed: true,
    },
    { id: "wallet", label: "Xverse transaction compatibility", passed: false },
    { id: "miner", label: "Slipstream mainnet round trip", passed: false },
  ],
} as const;
export function parseBtc(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value))
    throw new Error("Enter BTC with up to 8 decimal places.");
  const [a, b = ""] = value.split(".");
  const n = BigInt(a) * 100000000n + BigInt(b.padEnd(8, "0"));
  sats.parse(n.toString());
  if (n === 0n) throw new Error("Amount must be greater than zero.");
  return n;
}
export function formatBtc(value: string | bigint): string {
  const n = BigInt(value);
  return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`;
}
export function validatePublicState(value: string): void {
  const s = JSON.parse(value) as Record<string, unknown>;
  const allowed = [
    "config",
    "hash_mode",
    "n",
    "t1s",
    "t1b",
    "t2s",
    "t2b",
    "hors_commitments",
    "dummy_sigs",
    "pin_r",
    "pin_s",
    "pin_sig",
    "round_sigs",
    "full_script_hex",
  ];
  if (Object.keys(s).some((k) => !allowed.includes(k)))
    throw new Error("Private or unknown state field rejected.");
  if (s.config !== "A" || s.hash_mode !== "sha256" || s.n !== 150)
    throw new Error("Unsupported QSB configuration.");
  for (const rs of s.round_sigs as Record<string, unknown>[])
    if (Object.keys(rs).some((k) => !["r", "s", "sig"].includes(k)))
      throw new Error("Private round state rejected.");
}
