import { randomUUID } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { ApiRequestError, createSessionClient } from "../src/lib/session";
import { NETWORK_ID } from "../src/lib/network";
import { operationsAllowed } from "../src/lib/readiness";
import { assertVaultConfiguration, vaultConfiguration } from "../src/lib/provenance";
import {
  canonicalManifest,
  outpoint,
  publicVaultSchema,
  sats,
  txid,
  validatePublicState,
  withdrawalSchema,
  type Job,
  type PublicVault,
  type Recovery,
  type Withdrawal,
} from "../src/lib/model";
import {
  assertRecoveryAssembly,
  assertRecoveryAuthorization,
  bindRecoveryAssembly,
  decryptRecovery,
  encryptRecovery,
} from "../src/lib/backup";
import {
  belowMinerFloor,
  fundingFeeForRate,
  fundingPsbt,
  minerMinimumRate,
  nestedPaymentAddress,
  outputScript,
  parseFeeRate,
  transactionVsize,
  verifySignedPsbt,
  verifyWithdrawalCommitment,
  withdrawalFeeForRate,
  withdrawalVsize,
  type FundingInput,
} from "../src/lib/transactions";
import {
  rebuildWithdrawalFromSolvedResult,
  signedCoordinatorResult,
} from "../src/mainnet/localSignature";
import {
  coordinatorSignedResultSchema,
  type CoordinatorSignedResult,
} from "../src/mainnet/coordinatorResult";
import { persistentGuard } from "../src/mainnet/guard";
// The request bodies the server's handlers parse, so a request can't drift from the API.
import { fundResubmitRequest, fundSubmitRequest, submitRequest } from "../server/api-schemas";
import type { Wallet } from "../src/lib/wallet";
import { nodeQsb, type LocalQsb } from "./runtime";
import { apiBase, isLoopback, signerWallet, type Signer } from "./signer";

export { ApiRequestError };
export type { CoordinatorSignedResult as SignedWithdrawal };

type Point = { txid: string; vout: number; value: string };
export type ApiConfig = {
  network?: string;
  operationsEnabled?: boolean;
  exactSubmitEnabled?: boolean;
  solverReleaseId?: string | null;
  /** The deployment's per-owner limits; `null` when they're misconfigured. `allowlisted` is the signed-in caller's. */
  ownerLimits?: {
    allowlist: boolean;
    allowlisted: boolean | null;
    maxActiveJobs: number | null;
    maxGpuSeconds: number | null;
  } | null;
  [field: string]: unknown;
};
export type Rates = { submit_fee_rate: number; market_rate?: number; effective_rate?: number };
/** Persists an encrypted recovery backup. It must resolve only once the text is safely stored. */
export type SaveBackup = (encryptedBackup: string) => Promise<void>;
/** A signed deposit kept before it's sent, so a retry can only resend these bytes. Public data. */
export type PendingDeposit = { txid: string; amount: string; rawTxHex: string };
export interface PendingDeposits {
  get(vaultId: string): Promise<PendingDeposit | undefined>;
  set(vaultId: string, deposit: PendingDeposit): Promise<void>;
  delete(vaultId: string): Promise<void>;
}
export type DepositSubmission = {
  vault: PublicVault;
  submission: "submitted" | "uncertain" | "rejected";
  reason?: string;
  txid: string;
};
/** What withdrawals.submit's approval callback sees. Every value is bound to `txid`. */
export type WithdrawalReview = Readonly<{
  network: string;
  jobId: string;
  vaultId: string;
  txid: string;
  destination: string;
  /** Sats paid to `destination`. */
  outputValue: string;
  /** Sats paid to the miner. */
  fee: string;
  vsize: number;
  /** sat/vB of the signed transaction. */
  feeRate: number;
  /** MARA's current minimum sat/vB. */
  minerMinimumFeeRate: number;
}>;
/** Return `review.txid` to approve that exact transaction; anything else refuses. */
export type ApproveWithdrawal = (
  review: WithdrawalReview,
) => string | false | undefined | Promise<string | false | undefined>;

export type QsbClientOptions = {
  /** The app origin, e.g. https://app.example or http://127.0.0.1:8787. */
  baseUrl: string;
  /**
   * The origin the server names in its sign-in challenge (its APP_ORIGIN); defaults to
   * `baseUrl`'s origin. A challenge naming any other origin is never signed, so an endpoint
   * can't relay another deployment's challenge to obtain a session there.
   */
  appOrigin?: string;
  signer: Signer;
  /** Transport; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Local QSB generator and assembler; defaults to Pyodide in this process. */
  qsb?: LocalQsb;
  /** Where signed deposits wait until the miner has them; defaults to memory. */
  pendingDeposits?: PendingDeposits;
  /**
   * This device's one-time authorizations, under the webapp's keys:
   * `qsb-intent:<scriptHash>` (the withdrawal intent) and `qsb-assembly:<scriptHash>`
   * (the assembled transaction). A different value for a vault is refused. Defaults to memory.
   */
  authorizations?: Pick<Storage, "getItem" | "setItem">;
  /** A session token from an earlier login by the same address. */
  token?: string;
  timeoutMs?: number;
};

