import type { PublicVault, Withdrawal } from "../src/lib/model";
import type { CoordinatorSolvedResult } from "../src/mainnet/coordinatorResult";

/** Public data only. The manager must verify recoverability against this exact descriptor. */
export type VaultDescriptor = Pick<PublicVault, "config" | "scriptHex" | "scriptHash" | "publicStateJson">;
export type WithdrawalSigningRequest = {
  format: "qsb-external-signing-request-v1";
  vault: PublicVault;
  solved: CoordinatorSolvedResult;
  /** Both input scripts and all witnesses are empty. */
  transaction: string;
  fundingPreviousTxHex: string;
  helperPreviousTxHex: string;
  helperAddress: string;
  helperPublicKey: string;
  /** Config A: 8 + 7; PQB: 8 + 9, in signing order. */
  selection: number[][];
};

/**
 * Implement outside qsb-app (preferably a separate process). No seed, key, passphrase or backup
 * may be returned. Independently derive and approve transaction amounts from the previous outputs.
 */
export interface ExternalCustody {
  /** Resolves only after durable recovery storage and a recoverability check for this descriptor. */
  confirmVault(vault: PublicVault): Promise<void>;
  /**
   * Independently verify the solution and exact spend, durably bind this vault to ONE intent and
   * assembly before revealing anything, then return the transaction with vault input 1 authorized.
   * Input 0 stays unsigned. Repeated identical requests must return the same bytes after a crash.
   */
  authorizeWithdrawal(request: WithdrawalSigningRequest): Promise<string>;
}

/**
 * Caller-owned, durable and shared by EVERY device using this vault. claim must atomically insert
 * if absent, succeed unchanged for an identical value, and reject a different value. Never expire,
 * overwrite or roll back claims. A resolved write must survive process/host failure.
 */
export interface AuthorizationStore {
  get(key: string): Promise<string | undefined>;
  claim(key: string, value: string): Promise<void>;
}

/** External credential lifecycle; credentials are used transiently in the authenticated header only. */
export interface Credentials {
  get(): Promise<string>;
}

export type CreateWithdrawal = {
  vaultId: string;
  helper?: { txid: string; vout: number };
  destination?: string;
  feeRate?: string;
  solverReleaseId?: string;
  costAccepted: true;
};
export type { PublicVault, Withdrawal };
