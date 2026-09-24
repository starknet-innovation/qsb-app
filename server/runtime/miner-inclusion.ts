import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { z } from "zod";
import { assertNoCredentialMaterial } from "./host-requirements";

/**
 * Section 7 gates. Nothing here broadcasts, funds a wallet, or contacts a
 * chain provider or miner. A transport result is not inclusion.
 * release.mainnetEnabled and broadcastAuthorized stay false.
 */

export class MinerInclusionError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "MinerInclusionError";
  }
}

export const HISTORICAL_REGTEST_FIXTURE_LABEL =
  "historical-xverse-regtest-withdrawal";

export const XVERSE_TESTNET4_COMPATIBILITY =
  "Installed Xverse Testnet4 compatibility has not been established by the existing evidence.";

export const TESTNET4_OPTIONAL =
  "Testnet4 is an optional risk-reduction path, not a mandatory Bitcoin prerequisite.";

export const REGTEST_ON_TESTNET4_PREFLIGHT = {
  usefulTest: false as const,
  repeat: false as const,
  reason:
    "A regtest transaction sent to a Testnet4 preflight returned missing inputs. That chain mismatch is not a useful test to repeat.",
};

export const EXTERNAL_MINER_CATALOG = {
  mainnet: {
    label: "Bitcoin mainnet",
    genesisHash:
      "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    chainUrl: "https://blockstream.info/api",
    minerUrl: "https://slipstream.mara.com",
  },
  testnet4: {
    label: "Bitcoin Testnet4",
    genesisHash:
      "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
    chainUrl: "https://mempool.space/testnet4/api",
    minerUrl: "https://teststream.mara.com",
  },
} as const;

export type ExternalChainId = keyof typeof EXTERNAL_MINER_CATALOG;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/i);
const positiveSats = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => {
    try {
      const amount = BigInt(value);
      return amount > 0n && amount <= 2100000000000000n;
    } catch {
      return false;
    }
  });

const partiesSchema = z
  .object({
    wallet: z
      .object({
        chain: z.string().min(1).max(32),
        app: z.string().min(1).max(64),
      })
      .strict(),
    builder: z.object({ chain: z.string().min(1).max(32) }).strict(),
    chainProvider: z
      .object({
        chain: z.string().min(1).max(32),
        genesisHash: hash64,
        baseUrl: z.string().min(8).max(200),
      })
      .strict(),
    miner: z
      .object({
        chain: z.string().min(1).max(32),
        endpoint: z.string().min(8).max(200),
      })
      .strict(),
  })
  .strict();

export type MinerParties = z.infer<typeof partiesSchema>;

const candidateSchema = z
  .object({
    chain: z.string().min(1).max(32),
    txid: hash64,
    rawTxHex: z.string().regex(/^(?:[a-f0-9]{2})+$/i).max(150000),
    amountSats: positiveSats,
    feeSats: positiveSats,
    fixtureLabel: z.string().min(1).max(128).optional(),
    restartsHistoricalFixture: z.boolean().optional(),
  })
  .strict();