const uuid = z.string().uuid();
function id(value: string, label: "vault" | "job"): string {
  if (!uuid.safeParse(value).success) throw new Error(`Invalid ${label} id.`);
  return value;
}
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const digest = (text: string) => hex.encode(sha256(new TextEncoder().encode(text)));
export const preparedDepositSchema = z
  .object({
    format: z.literal("qsb-sdk-prepared-deposit-v1"),
    network: z.string(),
    vaultId: z.string().uuid(),
    owner: z.string().min(14).max(100),
    scriptHash: txid,
    psbt: z.string().max(3000000),
    signInputs: z.array(z.number().int().min(0).max(7)).min(1).max(8),
    amount: sats,
    fee: sats,
    change: sats,
    vsize: z.number().int().positive(),
  })
  .strict();
const depositAnswerSchema = z.object({
  vault: publicVaultSchema,
  submission: z.enum(["submitted", "uncertain", "rejected"]),
  reason: z.string().optional(),
});
/** An unsigned deposit PSBT and its quote. Public data: nothing in it is secret. */
export type PreparedDeposit = z.infer<typeof preparedDepositSchema>;

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const rows = new Map<string, string>();
  return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => void rows.set(key, value) };
}
/**
 * The server's own refusal of a disabled submission: a 503 with code `submit_disabled`. Any
 * other failure, including an uncoded 503 from a gateway or an older server, is uncertain.
 */
function submitDisabled(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 503 && error.code === "submit_disabled";
}
/** Per-owner limit refusals, each with its status. The server returns them before writing or sending anything. */
const ownerRefusals: Record<string, number> = {
  owner_not_allowlisted: 403,
  owner_active_withdrawal_limit: 429,
  owner_gpu_budget_reached: 429,
  owner_limits_invalid: 503,
};
function ownerRefusal(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code !== undefined && ownerRefusals[error.code] === error.status;
}
/** A final refusal of this request: nothing was written, reserved or sent by it. */
function refused(error: ApiRequestError, what: string, next = ""): Error {
  const reason =
    error.code === "owner_limits_invalid"
      ? "the deployment's per-owner limits are misconfigured; contact the operator"
      : error.message.replace(/\.$/, "");
  return new Error(`The deployment refused ${what} (${error.code}): ${reason}. Nothing was written or sent by this request.${next}`, {
    cause: error,
  });
}
/** Refuse early when the deployment says this owner can't act, or its limits are misconfigured. */
function assertOwnerAllowed(config: ApiConfig) {
  if (config.ownerLimits === null)
    throw new Error("The deployment's per-owner limits are misconfigured (owner_limits_invalid). Nothing was changed; contact the operator.");
  if (config.ownerLimits?.allowlisted === false)
    throw new Error("This wallet isn't on this deployment's allowlist (owner_not_allowlisted). Nothing was changed.");
}
const mainnetOnly = () => {
  if (NETWORK_ID !== "mainnet")
    throw new Error("Withdrawals are assembled from the coordinator's solved result, which is delivered on Bitcoin mainnet only.");
};
function memoryPending(): PendingDeposits {
  const rows = new Map<string, PendingDeposit>();
  return {
    get: async (id) => rows.get(id),
    set: async (id, deposit) => void rows.set(id, deposit),
    delete: async (id) => void rows.delete(id),
  };
}
function decodePsbt(psbt: string | Uint8Array): Uint8Array {
  return typeof psbt === "string" ? base64.decode(psbt.trim()) : psbt;
}
function signInMessage(address: string, origin: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^QSB Vault sign-in\\nOrigin: ${escape(origin)}\\nAddress: ${escape(address)}\\nNetwork: bitcoin-${NETWORK_ID}\\nNonce: [0-9a-f-]{36}\\nExpires: [^\\n]{1,40}\\nThis signature authorizes this session only\\. It does not authorize a Bitcoin transaction\\.$`,
  );
}

/** The HTTP transport: one origin, no redirects, a timeout, and the webapp's session client. */
function transport(options: Pick<QsbClientOptions, "baseUrl" | "fetch" | "timeoutMs">) {
  const origin = apiBase(options.baseUrl).href.replace(/\/$/, "");
  const send = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 60000;
  return createSessionClient(((path: string, init?: RequestInit) =>
    send(`${origin}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    })) as typeof fetch);
}
/** The unauthenticated routes, for looking at a deployment before any wallet is set up. */
export function publicApi(options: Pick<QsbClientOptions, "baseUrl" | "fetch" | "timeoutMs">) {
  const session = transport(options);
  return {
    config: () => session.api<ApiConfig>("/config"),
    rates: () => session.api<Rates>("/rates"),
  };
}

/**
 * A non-custodial client for the QSB API. Recovery state, passphrases and
 * keys stay on this machine: state is generated, encrypted, validated and
 * assembled locally, and only public vault data, unsigned requests and signed
 * transactions are sent.
 */
export class QsbClient {
  private readonly session: ReturnType<typeof createSessionClient>;
  private readonly signer: Signer;
  private readonly wallet: Wallet;
  private readonly qsb: LocalQsb;
  private readonly pending: PendingDeposits;
  private readonly authorizations: Pick<Storage, "getItem" | "setItem">;
  private readonly guard: ReturnType<typeof persistentGuard>;
  private readonly appOrigin: string;

