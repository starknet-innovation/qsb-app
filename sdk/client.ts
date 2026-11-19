import { vaultScriptSigBound } from "../src/lib/transactions";
import { randomUUID } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { ApiRequestError, CREDENTIAL_HEADER, createSessionClient } from "../src/lib/session";
import { NETWORK_ID } from "../src/lib/network";
import { operationsAllowed } from "../src/lib/readiness";
import { canonical, assertVaultConfiguration, withVaultConfiguration } from "../src/lib/provenance";
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
  type StrayPayments,
  type Withdrawal,
} from "../src/lib/model";
import {
  belowMinerFloor,
  fundingFeeForRate,
  fundingPsbt,
  helperPsbt,
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
  coordinatorPublicSolvedResult,
  coordinatorSolvedResultSchema,
  coordinatorSignedResultSchema,
  type CoordinatorSignedResult,
} from "../src/mainnet/coordinatorResult";
import { publicRuntime } from "./public-runtime";
import { pqbSharesSecrets } from "../src/lib/pqb";
import type { AuthorizationStore, CreateWithdrawal, Credentials, ExternalCustody, VaultDescriptor, WithdrawalSigningRequest } from "./custody";
export type { AuthorizationStore } from "./custody";
import {
  btcUsdPrice,
  checkServiceFeeQuote,
  serviceFeeSats,
  SERVICE_FEE_PRICE_SOURCE,
  SERVICE_FEE_USD,
  type ServiceFeeQuote,
} from "../src/lib/service-fee";
// The request bodies the server's handlers parse, so a request can't drift from the API.
import { fundResubmitRequest, fundSubmitRequest, submitRequest } from "../server/api-schemas";
import type { Wallet } from "../src/lib/wallet";

import { apiBase, isLoopback, signerWallet, type Signer } from "./signer";

export { ApiRequestError };
export type { CoordinatorSignedResult as SignedWithdrawal };