const exactSpendSchema = z
  .object({
    format: z.literal("qsb-exact-spend-authorization-v1"),
    chain: z.enum(["mainnet", "testnet4"]),
    txid: hash64,
    rawTxSha256: hash64,
    amountSats: positiveSats,
    feeSats: positiveSats,
    directMainnetDecision: z.enum(["explicit", "not-requested"]),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

const spentRefSchema = z
  .object({
    label: z.string().min(1).max(128).optional(),
    chain: z.enum(["mainnet", "testnet4", "regtest"]).optional(),
    txid: hash64.optional(),
    vout: z.number().int().min(0).max(0xffffffff).optional(),
    spent: z.literal(true).optional(),
    outpoint: z
      .object({
        txid: hash64,
        vout: z.number().int().min(0).max(0xffffffff),
      })
      .strict()
      .optional(),
  })
  .strict();

type SpentRef = z.infer<typeof spentRefSchema>;
type Outpoint = { txid: string; vout: number };

const MAINNET_LIMITS = [
  "Direct mainnet testing is a separate explicitly authorized decision.",
  "Chain agreement does not waive technical gates or authorize an arbitrary transaction.",
  "No chain provider or miner endpoint was contacted.",
  "release.mainnetEnabled and broadcastAuthorized stay false.",
  REGTEST_ON_TESTNET4_PREFLIGHT.reason,
] as const;

const TESTNET4_LIMITS = [
  TESTNET4_OPTIONAL,
  XVERSE_TESTNET4_COMPATIBILITY,
  "No chain provider or miner endpoint was contacted.",
  "Agreement does not fund, broadcast, or confirm inclusion.",
  REGTEST_ON_TESTNET4_PREFLIGHT.reason,
] as const;

export type ChainAgreement = {
  format: "qsb-external-chain-agreement-v1";
  chain: ExternalChainId;
  partiesAgree: true;
  endpointsContacted: false;
  optionalRiskReduction: boolean;
  mandatoryBitcoinPrerequisite: false;
  xverseTestnet4CompatibilityEstablished: false;
  directMainnetDecisionRequired: boolean;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  section7Closed: false;
  limits: readonly string[];
};

export type WalletFundingAssessment = {
  format: "qsb-wallet-funding-assessment-v1";
  askUserToFund: false;
  funded: false;
  refusedBecauseUnsupported: boolean;
  xverseTestnet4CompatibilityEstablished: false;
  reason: string;
};

export type BroadcastPermit = {
  format: "qsb-exact-spend-permit-v1";
  chain: ExternalChainId;
  /** Catalog miner origin agreed when the permit was minted. */
  minerEndpoint: string;
  txid: string;
  rawTxSha256: string;
  amountSats: string;
  feeSats: string;
  transportCalled: false;
  inclusion: false;
  section7Closed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  askUserToFund: false;
  xverseTestnet4CompatibilityEstablished: false;
  optionalRiskReduction: boolean;
  directMainnetDecision: "explicit" | "not-applicable";
  endpointsContacted: false;
};

const permits = new WeakSet<BroadcastPermit>();

function isExternalChain(value: string): value is ExternalChainId {
  return value === "mainnet" || value === "testnet4";
}

function isXverse(app: string): boolean {
  return app.trim().toLowerCase() === "xverse";
}

function lower(value: string): string {
  return value.toLowerCase();
}

function parseParties(input: unknown): MinerParties {
  const parsed = partiesSchema.safeParse(input);
  if (!parsed.success) throw new MinerInclusionError("ChainAgreementMismatch");
  return parsed.data;
}

function regtestPointedAtTestnet4(parties: MinerParties): boolean {
  const labels = [
    parties.wallet.chain,
    parties.builder.chain,
    parties.chainProvider.chain,
    parties.miner.chain,
  ];
  const testnet4 =
    labels.includes("testnet4") ||
    parties.chainProvider.baseUrl === EXTERNAL_MINER_CATALOG.testnet4.chainUrl ||
    parties.miner.endpoint === EXTERNAL_MINER_CATALOG.testnet4.minerUrl;
  return labels.includes("regtest") && testnet4;
}

export function agreeExternalMinerChain(input: unknown): ChainAgreement {
  assertNoCredentialMaterial(input);
  const parties = parseParties(input);
  if (regtestPointedAtTestnet4(parties))
    throw new MinerInclusionError("RegtestOnTestnet4PreflightNotUseful");
  const chain = parties.wallet.chain;
  if (!isExternalChain(chain))
    throw new MinerInclusionError("ExternalChainRefused");
  if (
    parties.builder.chain !== chain ||
    parties.chainProvider.chain !== chain ||
    parties.miner.chain !== chain
  )
    throw new MinerInclusionError("ChainAgreementMismatch");
  const catalog = EXTERNAL_MINER_CATALOG[chain];
  if (
    lower(parties.chainProvider.genesisHash) !== catalog.genesisHash ||
    parties.chainProvider.baseUrl !== catalog.chainUrl ||
    parties.miner.endpoint !== catalog.minerUrl
  )
    throw new MinerInclusionError("ChainAgreementMismatch");
  switch (chain) {
    case "mainnet":
      return {
        format: "qsb-external-chain-agreement-v1",
        chain,
        partiesAgree: true,
        endpointsContacted: false,
        optionalRiskReduction: false,
        mandatoryBitcoinPrerequisite: false,
        xverseTestnet4CompatibilityEstablished: false,
        directMainnetDecisionRequired: true,
        mainnetEnabled: false,
        broadcastAuthorized: false,
        section7Closed: false,
        limits: MAINNET_LIMITS,
      };
    case "testnet4":
      return {
        format: "qsb-external-chain-agreement-v1",
        chain,
        partiesAgree: true,
        endpointsContacted: false,
        optionalRiskReduction: true,
        mandatoryBitcoinPrerequisite: false,
        xverseTestnet4CompatibilityEstablished: false,
        directMainnetDecisionRequired: false,
        mainnetEnabled: false,
        broadcastAuthorized: false,
        section7Closed: false,
        limits: TESTNET4_LIMITS,
      };
    default: {
      const neverChain: never = chain;
      throw new MinerInclusionError(`ExternalChainRefused:${String(neverChain)}`);
    }
  }
}

export function assessWalletFundingRequest(input: {
  chain: string;
  walletApp: string;
  xverseTestnet4CompatibilityEstablished?: boolean;
}): WalletFundingAssessment {
  assertNoCredentialMaterial(input);
  if (input.xverseTestnet4CompatibilityEstablished === true)
    throw new MinerInclusionError("XverseTestnet4CompatibilityNotEstablished");
  const parsedChain = z
    .enum(["mainnet", "testnet4", "regtest"])
    .safeParse(input.chain);
  if (!parsedChain.success) throw new MinerInclusionError("ExternalChainRefused");
  const chainName = parsedChain.data;
  const base = {
    format: "qsb-wallet-funding-assessment-v1" as const,
    askUserToFund: false as const,
    funded: false as const,
    xverseTestnet4CompatibilityEstablished: false as const,
  };
  switch (chainName) {
    case "mainnet":
      return {
        ...base,
        refusedBecauseUnsupported: false,
        reason:
          "This checkout does not fund a wallet. Mainnet Xverse compatibility is not certified here.",
      };
    case "testnet4":
      return {
        ...base,
        refusedBecauseUnsupported: true,
        reason: isXverse(input.walletApp)
          ? XVERSE_TESTNET4_COMPATIBILITY
          : "No supported Testnet4 wallet configuration is established by the existing evidence.",
      };
    case "regtest":
      return {
        ...base,
        refusedBecauseUnsupported: true,
        reason:
          "Regtest is not an external miner chain. Do not fund an external miner from a regtest wallet.",
      };
    default: {
      const neverChain: never = chainName;
      throw new MinerInclusionError(`ExternalChainRefused:${String(neverChain)}`);
    }
  }
}

function readTransaction(rawTxHex: string): btc.Transaction {
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || rawTxHex.length > 150000)
    throw new MinerInclusionError("ExactSpendMismatch");
  try {
    return btc.Transaction.fromRaw(hex.decode(rawTxHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  } catch {
    throw new MinerInclusionError("ExactSpendMismatch");
  }
}

export function transactionId(rawTxHex: string): string {
  return readTransaction(rawTxHex).id;
}

export function rawTransactionSha256(rawTxHex: string): string {
  readTransaction(rawTxHex);
  return createHash("sha256").update(Buffer.from(rawTxHex, "hex")).digest("hex");
}

function inputOutpoints(tx: btc.Transaction): Outpoint[] {
  const points: Outpoint[] = [];
  for (let index = 0; index < tx.inputsLength; index += 1) {
    const input = tx.getInput(index);
    if (!input.txid || input.index === undefined)
      throw new MinerInclusionError("ExactSpendMismatch");
    points.push({ txid: hex.encode(input.txid).toLowerCase(), vout: input.index });
  }
  if (points.length === 0) throw new MinerInclusionError("ExactSpendMismatch");
  return points;
}

function refOutpoints(ref: SpentRef): Outpoint[] {
  const points: Outpoint[] = [];
  if (ref.outpoint)
    points.push({
      txid: lower(ref.outpoint.txid),
      vout: ref.outpoint.vout,
    });
  if (ref.txid !== undefined && ref.vout !== undefined)
    points.push({ txid: lower(ref.txid), vout: ref.vout });
  return points;
}

function refHasIdentity(ref: SpentRef): boolean {
  return Boolean(ref.txid || ref.outpoint);
}

function spentRegtest(ref: SpentRef): boolean {
  return (
    ref.chain === "regtest" || ref.label === HISTORICAL_REGTEST_FIXTURE_LABEL
  );
}

function assertCandidateNotRegtest(candidate: {
  chain: string;
  fixtureLabel?: string;
  restartsHistoricalFixture?: boolean;
}): void {
  if (
    candidate.chain === "regtest" ||
    candidate.restartsHistoricalFixture === true ||
    candidate.fixtureLabel === HISTORICAL_REGTEST_FIXTURE_LABEL
  )
    throw new MinerInclusionError("SpentRegtestReuseRefused");
}

function assertReusableFixture(input: {
  chain: string;
  txid: string;
  fixtureLabel?: string;
  restartsHistoricalFixture?: boolean;
  outpoints: Outpoint[];
  refs: SpentRef[];
}): void {
  if (
    input.chain === "regtest" ||
    input.restartsHistoricalFixture === true ||
    input.fixtureLabel === HISTORICAL_REGTEST_FIXTURE_LABEL
  )
    throw new MinerInclusionError("SpentRegtestReuseRefused");
  if (!input.refs.some(refHasIdentity))
    throw new MinerInclusionError("InventoryHasNoExclusionPower");
  const txid = lower(input.txid);
  for (const ref of input.refs) {
    const code = spentRegtest(ref)
      ? "SpentRegtestReuseRefused"
      : "SpentInputRefused";
    if (ref.txid && lower(ref.txid) === txid)
      throw new MinerInclusionError(code);
    for (const refPoint of refOutpoints(ref)) {
      for (const point of input.outpoints) {
        if (refPoint.txid === point.txid && refPoint.vout === point.vout)
          throw new MinerInclusionError(code);
      }
    }
  }
}

function parseSpentRefs(input: unknown): SpentRef[] {
  const parsed = z.array(spentRefSchema).max(32).safeParse(input ?? []);
  if (!parsed.success) throw new MinerInclusionError("SpentFixtureRejected");
  return parsed.data;
}

function assertReleaseClosed(release: {
  mainnetEnabled?: boolean;
  broadcastAuthorized?: boolean;
}): void {
  if (release.mainnetEnabled !== false || release.broadcastAuthorized === true)
    throw new MinerInclusionError("ActivationRefused");
}

function parseExactSpend(input: unknown): z.infer<typeof exactSpendSchema> {
  if (input === undefined || input === null)
    throw new MinerInclusionError("SpendAuthorizationRequired");
  const parsed = exactSpendSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const paths = parsed.error.issues.map((issue) => issue.path.join("."));
  if (
    paths.some(
      (path) => path === "mainnetEnabled" || path === "broadcastAuthorized",
    )
  )
    throw new MinerInclusionError("ActivationRefused");
  throw new MinerInclusionError("SpendAuthorizationRequired");
}

export type InclusionPlan = {
  format: "qsb-external-inclusion-plan-v1";
  chain: ExternalChainId;
  partiesAgree: true;
  endpointsContacted: false;
  optionalRiskReduction: boolean;
  mandatoryBitcoinPrerequisite: false;
  xverseTestnet4CompatibilityEstablished: false;
  directMainnetDecisionRequired: boolean;
  fixtureCreated: false;
  freshCommitmentsCreated: false;
  spentRegtestReused: false;
  askUserToFund: false;
  fundingRefused: boolean;
  globalFreshness: false;
  searchCompleted: false;
  submitted: false;
  included: false;
  section7Closed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  limits: readonly string[];
};

export function describeExternalInclusion(input: {
  parties: unknown;
  candidate: unknown;
  spentFixtureRefs: unknown;
  release: { mainnetEnabled?: boolean; broadcastAuthorized?: boolean };
}): InclusionPlan {
  assertNoCredentialMaterial(input);
  assertReleaseClosed(input.release);
  const agreement = agreeExternalMinerChain(input.parties);
  const candidate = candidateSchema.safeParse(input.candidate);
  if (!candidate.success) throw new MinerInclusionError("ExactSpendMismatch");
  assertCandidateNotRegtest(candidate.data);
  const tx = readTransaction(candidate.data.rawTxHex);
  if (lower(candidate.data.txid) !== tx.id)
    throw new MinerInclusionError("ExactSpendMismatch");
  if (candidate.data.chain !== agreement.chain)
    throw new MinerInclusionError("ChainAgreementMismatch");
  assertReusableFixture({
    chain: candidate.data.chain,
    txid: tx.id,
    fixtureLabel: candidate.data.fixtureLabel,
    restartsHistoricalFixture: candidate.data.restartsHistoricalFixture,
    outpoints: inputOutpoints(tx),
    refs: parseSpentRefs(input.spentFixtureRefs),
  });
  const parties = parseParties(input.parties);
  const funding = assessWalletFundingRequest({
    chain: agreement.chain,
    walletApp: parties.wallet.app,
  });
  return {
    format: "qsb-external-inclusion-plan-v1",
    chain: agreement.chain,
    partiesAgree: true,
    endpointsContacted: false,
    optionalRiskReduction: agreement.optionalRiskReduction,
    mandatoryBitcoinPrerequisite: false,
    xverseTestnet4CompatibilityEstablished: false,
    directMainnetDecisionRequired: agreement.directMainnetDecisionRequired,
    fixtureCreated: false,
    freshCommitmentsCreated: false,
    spentRegtestReused: false,
    askUserToFund: false,
    fundingRefused: funding.refusedBecauseUnsupported,
    globalFreshness: false,
    searchCompleted: false,
    submitted: false,
    included: false,
    section7Closed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    limits: agreement.limits,
  };
}

function seal(permit: BroadcastPermit): BroadcastPermit {
  const frozen = Object.freeze(permit);
  permits.add(frozen);
  return frozen;
}

export function grantExactSpendPermit(input: {
  parties: unknown;
  candidate: unknown;
  exactSpend: unknown;
  spentFixtureRefs: unknown;
  release: { mainnetEnabled?: boolean; broadcastAuthorized?: boolean };
}): BroadcastPermit {
  assertNoCredentialMaterial(input);
  assertReleaseClosed(input.release);
  const agreement = agreeExternalMinerChain(input.parties);
  const candidateParsed = candidateSchema.safeParse(input.candidate);
  if (!candidateParsed.success)
    throw new MinerInclusionError("ExactSpendMismatch");
  const candidate = candidateParsed.data;
  assertCandidateNotRegtest(candidate);
  const tx = readTransaction(candidate.rawTxHex);
  const spend = parseExactSpend(input.exactSpend);
  if (
    candidate.chain !== agreement.chain ||
    spend.chain !== agreement.chain ||
    lower(candidate.txid) !== tx.id ||
    lower(spend.txid) !== tx.id ||
    lower(spend.rawTxSha256) !== rawTransactionSha256(candidate.rawTxHex) ||
    spend.amountSats !== candidate.amountSats ||
    spend.feeSats !== candidate.feeSats
  )
    throw new MinerInclusionError("ExactSpendMismatch");
  switch (agreement.chain) {
    case "mainnet":
      if (spend.directMainnetDecision !== "explicit")
        throw new MinerInclusionError("DirectMainnetDecisionRequired");
      break;
    case "testnet4":
      if (spend.directMainnetDecision !== "not-requested")
        throw new MinerInclusionError("DirectMainnetDecisionRequired");
      if (isXverse(parseParties(input.parties).wallet.app))
        throw new MinerInclusionError("UnsupportedWalletFundingRefused");
      break;
    default: {
      const neverChain: never = agreement.chain;
      throw new MinerInclusionError(`ExternalChainRefused:${String(neverChain)}`);
    }
  }
  assertReusableFixture({
    chain: candidate.chain,
    txid: tx.id,
    fixtureLabel: candidate.fixtureLabel,
    restartsHistoricalFixture: candidate.restartsHistoricalFixture,
    outpoints: inputOutpoints(tx),
    refs: parseSpentRefs(input.spentFixtureRefs),
  });
  return seal({
    format: "qsb-exact-spend-permit-v1",
    chain: agreement.chain,
    minerEndpoint: EXTERNAL_MINER_CATALOG[agreement.chain].minerUrl,
    txid: tx.id,
    rawTxSha256: lower(spend.rawTxSha256),
    amountSats: spend.amountSats,
    feeSats: spend.feeSats,
    transportCalled: false,
    inclusion: false,
    section7Closed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    askUserToFund: false,
    xverseTestnet4CompatibilityEstablished: false,
    optionalRiskReduction: agreement.optionalRiskReduction,
    directMainnetDecision:
      agreement.chain === "mainnet" ? "explicit" : "not-applicable",
    endpointsContacted: false,
  });
}

export function assertBroadcastPermit(
  permit: unknown,
  rawTxHex: string,
): BroadcastPermit {
  if (!permit || typeof permit !== "object" || !permits.has(permit as BroadcastPermit))
    throw new MinerInclusionError("SpendAuthorizationRequired");
  const granted = permit as BroadcastPermit;
  if (
    granted.mainnetEnabled !== false ||
    granted.broadcastAuthorized !== false
  )
    throw new MinerInclusionError("ActivationRefused");
  if (
    granted.inclusion !== false ||
    granted.section7Closed !== false ||
    granted.askUserToFund !== false ||
    granted.transportCalled !== false ||
    rawTransactionSha256(rawTxHex) !== granted.rawTxSha256
  )
    throw new MinerInclusionError("ExactSpendMismatch");
  return granted;
}

function minerHostname(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).hostname;
  } catch {
    return undefined;
  }
}

function targetsMainnetMiner(endpoint: string | undefined): boolean {
  return (
    minerHostname(endpoint) ===
    new URL(EXTERNAL_MINER_CATALOG.mainnet.minerUrl).hostname
  );
}

function targetsLiveMiner(endpoint: string | undefined): boolean {
  const host = minerHostname(endpoint);
  if (!host) return false;
  return (
    host === new URL(EXTERNAL_MINER_CATALOG.mainnet.minerUrl).hostname ||
    host === new URL(EXTERNAL_MINER_CATALOG.testnet4.minerUrl).hostname
  );
}

const LOCAL_MINER_ENDPOINT = "local://miner-double";
const localTransports = new WeakSet<LocalMinerTransport>();
const localDeliveries = new WeakMap<
  LocalMinerTransport,
  { seen: string[]; result: unknown }
>();

export type LocalMinerTransport = {
  readonly format: "qsb-local-miner-transport-v1";
  readonly targetsLiveHost: false;
  readonly endpoint: typeof LOCAL_MINER_ENDPOINT;
};

/** A canned in-process double. It has no host and cannot perform HTTP. */
export function localMinerTransport(result: unknown): LocalMinerTransport {
  const transport: LocalMinerTransport = Object.freeze({
    format: "qsb-local-miner-transport-v1",
    targetsLiveHost: false,
    endpoint: LOCAL_MINER_ENDPOINT,
  });
  localTransports.add(transport);
  localDeliveries.set(transport, { seen: [], result });
  return transport;
}

export function localTransportInvocations(
  transport: LocalMinerTransport,
): readonly string[] {
  const row = localDeliveries.get(transport);
  if (!row) throw new MinerInclusionError("LiveMinerTransportRefused");
  return Object.freeze(row.seen.slice());
}

function assertLocalMinerTransport(value: unknown): LocalMinerTransport {
  // Membership is identity only. Do not read properties first: a Proxy or
  // accessor on an untrusted object can perform I/O from a get or has trap.
  if (
    typeof value !== "object" ||
    value === null ||
    !localTransports.has(value as LocalMinerTransport)
  )
    throw new MinerInclusionError("LiveMinerTransportRefused");
  const transport = value as LocalMinerTransport;
  if (
    transport.format !== "qsb-local-miner-transport-v1" ||
    transport.targetsLiveHost !== false ||
    transport.endpoint !== LOCAL_MINER_ENDPOINT ||
    targetsLiveMiner(transport.endpoint)
  )
    throw new MinerInclusionError("LiveMinerTransportRefused");
  return transport;
}

/** The Slipstream base must be the miner origin recorded on the permit. */
export function assertPermitMinerEndpoint(
  permit: BroadcastPermit,
  endpoint: string,
): void {
  if (endpoint !== permit.minerEndpoint)
    throw new MinerInclusionError("MinerEndpointMismatch");
}

/** This checkout does not invoke a mainnet miner transport. A permit is not activation. */
export function assertMainnetTransportClosed(
  permit: BroadcastPermit,
  endpoint?: string,
): void {
  if (permit.chain === "mainnet" || targetsMainnetMiner(endpoint))
    throw new MinerInclusionError("MainnetTransportRefused");
}

export async function callMinerSubmit(input: {
  permit: unknown;
  rawTxHex: string;
  transport: unknown;
}): Promise<{
  format: "qsb-miner-transport-result-v1";
  transportResult: unknown;
  included: false;
  preflightIsInclusion: false;
  httpSuccessIsInclusion: false;
  section7Closed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
}> {
  const granted = assertBroadcastPermit(input.permit, input.rawTxHex);
  assertMainnetTransportClosed(granted);
  const transport = assertLocalMinerTransport(input.transport);
  const delivery = localDeliveries.get(transport);
  if (!delivery) throw new MinerInclusionError("LiveMinerTransportRefused");
  delivery.seen.push(input.rawTxHex);
  const transportResult = delivery.result;
  return Object.freeze({
    format: "qsb-miner-transport-result-v1",
    transportResult,
    included: false,
    preflightIsInclusion: false,
    httpSuccessIsInclusion: false,
    section7Closed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  });
}

export function authorizeConfiguredSpend(input: {
  chain: ExternalChainId;
  chainBaseUrl: string;
  minerEndpoint: string;
  rawTxHex: string;
  txid: string;
  amountSats: string;
  feeSats: string;
  exactSpend: unknown;
  spentFixtureRefs: unknown;
  release: { mainnetEnabled?: boolean; broadcastAuthorized?: boolean };
  walletApp?: string;
  fixtureLabel?: string;
}): BroadcastPermit {
  return grantExactSpendPermit({
    parties: {
      wallet: { chain: input.chain, app: input.walletApp ?? "xverse" },
      builder: { chain: input.chain },
      chainProvider: {
        chain: input.chain,
        genesisHash: EXTERNAL_MINER_CATALOG[input.chain].genesisHash,
        baseUrl: input.chainBaseUrl,
      },
      miner: { chain: input.chain, endpoint: input.minerEndpoint },
    },
    candidate: {
      chain: input.chain,
      txid: input.txid,
      rawTxHex: input.rawTxHex,
      amountSats: input.amountSats,
      feeSats: input.feeSats,
      ...(input.fixtureLabel ? { fixtureLabel: input.fixtureLabel } : {}),
    },
    exactSpend: input.exactSpend,
    spentFixtureRefs: input.spentFixtureRefs ?? [],
    release: input.release,
  });
}

const inclusionSchema = z
  .object({
    httpStatus: z.number().int().optional(),
    preflightAllowed: z.boolean().optional(),
    mempoolAccepted: z.boolean().optional(),
    minerReportedConfirmed: z.boolean().optional(),
    section7Closed: z.boolean().optional(),
    chain: z
      .object({
        confirmed: z.boolean(),
        confirmations: z.number().int().nonnegative().optional(),
        blockHash: z.string().optional(),
        blockHeight: z.number().int().nonnegative().optional(),
        txid: z.string().optional(),
      })
      .strict()
      .optional(),
    expectedTxid: hash64,
  })
  .strict();

export type InclusionJudgment = {
  format: "qsb-inclusion-judgment-v1";
  independentlyConfirmed: boolean;
  preflightIsInclusion: false;
  httpSuccessIsInclusion: false;
  section7Closed: false;
  observedByThisCheckout: false;
  overclaim: boolean;
  reason: string;
  limits: readonly string[];
};

const INCLUSION_LIMITS = [
  "This helper does not contact a chain provider or miner.",
  "HTTP success, a mempool preflight, and a miner-reported confirmation are not inclusion.",
  "A matching block hash, height, and transaction id do not close section 7 in this checkout.",
] as const;

export function judgeInclusionEvidence(input: unknown): InclusionJudgment {
  assertNoCredentialMaterial(input);
  const parsed = inclusionSchema.safeParse(input);
  if (!parsed.success) throw new MinerInclusionError("InclusionEvidenceRejected");
  const evidence = parsed.data;
  const overclaim = evidence.section7Closed === true;
  const chain = evidence.chain;
  const blockHash = chain?.blockHash?.toLowerCase();
  const txid = chain?.txid?.toLowerCase();
  const blockOk = Boolean(
    chain?.confirmed === true &&
      (chain.confirmations ?? 0) >= 1 &&
      blockHash &&
      /^[a-f0-9]{64}$/.test(blockHash) &&
      chain.blockHeight !== undefined &&
      txid === lower(evidence.expectedTxid),
  );
  let reason: string;
  if (overclaim)
    reason =
      "A report cannot close section 7. This checkout did not observe the chain.";
  else if (blockOk)
    reason =
      "The supplied record has a block hash, block height, and the same transaction id. This judgment does not contact a chain, and it does not close section 7.";
  else if (
    evidence.preflightAllowed === true ||
    evidence.mempoolAccepted === true
  )
    reason = "A mempool preflight is not inclusion.";
  else if (evidence.minerReportedConfirmed === true)
    reason = "A miner-reported confirmation is not independent block inclusion.";
  else if (evidence.httpStatus === 200)
    reason = "HTTP success is not inclusion.";
  else
    reason =
      "Independent inclusion requires a confirmed block hash, block height, and the same transaction id.";
  return {
    format: "qsb-inclusion-judgment-v1",
    independentlyConfirmed: blockOk && !overclaim,
    preflightIsInclusion: false,
    httpSuccessIsInclusion: false,
    section7Closed: false,
    observedByThisCheckout: false,
    overclaim,
    reason,
    limits: INCLUSION_LIMITS,
  };
}