  constructor(options: QsbClientOptions) {
    const base = apiBase(options.baseUrl);
    if (options.signer.loopbackOnly && !isLoopback(base))
      throw new Error("This signer holds a raw key and only works with a loopback API URL.");
    this.signer = options.signer;
    this.wallet = signerWallet(options.signer);
    this.qsb = options.qsb ?? nodeQsb();
    this.pending = options.pendingDeposits ?? memoryPending();
    this.authorizations = options.authorizations ?? memoryStorage();
    this.guard = persistentGuard(this.authorizations);
    this.session = transport(options);
    this.appOrigin = new URL(options.appOrigin ?? base.origin).origin;
    // A raw-key signer must not sign another deployment's challenge relayed through a local proxy.
    if (options.signer.loopbackOnly && !isLoopback(new URL(this.appOrigin)))
      throw new Error("This signer holds a raw key and only signs in to a loopback app origin.");
    if (options.token) this.session.restoreSession(options.token);
  }

  /** The current bearer token, for a caller that caches it (owner-only file permissions). */
  get token(): string | undefined {
    return this.session.currentToken();
  }

  /** BIP-322 sign-in. The challenge must be the app's session-only message for this address. */
  async login(): Promise<void> {
    const expected = signInMessage(this.wallet.address, this.appOrigin);
    await this.session.authenticate(this.wallet.address, (message) => {
      if (!expected.test(message))
        throw new Error(
          `The sign-in challenge is not the session-only message of ${this.appOrigin} for this address. Nothing was signed.`,
        );
      return this.signer.signMessage(this.wallet.address, message);
    });
  }
  config(): Promise<ApiConfig> {
    return this.session.api<ApiConfig>("/config");
  }
  rates(): Promise<Rates> {
    return this.session.api<Rates>("/rates");
  }
  /** Confirmed payment outputs of the signed-in address. */
  async utxos(): Promise<Point[]> {
    return (await this.session.api<{ utxos: Point[] }>("/payment-utxos")).utxos;
  }

  readonly vaults = {
    /**
     * Generate QSB state locally, encrypt the recovery backup locally, hand it
     * to `saveBackup`, check it unlocks, then register only the public vault.
     */
    create: (input: { name: string; passphrase: string; saveBackup: SaveBackup }) =>
      this.createVault(input),
    list: () => this.session.api<{ vaults: PublicVault[]; resendable?: string[] }>("/vaults"),
  };
  readonly deposits = {
    /** An unsigned deposit PSBT paying the vault, after checking the backup matches its script. */
    prepare: (
      vaultId: string,
      input: {
        backup: string;
        passphrase: string;
        amount: bigint | string;
        feeRate: string;
        utxos: { txid: string; vout: number }[];
      },
    ) => this.prepareDeposit(vaultId, input),
    /** Check the signed PSBT against the prepared one, keep it as pending, then have the server relay it. */
    submit: (
      prepared: PreparedDeposit,
      signedPsbt: string | Uint8Array,
      input: { costAccepted: true },
    ) => this.submitDeposit(prepared, signedPsbt, input),
    status: (vaultId: string) => this.depositStatus(vaultId),
    /** Resend the same signed deposit: the locally pending bytes, else the server's stored bytes. */
    resubmit: (vaultId: string) => this.resubmitDeposit(vaultId),
  };
  readonly withdrawals = {
    /**
     * Fix the payout and fee, bind them into a new encrypted backup
     * (`saveBackup` runs before any billable work), then create the search.
     * A backup that already holds an intent resumes that intent unchanged.
     */
    create: (input: {
      vaultId: string;
      backup: string;
      passphrase: string;
      helper?: { txid: string; vout: number };
      destination?: string;
      feeRate?: string;
      solverReleaseId?: string;
      costAccepted: true;
      saveBackup: SaveBackup;
    }) => this.createWithdrawal(input),
    list: async () => (await this.session.api<{ jobs: Job[] }>("/jobs")).jobs,
    status: (jobId: string) =>
      this.session.api<{ job: Job; [field: string]: unknown }>(`/jobs/${id(jobId, "job")}/status`),
    pause: (jobId: string) =>
      this.session.api<{ job: Job }>(`/jobs/${id(jobId, "job")}/pause`, {}),
    resume: async (jobId: string) => {
      assertOwnerAllowed(await this.config());
      try {
        return await this.session.api<{ job: Job }>(`/jobs/${id(jobId, "job")}/resume`, {});
      } catch (error) {
        throw ownerRefusal(error) ? refused(error, "to resume the search") : error;
      }
    },
    /**
     * Rebuild the withdrawal locally from the backup and the coordinator's
     * public solved result, seal the signing backup (`saveBackup`) if the
     * backup doesn't bind this assembly yet, then have the signer sign the
     * helper input. Works hours later, in a new process, from the job id.
     */
    assemble: (jobId: string, input: { backup: string; passphrase: string; saveBackup?: SaveBackup }) =>
      this.assembleWithdrawal(jobId, input),
    /** Submit only after `approve` returns this exact transaction's txid. */
    submit: (signed: CoordinatorSignedResult, input: { approve: ApproveWithdrawal }) =>
      this.submitWithdrawal(signed, input),
  };