type Point = { txid: string; vout: number; value: string };
export type ApiConfig = {
  network?: string;
  operationsEnabled?: boolean;
  exactSubmitEnabled?: boolean;
  solverReleaseId?: string | null;
  solverProtocol?: "qsb-config-a-v1" | "pqb-v1" | null;
  /** The deployment's per-owner limits; `null` when they're misconfigured. `allowlisted` is the signed-in caller's. */
  ownerLimits?: {
    allowlist: boolean;
    allowlisted: boolean | null;
    maxActiveJobs: number | null;
    maxGpuSeconds: number | null;
  } | null;
  /** The optional service fee's address, or null when the deployment doesn't offer it (`serviceFee()`). */
  serviceFeeAddress?: string | null;
  [field: string]: unknown;
};
export type Rates = { submit_fee_rate: number; market_rate?: number; effective_rate?: number };
/** Opting in to the service fee: the most sats you'll pay, and optionally the address you expect. */
export type ServiceFeeLimit = { maxSats: bigint | string; address?: string };
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
  /** `/v1` (default), the stable prefix, or `/api`, the compatibility alias. */
  basePath?: "/v1" | "/api";
  /** External wallet PSBT signer. */
  signer: Signer;
  /** Transport; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** External vault authority; no recovery secrets may cross this interface. */
  custody: ExternalCustody;
  /** Durable, atomic, shared one-time journal; required, with no in-memory default. */
  authorizations: AuthorizationStore;
  /** External credential provider. The SDK does not sign in or persist credentials. */
  credentials: Credentials;
  /** Where signed deposits wait until the miner has them; defaults to memory. */
  pendingDeposits?: PendingDeposits;
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
    /** The opted-in service fee, paid by output 1. Absent when the deposit pays none. */
    serviceFee: z
      .object({
        address: z.string().min(14).max(100),
        amount: sats,
        usd: z.literal(SERVICE_FEE_USD),
        btcUsd: btcUsdPrice,
        source: z.literal(SERVICE_FEE_PRICE_SOURCE),
        quotedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
const depositAnswerSchema = z.object({
  vault: publicVaultSchema,
  submission: z.enum(["submitted", "uncertain", "rejected"]),
  reason: z.string().optional(),
});
/** An unsigned deposit PSBT and its quote. Public data: nothing in it is secret. */
export type PreparedDeposit = z.infer<typeof preparedDepositSchema>;

/**
 * The server's own refusal of a disabled submission: a 503 with code `submit_disabled`. Any
 * other failure, including an uncoded 503 from a gateway or an older server, or the API's 502
 * or 503 for a failed chain or miner request, is uncertain.
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
/** A deposit route's final refusal of a reused script. */
function scriptHeld(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409 && error.code === "vault_script_registered";
}
/** Refuse early when the deployment says this owner can't act, or its limits are misconfigured. */
function assertOwnerAllowed(config: ApiConfig) {
  if (config.ownerLimits === null)
    throw new Error("The deployment's per-owner limits are misconfigured (owner_limits_invalid). Nothing was changed; contact the operator.");
  if (config.ownerLimits?.allowlisted === false)
    throw new Error("This wallet isn't on this deployment's allowlist (owner_not_allowlisted). Nothing was changed.");
}
/**
 * The vault whose script pushes one of these HORS commitments, if any. The script is what the server
 * binds a vault to (its hash); the commitments its public state declares are never checked against it.
 */
function sharingSecrets(vaults: PublicVault[], publicStateJson: string): PublicVault | undefined {
  const state = JSON.parse(publicStateJson);
  if (state.config === "PQB")
    // A reused seed pushes the same HORS commitments under any construction, even where the scripts differ.
    return vaults.find(v => v.config === "PQB" && pqbSharesSecrets(v.publicStateJson, publicStateJson));
  const { hors_commitments: rounds } = state as { hors_commitments: string[][] };
  // Each commitment is a 20-byte push. A chance match elsewhere in a script would only refuse.
  const pushes = rounds.flat().map((commitment) => `14${commitment}`);
  return vaults.find((vault) => pushes.some((push) => vault.scriptHex.toLowerCase().includes(push)));
}
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
/** The HTTP transport: one origin, no redirects, a timeout, and the webapp's session client. */
const apiKeyFormat = /^qsb_mainnet_[A-Za-z0-9_-]{43}$/;
function transport(options: Pick<QsbClientOptions, "baseUrl" | "basePath" | "fetch" | "timeoutMs"> & { credentials?: Credentials }) {
  const origin = apiBase(options.baseUrl).href.replace(/\/$/, "");
  const base = options.basePath ?? "/v1";
  if (base !== "/v1" && base !== "/api") throw new Error("The API base path is /v1 or /api.");
  const send = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 60000;
  // The session client prefixes each route with `base`; this adds the deployment's origin.
  return createSessionClient((async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (options.credentials) {
      const credential = await options.credentials.get();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential) && !apiKeyFormat.test(credential))
        throw new Error("External credentials returned an invalid credential.");
      headers.set(CREDENTIAL_HEADER, `Bearer ${credential}`);
    }
    return send(`${origin}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  }) as typeof fetch, base);
}
/** The unauthenticated routes, for looking at a deployment before any wallet is set up. */
export function publicApi(options: Pick<QsbClientOptions, "baseUrl" | "basePath" | "fetch" | "timeoutMs">) {
  const session = transport(options);
  return {
    config: () => session.api<ApiConfig>("/config"),
    rates: () => session.api<Rates>("/rates"),
    serviceFee: async (): Promise<ServiceFeeQuote> => quoteOnly(await session.api<unknown>("/service-fee")),
  };
}
/** A checked service fee quote, as the server sent it. */
function quoteOnly(value: unknown): ServiceFeeQuote {
  const { output: _output, ...quote } = checkServiceFeeQuote(value);
  return quote;
}

/**
 * A public planner and validator for the QSB API. All key, recovery and credential
 * lifecycle management belongs to caller-owned external providers.
 */
export class QsbClient {
  private readonly session: ReturnType<typeof createSessionClient>;
  private readonly signer: Signer;
  private readonly wallet: Wallet;
  private readonly runtime = publicRuntime();
  private readonly custody: ExternalCustody;
  private readonly pending: PendingDeposits;
  private readonly authorizations: AuthorizationStore;


  constructor(options: QsbClientOptions) {
    const base = apiBase(options.baseUrl);
    if (options.signer.loopbackOnly && !isLoopback(base))
      throw new Error("This signer holds a raw key and only works with a loopback API URL.");
    this.signer = options.signer;
    this.wallet = signerWallet(options.signer);
    if (!options.custody || !options.authorizations || !options.credentials)
      throw new Error("External custody, durable authorizations and credentials are required.");
    this.custody = options.custody;
    this.pending = options.pendingDeposits ?? memoryPending();
    this.authorizations = options.authorizations;
    this.session = transport(options);
  }

  config(): Promise<ApiConfig> {
    return this.session.api<ApiConfig>("/config");
  }
  rates(): Promise<Rates> {
    return this.session.api<Rates>("/rates");
  }
  /**
   * The optional service fee: the fixed USD amount in sats at the server's current BTC/USD price,
   * and its address. It's checked to be self-consistent; pass `serviceFee: true` to
   * `deposits.prepare` to pay it.
   */
  async serviceFee(): Promise<ServiceFeeQuote> {
    return quoteOnly(await this.session.api<unknown>("/service-fee"));
  }
  /** The current quote, refused unless it pays the configured address (and `limit.address`) at most `limit.maxSats`. */
  private async serviceFeeWithin(config: ApiConfig, limit: ServiceFeeLimit) {
    const max = BigInt(sats.parse(String(limit.maxSats)));
    const quote = checkServiceFeeQuote(await this.session.api<unknown>("/service-fee"));
    if (typeof config.serviceFeeAddress !== "string" || quote.address !== config.serviceFeeAddress)
      throw new Error("The service fee quote doesn't pay this deployment's configured fee address. Nothing was prepared.");
    if (limit.address !== undefined && quote.address !== limit.address)
      throw new Error(`The service fee pays ${quote.address}, not ${limit.address}. Nothing was prepared.`);
    if (quote.output.amount > max)
      throw new Error(`The service fee is ${quote.sats} sats (USD ${quote.usd} at ${quote.btcUsd} USD/BTC), above your limit of ${max} sats. Nothing was prepared.`);
    return quote;
  }
  /** Confirmed payment outputs of the signed-in address. */
  async utxos(): Promise<Point[]> {
    return (await this.session.api<{ utxos: Point[] }>("/payment-utxos")).utxos;
  }

  readonly vaults = {
    /** Register public material only, after the external manager confirms durable recoverability. */
    create: (input: { name: string; descriptor: VaultDescriptor }) => this.createVault(input),
    list: () =>
      this.session.api<{
        vaults: PublicVault[];
        resendable?: string[];
        /** Vaults that take no deposit: another vault on the deployment holds their script. */
        noDeposit?: string[];
        strayPayments?: StrayPayments[];
      }>("/vaults"),
  };
  readonly deposits = {
    /**
     * An unsigned deposit PSBT after public validation and external recoverability confirmation.
     * With `serviceFee`, it also pays the optional service fee at the current quote, as output 1,
     * on top of `amount`: only up to `maxSats`, and only to the deployment's configured fee
     * address (and to `address`, when given). The amount is fixed here, at prepare.
     */
    prepare: (
      vaultId: string,
      input: {
        amount: bigint | string;
        feeRate: string;
        utxos: { txid: string; vout: number }[];
        serviceFee?: ServiceFeeLimit;
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
    /** Persist the exact intent externally before starting paid work; resume it unchanged after a crash. */
    create: (input: CreateWithdrawal) => this.createWithdrawal(input),
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
    /** Public solution, exact spend and verified previous outputs for an external vault signer. */
    prepare: (jobId: string) => this.prepareWithdrawal(jobId),
    /** External vault authorization followed by verified helper signing. No seed enters the SDK. */
    assemble: (jobId: string) => this.assembleWithdrawal(jobId),
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

  private async checkedVault(value: PublicVault): Promise<PublicVault> {
    const vault = publicVaultSchema.parse(value);
    assertVaultConfiguration(vault);
    if (vault.paymentAddress !== this.wallet.address) throw new Error("Vault belongs to a different wallet.");
    await this.runtime.validate(vault);
    return vault;
  }

  private intentKey(vault: PublicVault) { return `qsb-intent:${NETWORK_ID}:${vault.scriptHash}`; }
  private assemblyKey(vault: PublicVault) { return `qsb-assembly:${NETWORK_ID}:${vault.scriptHash}`; }

  private async createVault(input: { name: string; descriptor: VaultDescriptor }) {
    // Strict schemas prevent unknown/private fields from being projected into a request.
    const descriptor = z.object({ config: z.enum(["A", "PQB"]), scriptHex: z.string(), scriptHash: txid,
      publicStateJson: z.string().max(60000) }).strict().parse(input.descriptor);
    const name = input.name.trim();
    assertOwnerAllowed(await this.assertServerNetwork());
    const vault = await this.checkedVault(withVaultConfiguration({
      id: randomUUID(), name, createdAt: new Date().toISOString(), network: NETWORK_ID,
      ...descriptor, paymentAddress: this.wallet.address, status: "unfunded",
    }));
    if (sharingSecrets((await this.vaults.list()).vaults, vault.publicStateJson))
      throw new Error("This descriptor reuses another vault's one-time material.");
    await this.custody.confirmVault(structuredClone(vault));
    if (sharingSecrets((await this.vaults.list()).vaults, vault.publicStateJson))
      throw new Error("This descriptor reuses another vault's one-time material.");
    const registered = await this.session.api<{ vault: PublicVault }>("/vaults", vault);
    if (canonical(registered.vault) !== canonical(vault)) throw new Error("Registered vault differs from the approved descriptor.");
    return { vault };
  }

  private async prepareDeposit(
    vaultId: string,
    input: {
      amount: bigint | string;
      feeRate: string;
      utxos: { txid: string; vout: number }[];
      serviceFee?: ServiceFeeLimit;
    },
  ): Promise<PreparedDeposit> {
    const config = await this.assertOperations();
    assertOwnerAllowed(config);
    if (config.exactSubmitEnabled !== true)
      throw new Error("Deposits are submitted to MARA Slipstream, which is switched off right now. Nothing was prepared.");
    if (await this.pending.get(vaultId))
      throw new Error("A signed deposit for this vault is waiting for MARA. Resubmit it; do not deposit again.");
    id(vaultId, "vault");
    const listed = await this.vaults.list();
    const vault = listed.vaults.find((v) => v.id === vaultId);
    if (!vault) throw new Error("Vault not found for this address.");
    if (listed.noDeposit?.includes(vaultId))
      throw new Error(
        "Another vault on this deployment holds this vault's script, so this vault takes no deposit. Nothing was prepared; don't pay into its script.",
      );
    if (vault.status !== "unfunded" || vault.funding)
      throw new Error("This vault already has a deposit. A vault takes one deposit; do not deposit again.");
    await this.checkedVault(vault);
    await this.custody.confirmVault(structuredClone(vault));
    const amount = BigInt(sats.parse(String(input.amount)));
    if (amount === 0n) throw new Error("Amount must be greater than zero.");
    const rate = parseFeeRate(input.feeRate);
    if (!input.utxos.length || input.utxos.length > 8)
      throw new Error("Select between one and eight payment outputs.");
    const inputs = await Promise.all((await this.selectUtxos(input.utxos)).map((p) => this.fundingInput(p)));
    await this.assertMinerFloor(rate);
    const service = input.serviceFee ? await this.serviceFeeWithin(config, input.serviceFee) : undefined;
    const quote = fundingFeeForRate(
      inputs.map((i) => i.value),
      nestedPaymentAddress(this.wallet.address),
      vault.scriptHex.length / 2,
      amount,
      rate,
      service?.output.amount,
    );
    const tx = fundingPsbt(inputs, vault.scriptHex, amount, quote.fee, this.wallet.address, service?.output);
    if (tx.outputsLength !== 1 + (service ? 1 : 0) + (quote.change ? 1 : 0))
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
      change: (total - amount - quote.fee - (service?.output.amount ?? 0n)).toString(),
      vsize: quote.vsize,
      ...(service
        ? {
            serviceFee: {
              address: service.address,
              amount: service.sats,
              usd: service.usd,
              btcUsd: service.btcUsd,
              source: service.source,
              quotedAt: service.quotedAt,
            },
          }
        : {}),
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
    // An edited file could change the fee: it must still be the USD amount at its own price.
    if (prepared.serviceFee && BigInt(prepared.serviceFee.amount) !== serviceFeeSats(prepared.serviceFee.btcUsd))
      throw new Error("The prepared deposit's service fee doesn't match its price.");
    const expected = fundingPsbt(
      inputs,
      vault.scriptHex,
      BigInt(prepared.amount),
      BigInt(prepared.fee),
      this.wallet.address,
      prepared.serviceFee
        ? { address: prepared.serviceFee.address, amount: BigInt(prepared.serviceFee.amount) }
        : undefined,
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
    // An edited file could redirect the service fee: it must still pay the deployment's address.
    if (prepared.serviceFee && config.serviceFeeAddress !== prepared.serviceFee.address)
      throw new Error("The prepared deposit's service fee doesn't pay this deployment's fee address. Nothing was sent.");
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
      // Final for this vault, not just this request: every deposit route refuses it, so the pending
      // bytes guard nothing and would only offer a resend that's refused.
      if (scriptHeld(error)) {
        await this.pending.delete(vaultId);
        throw refused(
          error,
          "the deposit",
          " Don't resend this deposit or sign another for this vault. If it was sent before, it may still confirm: deposits.status shows it once it's mined, so keep this vault's backup.",
        );
      }
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
      if (scriptHeld(error))
        throw refused(
          error,
          "to resend the deposit",
          " Don't resend it or sign another deposit for this vault. If it was sent before, it may still confirm: deposits.status shows it once it's mined, so keep this vault's backup.",
        );
      throw ownerRefusal(error) ? refused(error, "to resend the deposit", " Resend it once allowed; don't sign another.") : error;
    }
  }
  private async depositStatus(vaultId: string) {
    const status = await this.session.api<{
      vault: PublicVault;
      status: { confirmed: boolean; confirmations?: number };
      strayPayments?: StrayPayments | null;
      submission?: string;
      previousTxHex: string;
    }>(`/vaults/${id(vaultId, "vault")}/funding`);
    const waiting = await this.pending.get(vaultId);
    if (waiting && status.vault.funding?.txid === waiting.txid && status.status.confirmed)
      await this.pending.delete(vaultId);
    return status;
  }

  private async createWithdrawal(input: CreateWithdrawal): Promise<{ job: Job }> {
    if (input.costAccepted !== true)
      throw new Error("Accept the costs first: withdrawals.create needs { costAccepted: true }.");
    const config = await this.assertOperations();
    assertOwnerAllowed(config);
    const vault = await this.vault(input.vaultId);
    await this.checkedVault(vault);
    const savedText = await this.authorizations.get(this.intentKey(vault));
    const saved = savedText === undefined ? undefined : withdrawalSchema.parse(JSON.parse(savedText));
    const other = (await this.withdrawals.list()).find(
      (job) => job.vaultId === vault.id && job.id !== saved?.idempotencyKey,
    );
    if (other) throw new Error(`This vault already has a withdrawal request (${other.id}). Resume that one.`);
    const funded = await this.depositStatus(vault.id);
    if (!funded.status.confirmed || !funded.vault.funding) throw new Error("Wait for the deposit to confirm.");
    const funding = funded.vault.funding;
    if ((config.solverProtocol ?? "qsb-config-a-v1") !== vault.configuration.protocol)
      throw new Error("The deployment serves a different vault protocol. Nothing was created.");
    if (!config.solverReleaseId)
      throw new Error("The deployment serves no solver right now. Nothing was created.");
    if (input.solverReleaseId !== undefined && input.solverReleaseId !== config.solverReleaseId)
      throw new Error("The deployment solver differs from the requested one. Nothing was created.");
    const nested = nestedPaymentAddress(this.wallet.address);
    let manifest: Withdrawal;
    if (saved) {
      // Resume the saved intent exactly: its payout and one-time keys are already bound.
      if (
        (input.destination !== undefined && input.destination !== saved.destination) ||
        (input.helper !== undefined &&
          (input.helper.txid.toLowerCase() !== saved.helper.txid || input.helper.vout !== saved.helper.vout)) ||
        input.feeRate !== undefined
      )
        throw new Error("This vault already authorizes a withdrawal. Resume it unchanged; do not reuse its one-time keys.");
      if (saved.solverReleaseId !== config.solverReleaseId)
        throw new Error("The saved intent uses a different solver. Keep its external authorization and contact the operator; do not create a new intent.");
      if ((["txid", "vout", "value"] as const).some((field) => saved.funding[field] !== funding[field]))
        throw new Error("The saved intent spends a different deposit.");
      const vsize = withdrawalVsize(nested, saved.outputScript.length / 2, vaultScriptSigBound(vault.config));
      await this.assertMinerFloor((BigInt(saved.fee) * 1000n) / BigInt(vsize));
      manifest = saved;
      await this.authorizations.claim(this.intentKey(vault), JSON.stringify(canonicalManifest(saved)));
    } else {
      if (!input.helper || !input.destination || !input.feeRate)
        throw new Error("Choose a helper output, a destination and a fee rate.");
      const [helper] = await this.selectUtxos([input.helper]);
      const script = outputScript(input.destination);
      const rate = parseFeeRate(input.feeRate);
      await this.assertMinerFloor(rate);
      const fee = withdrawalFeeForRate(nested, script.length, rate, vault.config).fee;
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
      // The external store must atomically refuse a conflicting claim, across all processes/devices.
      await this.authorizations.claim(this.intentKey(vault), JSON.stringify(canonicalManifest(manifest)));
    }
    const manifestHash = digest(JSON.stringify(manifest));
    let job: Job;
    try {
      ({ job } = await this.session.api<{ job: Job }>("/jobs", manifest));
    } catch (error) {
      if (ownerRefusal(error)) throw refused(error, "to create the search", " Resume the externally saved intent unchanged.");
      throw new Error("The search outcome is unconfirmed. Retry withdrawals.create with the vault id only; the external journal retains the exact intent.", { cause: error });
    }
    if (job.id !== manifest.idempotencyKey || job.manifestHash !== manifestHash)
      throw new Error("The server returned a different withdrawal. Keep the external authorization and check withdrawals.list.");
    return { job };
  }

  private async prepareWithdrawal(jobId: string): Promise<WithdrawalSigningRequest> {
    const { job } = await this.withdrawals.status(jobId);
    const expected = coordinatorPublicSolvedResult(job);
    const solved = coordinatorSolvedResultSchema.parse(await this.session.api<unknown>(`/jobs/${job.id}/solved-result`));
    if (canonical(expected) !== canonical(solved)) throw new Error("Solved result does not match this withdrawal.");
    const funding = await this.depositStatus(job.vaultId);
    const vault = await this.checkedVault(funding.vault);
    const manifest = canonicalManifest(solved.manifest);
    if (await this.authorizations.get(this.intentKey(vault)) !== JSON.stringify(manifest))
      throw new Error("The job differs from the externally authorized withdrawal intent.");
    const helper = await this.fundingInput(manifest.helper);
    const prepared = await this.runtime.prepare(vault, manifest, solved.solution);
    // Validate both previous outputs and the exact transaction BEFORE asking for one-time material.
    // helperPsbt requires a vault scriptSig; a temporary public placeholder is discarded immediately.
    const template = btc.Transaction.fromRaw(hex.decode(prepared.transaction), opts);
    if (template.getInput(0).finalScriptSig?.length || template.getInput(1).finalScriptSig?.length ||
      template.getInput(0).finalScriptWitness?.length || template.getInput(1).finalScriptWitness?.length)
      throw new Error("Signing template must be unsigned.");
    template.updateInput(1, { finalScriptSig: new Uint8Array([0]) }, true);
    const raw = hex.encode(template.toBytes(true, true));
    verifyWithdrawalCommitment(raw, manifest, solved.solution);
    // This validates previous txids, values, scripts and helper ownership.
    helperPsbt(raw, helper, funding.previousTxHex, { value: manifest.funding.value, scriptHex: vault.scriptHex });
    return { format: "qsb-external-signing-request-v1", vault, solved, ...prepared,
      fundingPreviousTxHex: funding.previousTxHex, helperPreviousTxHex: helper.previousTxHex,
      helperAddress: this.wallet.address, helperPublicKey: this.wallet.publicKey };
  }

  private async assembleWithdrawal(jobId: string): Promise<CoordinatorSignedResult> {
    const request = await this.prepareWithdrawal(jobId);
    const key = this.assemblyKey(request.vault);
    // Bind public transaction AND solution before any preimages or signatures can be disclosed.
    const binding = digest(canonical({ manifestHash: request.solved.manifestHash,
      transaction: request.transaction, solution: request.solved.solution }));
    await this.authorizations.claim(key, binding);
    const response = await this.custody.authorizeWithdrawal(structuredClone(request));
    const raw = hex.encode(hex.decode(z.string().regex(/^(?:[0-9a-f]{2})+$/i).max(3000000).parse(response)));
    // A crash/retry may request authorization again, but can never use a different returned assembly.
    const local = await rebuildWithdrawalFromSolvedResult({ solved: request.solved,
      job: { id: request.solved.jobId, vaultId: request.vault.id, manifestHash: request.solved.manifestHash,
        manifest: request.solved.manifest, solution: request.solved.solution } as Job,
      stateJson: "", helper: { ...request.solved.manifest.helper, value: BigInt(request.solved.manifest.helper.value),
        previousTxHex: request.helperPreviousTxHex, address: this.wallet.address, publicKey: this.wallet.publicKey },
      fundingPreviousTxHex: request.fundingPreviousTxHex, vaultScriptHex: request.vault.scriptHex,
      assemble: async () => raw });
    const returnedTx = btc.Transaction.fromRaw(hex.decode(raw), opts);
    if (returnedTx.getInput(0).finalScriptSig?.length || returnedTx.getInput(0).finalScriptWitness?.length ||
      returnedTx.getInput(1).finalScriptWitness?.length)
      throw new Error("External vault authorization must leave helper input unsigned and use a legacy vault scriptSig.");
    await this.runtime.verify(request.vault, request.solved.manifest, request.solved.solution, raw);
    await this.authorizations.claim(`${key}:raw`, digest(raw));
    const returned = await this.signer.signPsbt(this.wallet.address, base64.encode(local.transaction.toPSBT()), [0]);
    return signedCoordinatorResult(local.solved, local.transaction, decodePsbt(returned), this.wallet);
  }

  private async submitWithdrawal(
    input: CoordinatorSignedResult,
    options: { approve: ApproveWithdrawal },
  ): Promise<{ txid: string; status: string }> {
    if (typeof options?.approve !== "function")
      throw new Error("withdrawals.submit needs an approve callback. Nothing was submitted.");
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
    const request = await this.prepareWithdrawal(job.id);
    if (JSON.stringify(manifest) !== await this.authorizations.get(this.intentKey(request.vault)))
      throw new Error("The signed result differs from the externally approved intent.");
    verifyWithdrawalCommitment(signed.rawTxHex, manifest, job.solution);
    const actual = btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), opts);
    if (actual.id !== signed.txid)
      throw new Error("The signed result's txid differs from its transaction. Nothing was submitted.");
    // Recreate the exact assembly before helper signing, to validate an imported signed file too.
    const assembly = new btc.Transaction({ ...opts, version: actual.version, lockTime: actual.lockTime });
    for (let i = 0; i < actual.inputsLength; i++) {
      const v = actual.getInput(i);
      assembly.addInput({ txid: v.txid, index: v.index, sequence: v.sequence });
    }
    assembly.addOutput(actual.getOutput(0));
    assembly.updateInput(1, { finalScriptSig: actual.getInput(1).finalScriptSig }, true);
    const raw = hex.encode(assembly.toBytes(true, true));
    if (await this.authorizations.get(`${this.assemblyKey(request.vault)}:raw`) !== digest(raw))
      throw new Error("The signed result differs from the externally bound assembly.");
    const expected = helperPsbt(raw, { ...manifest.helper, value: BigInt(manifest.helper.value),
      previousTxHex: request.helperPreviousTxHex, address: this.wallet.address, publicKey: this.wallet.publicKey },
      request.fundingPreviousTxHex, { value: manifest.funding.value, scriptHex: request.vault.scriptHex });
    const returned = expected.clone();
    returned.updateInput(0, { finalScriptSig: actual.getInput(0).finalScriptSig,
      finalScriptWitness: actual.getInput(0).finalScriptWitness }, true);
    if (signedCoordinatorResult(request.solved, expected, returned.toPSBT(), this.wallet).rawTxHex !== signed.rawTxHex)
      throw new Error("The imported signed result failed helper verification.");
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
    // The funding outpoint was spent by another transaction, so this one can never confirm.
    if (response.txid === signed.txid && response.status === "conflict")
      throw new Error(
        "Funding outpoint was spent by a different transaction. Contact the operator; do not resubmit or spend the helper output.",
      );
    if (response.txid !== signed.txid || !["submitted", "uncertain", "confirmed"].includes(response.status))
      throw new Error("Unexpected submission response. Check withdrawals.status; do not submit again.");
    return response;
  }
}