  private async vault(vaultId: string): Promise<PublicVault> {
    id(vaultId, "vault");
    const vault = (await this.vaults.list()).vaults.find((v) => v.id === vaultId);
    if (!vault) throw new Error("Vault not found for this address.");
    return vault;
  }
  private async assertServerNetwork(): Promise<ApiConfig> {
    const config = await this.config();
    if (config.network !== NETWORK_ID)
      throw new Error(`The API serves ${String(config.network)}, not ${NETWORK_ID}. Nothing was changed.`);
    return config;
  }
  private async assertOperations(): Promise<ApiConfig> {
    const config = await this.config();
    if (!operationsAllowed(config))
      throw new Error("Transactions are disabled or the server network differs. Nothing was changed.");
    return config;
  }
  private async minerFloor(): Promise<number> {
    try {
      return minerMinimumRate(await this.rates());
    } catch {
      throw new Error(
        "MARA's fee quote is unavailable, so the rate can't be checked against its minimum. Nothing was submitted; try again shortly.",
      );
    }
  }
  private async assertMinerFloor(milliSatPerVb: bigint) {
    const floor = await this.minerFloor();
    if (belowMinerFloor(milliSatPerVb, floor))
      throw new Error(`The fee rate is below MARA's current minimum of ${floor} sat/vB. Nothing was submitted.`);
  }
  /** Decrypt locally and check the state against the vault's script, as the webapp does. */
  private async unlock(backup: string, passphrase: string, vault: PublicVault): Promise<Recovery> {
    const recovery = await decryptRecovery(backup, passphrase);
    assertVaultConfiguration(vault);
    if (
      recovery.vault.id !== vault.id ||
      recovery.vault.scriptHash !== vault.scriptHash ||
      recovery.vault.scriptHex !== vault.scriptHex ||
      (await this.qsb.validateRecovery(recovery.stateJson)) !== vault.scriptHash
    )
      throw new Error("This backup belongs to a different vault.");
    return recovery;
  }
  private async fundingInput(point: Point): Promise<FundingInput> {
    const { previousTxHex } = await this.session.api<{ previousTxHex: string }>(
      "/payment-input",
      outpoint.parse({ txid: point.txid, vout: point.vout, value: point.value }),
    );
    return {
      txid: point.txid,
      vout: point.vout,
      value: BigInt(point.value),
      previousTxHex,
      publicKey: this.wallet.publicKey,
      address: this.wallet.address,
    };
  }
  private async selectUtxos(selection: { txid: string; vout: number }[]): Promise<Point[]> {
    const available = await this.utxos();
    return selection.map((wanted) => {
      const found = available.find(
        (p) => p.txid === wanted.txid.toLowerCase() && p.vout === wanted.vout,
      );
      if (!found) throw new Error(`${wanted.txid}:${wanted.vout} is not a confirmed payment output of this address.`);
      return found;
    });
  }

  private async createVault(input: { name: string; passphrase: string; saveBackup: SaveBackup }) {
    const name = input.name.trim();
    if (!name || name.length > 60) throw new Error("Give the vault a name of 1 to 60 characters.");
    if (input.passphrase.length < 14)
      throw new Error("Use a recovery passphrase of at least 14 characters.");
    assertOwnerAllowed(await this.assertServerNetwork());
    try {
      const data = await this.qsb.generateQsb();
      validatePublicState(data.publicStateJson);
      const vault: PublicVault = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        network: NETWORK_ID,
        config: "A",
        scriptHex: data.scriptHex,
        scriptHash: data.scriptHash,
        publicStateJson: data.publicStateJson,
        paymentAddress: this.wallet.address,
        status: "unfunded",
      };
      vault.configuration = vaultConfiguration(vault);
      const backup = await encryptRecovery(
        { format: "qsb-recovery-v1", vault, stateJson: data.stateJson },
        input.passphrase,
      );
      await input.saveBackup(backup);
      await this.unlock(backup, input.passphrase, vault);
      const registered = await this.session
        .api<{ vault: PublicVault }>("/vaults", publicVaultSchema.parse(vault))
        .catch((error) => {
          throw ownerRefusal(error)
            ? refused(error, "to register the vault", " The saved backup is for an unregistered vault: never pay into its script.")
            : error;
        });
      return { vault: registered.vault, backup };
    } finally {
      this.qsb.lockQsb();
    }
  }

  private async prepareDeposit(
    vaultId: string,
    input: {
      backup: string;
      passphrase: string;
      amount: bigint | string;
      feeRate: string;
      utxos: { txid: string; vout: number }[];
    },
  ): Promise<PreparedDeposit> {
    const config = await this.assertOperations();
    assertOwnerAllowed(config);
    if (config.exactSubmitEnabled !== true)
      throw new Error("Deposits are submitted to MARA Slipstream, which is switched off right now. Nothing was prepared.");
    if (await this.pending.get(vaultId))
      throw new Error("A signed deposit for this vault is waiting for MARA. Resubmit it; do not deposit again.");
    const vault = await this.vault(vaultId);
    if (vault.status !== "unfunded" || vault.funding)
      throw new Error("This vault already has a deposit. A vault takes one deposit; do not deposit again.");
    try {
      await this.unlock(input.backup, input.passphrase, vault);
    } finally {
      this.qsb.lockQsb();
    }
    const amount = BigInt(sats.parse(String(input.amount)));
    if (amount === 0n) throw new Error("Amount must be greater than zero.");
    const rate = parseFeeRate(input.feeRate);
    if (!input.utxos.length || input.utxos.length > 8)
      throw new Error("Select between one and eight payment outputs.");
    const inputs = await Promise.all((await this.selectUtxos(input.utxos)).map((p) => this.fundingInput(p)));
    await this.assertMinerFloor(rate);
    const quote = fundingFeeForRate(
      inputs.map((i) => i.value),
      nestedPaymentAddress(this.wallet.address),
      vault.scriptHex.length / 2,
      amount,
      rate,
    );
    const tx = fundingPsbt(inputs, vault.scriptHex, amount, quote.fee, this.wallet.address);
    if (tx.outputsLength !== (quote.change ? 2 : 1))
      throw new Error("The deposit fee estimate doesn't match the transaction. Nothing was prepared.");
    const total = inputs.reduce((sum, i) => sum + i.value, 0n);
    return preparedDepositSchema.parse({
      format: "qsb-sdk-prepared-deposit-v1",
      network: NETWORK_ID,
      vaultId,
      owner: this.wallet.address,
      scriptHash: vault.scriptHash,
      psbt: base64.encode(tx.toPSBT()),
      signInputs: inputs.map((_, index) => index),
      amount: amount.toString(),
      fee: quote.fee.toString(),
      change: (total - amount - quote.fee).toString(),
      vsize: quote.vsize,
    });
  }
  /** Rebuild the prepared PSBT from its own inputs and the vault, so an edited file can't pass. */
  private expectedDeposit(prepared: PreparedDeposit, vault: PublicVault): btc.Transaction {
    const unsigned = btc.Transaction.fromPSBT(base64.decode(prepared.psbt), opts);
    const inputs: FundingInput[] = [];
    for (let i = 0; i < unsigned.inputsLength; i++) {
      const input = unsigned.getInput(i);
      if (!input.txid || input.index === undefined || !input.nonWitnessUtxo)
        throw new Error("The prepared deposit is incomplete.");
      const previousTxHex = hex.encode(btc.RawTx.encode(input.nonWitnessUtxo));
      const previous = btc.Transaction.fromRaw(hex.decode(previousTxHex), opts);
      inputs.push({
        txid: hex.encode(input.txid),
        vout: input.index,
        value: previous.getOutput(input.index).amount ?? 0n,
        previousTxHex,
        publicKey: this.wallet.publicKey,
        address: this.wallet.address,
      });
    }
    const expected = fundingPsbt(
      inputs,
      vault.scriptHex,
      BigInt(prepared.amount),
      BigInt(prepared.fee),
      this.wallet.address,
    );
    if (
      hex.encode(expected.unsignedTx) !== hex.encode(unsigned.unsignedTx) ||
      prepared.signInputs.join(",") !== inputs.map((_, i) => i).join(",")
    )
      throw new Error("The prepared deposit does not match this vault and address.");
    return expected;
  }
  private async submitDeposit(
    input: PreparedDeposit,
    signedPsbt: string | Uint8Array,
    options: { costAccepted: true },
  ): Promise<DepositSubmission> {
    if (options?.costAccepted !== true)
      throw new Error("Accept the costs first: deposits.submit needs { costAccepted: true }.");
    const prepared = preparedDepositSchema.parse(input);
    if (prepared.network !== NETWORK_ID || prepared.owner !== this.wallet.address)
      throw new Error("This deposit was prepared for another network or address.");
    const config = await this.assertOperations();
    assertOwnerAllowed(config);
    if (config.exactSubmitEnabled !== true)
      throw new Error("Deposits are submitted to MARA Slipstream, which is switched off right now. Nothing was sent.");
    const vault = await this.vault(prepared.vaultId);
    assertVaultConfiguration(vault);
    if (vault.scriptHash !== prepared.scriptHash)
      throw new Error("The prepared deposit belongs to a different vault script.");
    const signed = verifySignedPsbt(this.expectedDeposit(prepared, vault), decodePsbt(signedPsbt));
    for (let i = 0; i < signed.inputsLength; i++) {
      const signedInput = signed.getInput(i);
      if (!signedInput.finalScriptWitness?.length && !signedInput.finalScriptSig?.length) signed.finalizeIdx(i);
    }
    const deposit = { txid: signed.id, amount: prepared.amount, rawTxHex: signed.hex };
    const waiting = await this.pending.get(prepared.vaultId);
    // Only these exact bytes may be sent again. A re-signed copy has the same txid but other
    // witness bytes, which the server refuses once it holds the first.
    if (waiting && waiting.rawTxHex !== deposit.rawTxHex)
      throw new Error("A signed deposit for this vault is already waiting for MARA. Use deposits.resubmit; do not sign or deposit again.");
    if (!waiting && (vault.funding || vault.status !== "unfunded"))
      throw new Error("This vault already has a deposit. A vault takes one deposit; use deposits.resubmit to resend it.");
    if (vault.funding && vault.funding.txid !== deposit.txid)
      throw new Error("This vault already has a different deposit. A vault takes one deposit; do not deposit again.");
    if (!waiting) {
      // MARA's floor may have risen since prepare; a refused deposit would have to be redone.
      await this.assertMinerFloor((BigInt(prepared.fee) * 1000n) / BigInt(transactionVsize(deposit.rawTxHex)));
      // Keep the signed bytes before they leave, so an unknown outcome can only resend this deposit.
      await this.pending.set(prepared.vaultId, deposit);
    }
    return this.sendDeposit(prepared.vaultId, deposit);
  }
  private async sendDeposit(vaultId: string, deposit: PendingDeposit): Promise<DepositSubmission> {
    const unconfirmed = (detail: string) =>
      new Error(
        `The deposit ${deposit.txid} is signed, but its submission to MARA isn't confirmed. Don't deposit again; use deposits.resubmit.${detail}`,
      );
    let answer: unknown;
    try {
      answer = await this.session.api<unknown>(
        `/vaults/${vaultId}/fund/submit`,
        fundSubmitRequest.parse({ rawTxHex: deposit.rawTxHex, amount: deposit.amount, costAccepted: true }),
      );
    } catch (error) {
      // A per-owner refusal comes before any write or miner call: final for this request. Earlier
      // attempts may still have been sent, so the signed bytes stay pending either way.
      if (ownerRefusal(error))
        throw refused(error, "the deposit", " The signed deposit stays pending: resend it with deposits.resubmit once allowed; don't sign another.");
      throw unconfirmed(error instanceof Error ? ` ${error.message}` : "");
    }
    // Only an answer about this vault and these bytes ends the pending deposit.
    const parsed = depositAnswerSchema.safeParse(answer);
    if (!parsed.success || parsed.data.vault.id !== vaultId) throw unconfirmed(" The server's answer was not recognized.");
    const result = parsed.data;
    const recorded = result.vault.funding?.txid === deposit.txid;
    if ((result.submission === "submitted" && !recorded) || (result.submission === "rejected" && result.vault.funding))
      throw unconfirmed(" The server's answer doesn't match this deposit.");
    if (result.submission !== "uncertain") await this.pending.delete(vaultId);
    return { ...result, txid: deposit.txid };
  }
  private async resubmitDeposit(vaultId: string) {
    id(vaultId, "vault");
    const waiting = await this.pending.get(vaultId);
    if (waiting) return this.sendDeposit(vaultId, waiting);
    try {
      return await this.session.api<Omit<DepositSubmission, "txid">>(`/vaults/${vaultId}/fund/resubmit`, fundResubmitRequest.parse({}));
    } catch (error) {
      throw ownerRefusal(error) ? refused(error, "to resend the deposit", " Resend it once allowed; don't sign another.") : error;
    }
  }
  private async depositStatus(vaultId: string) {
    const status = await this.session.api<{
      vault: PublicVault;
      status: { confirmed: boolean; confirmations?: number };
      submission?: string;
      previousTxHex: string;
    }>(`/vaults/${id(vaultId, "vault")}/funding`);
    const waiting = await this.pending.get(vaultId);
    if (waiting && status.vault.funding?.txid === waiting.txid && status.status.confirmed)
      await this.pending.delete(vaultId);
    return status;
  }

  private async createWithdrawal(input: {
    vaultId: string;
    backup: string;
    passphrase: string;
    helper?: { txid: string; vout: number };
    destination?: string;
    feeRate?: string;
    solverReleaseId?: string;
    costAccepted: true;
    saveBackup: SaveBackup;
  }): Promise<{ job: Job; backup?: string }> {
    if (input.costAccepted !== true)
      throw new Error("Accept the costs first: withdrawals.create needs { costAccepted: true }.");
    const config = await this.assertOperations();
    assertOwnerAllowed(config);
    const vault = await this.vault(input.vaultId);
    let recovery: Recovery;
    try {
      recovery = await this.unlock(input.backup, input.passphrase, vault);
    } finally {
      this.qsb.lockQsb();
    }
    const saved = recovery.authorization
      ? withdrawalSchema.parse(JSON.parse(recovery.authorization.manifestJson))
      : undefined;
    const other = (await this.withdrawals.list()).find(
      (job) => job.vaultId === vault.id && job.id !== saved?.idempotencyKey,
    );
    if (other) throw new Error(`This vault already has a withdrawal request (${other.id}). Resume that one.`);
    const funded = await this.depositStatus(vault.id);
    if (!funded.status.confirmed || !funded.vault.funding) throw new Error("Wait for the deposit to confirm.");
    const funding = funded.vault.funding;
    if (!config.solverReleaseId)
      throw new Error("The deployment serves no solver right now. Nothing was created.");
    if (input.solverReleaseId !== undefined && input.solverReleaseId !== config.solverReleaseId)
      throw new Error("The deployment solver differs from the requested one. Nothing was created.");
    const nested = nestedPaymentAddress(this.wallet.address);
    let manifest: Withdrawal;
    let backup: string | undefined;
    if (saved) {
      // Resume the saved intent exactly: its payout and one-time keys are already bound.
      if (
        (input.destination !== undefined && input.destination !== saved.destination) ||
        (input.helper !== undefined &&
          (input.helper.txid.toLowerCase() !== saved.helper.txid || input.helper.vout !== saved.helper.vout)) ||
        input.feeRate !== undefined
      )
        throw new Error("This backup already authorizes a withdrawal. Resume it unchanged; do not reuse its one-time keys.");
      if (saved.solverReleaseId !== config.solverReleaseId)
        throw new Error("The saved intent uses a different solver. Keep its backup and contact the operator; do not create a new intent.");
      if ((["txid", "vout", "value"] as const).some((field) => saved.funding[field] !== funding[field]))
        throw new Error("The saved intent spends a different deposit.");
      const vsize = withdrawalVsize(nested, saved.outputScript.length / 2);
      await this.assertMinerFloor((BigInt(saved.fee) * 1000n) / BigInt(vsize));
      manifest = saved;
      this.guard.claim(`qsb-intent:${vault.scriptHash}`, digest(JSON.stringify(saved)));
    } else {
      if (!input.helper || !input.destination || !input.feeRate)
        throw new Error("Choose a helper output, a destination and a fee rate.");
      const [helper] = await this.selectUtxos([input.helper]);
      const script = outputScript(input.destination);
      const rate = parseFeeRate(input.feeRate);
      await this.assertMinerFloor(rate);
      const fee = withdrawalFeeForRate(nested, script.length, rate).fee;
      const outputValue = BigInt(funding.value) + BigInt(helper.value) - fee;
      if (outputValue <= 0n) throw new Error("The miner fee exceeds the available amount.");
      manifest = withdrawalSchema.parse({
        vaultId: vault.id,
        funding,
        helper,
        destination: input.destination,
        outputScript: hex.encode(script),
        outputValue: outputValue.toString(),
        fee: fee.toString(),
        idempotencyKey: randomUUID(),
        costAccepted: true,
        solverReleaseId: config.solverReleaseId,
      });
      const manifestJson = JSON.stringify(manifest);
      const manifestHash = digest(manifestJson);
      await assertRecoveryAuthorization(recovery, manifestHash);
      // This device keeps one intent per vault, as the webapp does. A fresh intent can't match
      // a remembered one, so refuse before saving anything.
      const intentKey = `qsb-intent:${vault.scriptHash}`;
      if (this.authorizations.getItem(intentKey) !== null)
        throw new Error("This vault already authorizes a different withdrawal or assembly. Resume its original backup.");
      backup = await encryptRecovery(
        { ...recovery, authorization: { manifestJson, manifestHash } },
        input.passphrase,
      );
      // Keep the recovery before starting billable work: it binds the payout to the one-time keys.
      // Remember the intent only once a backup holds it, so a failed save strands nothing.
      await input.saveBackup(backup);
      this.guard.claim(intentKey, manifestHash);
    }
    const manifestHash = digest(JSON.stringify(manifest));
    let job: Job;
    try {
      ({ job } = await this.session.api<{ job: Job }>("/jobs", manifest));
    } catch (error) {
      const retry = backup ? " The new backup holds this intent; create the withdrawal again from it once allowed." : "";
      if (ownerRefusal(error)) throw refused(error, "to create the search", ` Nothing was reserved.${retry}`);
      // Refused (an input_* code, say) or unanswered: either way the intent is only in the backup.
      // Creating it again from that backup is idempotent, so a retry can never make a second search.
      if (!backup) throw error;
      throw new Error(
        `The withdrawal search isn't confirmed: ${error instanceof Error ? error.message : String(error)} The new backup holds this intent; retry withdrawals.create with it, not with the original backup.`,
        { cause: error },
      );
    }
    if (job.id !== manifest.idempotencyKey || job.manifestHash !== manifestHash)
      throw new Error("The server returned a different withdrawal. Keep the backup and check withdrawals.list.");
    return { job, ...(backup ? { backup } : {}) };
  }

  private async assembleWithdrawal(
    jobId: string,
    input: { backup: string; passphrase: string; saveBackup?: SaveBackup },
  ): Promise<CoordinatorSignedResult> {
    mainnetOnly();
    const { job } = await this.withdrawals.status(jobId);
    if (job.status !== "awaiting_authorization" || !job.solution)
      throw new Error(`The search has no solved result to authorize (status ${job.status}).`);
    const funding = await this.depositStatus(job.vaultId);
    let local: Awaited<ReturnType<typeof rebuildWithdrawalFromSolvedResult>>;
    try {
      const recovery = await this.unlock(input.backup, input.passphrase, funding.vault);
      const intent = recovery.authorization;
      if (!intent) throw new Error("Use the withdrawal backup saved when this withdrawal was created.");
      if (
        digest(intent.manifestJson) !== intent.manifestHash ||
        digest(JSON.stringify(canonicalManifest(job.manifest))) !== intent.manifestHash ||
        job.manifestHash !== intent.manifestHash
      )
        throw new Error("The job differs from the withdrawal intent in your backup.");
      this.guard.claim(`qsb-intent:${funding.vault.scriptHash}`, intent.manifestHash);
      const solved = await this.session.api<unknown>(`/jobs/${job.id}/solved-result`);
      local = await rebuildWithdrawalFromSolvedResult({
        solved,
        job,
        stateJson: recovery.stateJson,
        helper: await this.fundingInput(job.manifest.helper),
        fundingPreviousTxHex: funding.previousTxHex,
        assemble: this.qsb.assembleQsb,
      });
      const bound = await bindRecoveryAssembly(recovery, local.solved.solution, local.raw);
      // One assembly per vault on this device, even from an older backup that doesn't bind one yet.
      this.guard.claim(`qsb-assembly:${funding.vault.scriptHash}`, bound.authorization!.assembly!.rawTxHash);
      if (!intent.assembly) {
        // Seal the exact solution and transaction into the backup before the helper is signed.
        if (!input.saveBackup)
          throw new Error("This backup doesn't bind the assembled transaction yet. Pass saveBackup to keep the signing backup first.");
        await input.saveBackup(await encryptRecovery(bound, input.passphrase));
      }
      await assertRecoveryAssembly(bound, local.solved.solution, local.raw);
    } finally {
      this.qsb.lockQsb();
    }
    const returned = await this.signer.signPsbt(
      this.wallet.address,
      base64.encode(local.transaction.toPSBT()),
      [0],
    );
    return signedCoordinatorResult(local.solved, local.transaction, decodePsbt(returned), this.wallet);
  }

  private async submitWithdrawal(
    input: CoordinatorSignedResult,
    options: { approve: ApproveWithdrawal },
  ): Promise<{ txid: string; status: string }> {
    if (typeof options?.approve !== "function")
      throw new Error("withdrawals.submit needs an approve callback. Nothing was submitted.");
    mainnetOnly();
    const signed = coordinatorSignedResultSchema.parse(input);
    const config = await this.assertOperations();
    if (config.exactSubmitEnabled !== true)
      throw new Error("Submission is disabled. Keep the signed result; nothing was broadcast.");
    const { job } = await this.withdrawals.status(signed.jobId);
    if (job.txid) throw new Error(`This withdrawal was already submitted as ${job.txid}. Check its status; do not submit again.`);
    if (
      job.status !== "awaiting_authorization" ||
      !job.solution ||
      job.vaultId !== signed.vaultId ||
      job.manifestHash !== signed.manifestHash
    )
      throw new Error("The signed result doesn't match this withdrawal's solved state. Nothing was submitted.");
    // The fee and the input values aren't in the QSB input's commitment, so the stored intent must
    // be the one the backup bound at assembly before any value is shown.
    const manifest = canonicalManifest(job.manifest);
    const manifestHash = digest(JSON.stringify(manifest));
    if (
      manifestHash !== signed.manifestHash ||
      manifestHash !== job.manifestHash ||
      job.id !== manifest.idempotencyKey ||
      job.vaultId !== manifest.vaultId
    )
      throw new Error("The withdrawal's stored intent differs from the one bound at assembly. Nothing was submitted.");
    verifyWithdrawalCommitment(signed.rawTxHex, manifest, job.solution);
    if (btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), opts).id !== signed.txid)
      throw new Error("The signed result's txid differs from its transaction. Nothing was submitted.");
    const vsize = transactionVsize(signed.rawTxHex);
    const milliSatPerVb = (BigInt(manifest.fee) * 1000n) / BigInt(vsize);
    const floor = await this.minerFloor();
    if (belowMinerFloor(milliSatPerVb, floor))
      throw new Error(`The signed fee rate is below MARA's current minimum of ${floor} sat/vB. Nothing was submitted.`);
    const review: WithdrawalReview = Object.freeze({
      network: NETWORK_ID,
      jobId: job.id,
      vaultId: job.vaultId,
      txid: signed.txid,
      destination: manifest.destination,
      outputValue: manifest.outputValue,
      fee: manifest.fee,
      vsize,
      feeRate: Number(milliSatPerVb) / 1000,
      minerMinimumFeeRate: floor,
    });
    if ((await options.approve(review)) !== review.txid)
      throw new Error("The withdrawal was not approved. Nothing was submitted.");
    let response: { txid: string; status: string };
    try {
      response = await this.session.api<{ txid: string; status: string }>(
        `/jobs/${job.id}/submit`,
        submitRequest.parse({ rawTxHex: signed.rawTxHex }),
      );
    } catch (error) {
      if (submitDisabled(error))
        throw new Error("Submission is disabled. Keep the signed result; no submission was accepted.");
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `The submission outcome is uncertain. Keep the signed result and check withdrawals.status; do not submit again.${detail}`,
      );
    }
    if (response.txid !== signed.txid || !["submitted", "uncertain", "confirmed"].includes(response.status))
      throw new Error("Unexpected submission response. Check withdrawals.status; do not submit again.");
    return response;
  }
}
