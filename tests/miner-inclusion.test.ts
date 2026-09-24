import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { release } from "../src/lib/model";
import { NETWORK_CONFIG } from "../src/lib/network";
import { testnet4Genesis } from "../server/network";
import { Slipstream } from "../server/providers";
import { HISTORICAL_XVERSE_REGTEST_WITHDRAWAL } from "../server/runtime/fresh-proof";
import {
  EXTERNAL_MINER_CATALOG,
  HISTORICAL_REGTEST_FIXTURE_LABEL,
  REGTEST_ON_TESTNET4_PREFLIGHT,
  XVERSE_TESTNET4_COMPATIBILITY,
  agreeExternalMinerChain,
  assessWalletFundingRequest,
  callMinerSubmit,
  describeExternalInclusion,
  grantExactSpendPermit,
  judgeInclusionEvidence,
  rawTransactionSha256,
  type ExternalChainId,
} from "../server/runtime/miner-inclusion";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleAddress = btc.p2wpkh(
  hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  ),
).address!;

function sampleTx(vout = 1) {
  const tx = new btc.Transaction();
  tx.addInput({ txid: "11".repeat(32), index: vout, sequence: 0xfffffffe });
  tx.addOutputAddress(sampleAddress, 1000n);
  const raw = hex.encode(tx.toBytes(true, true));
  return { raw, txid: tx.id };
}

function parties(
  chain: ExternalChainId,
  app = "xverse",
  overrides: {
    walletChain?: string;
    builderChain?: string;
    providerChain?: string;
    minerChain?: string;
    genesisHash?: string;
    baseUrl?: string;
    endpoint?: string;
  } = {},
) {
  const catalog = EXTERNAL_MINER_CATALOG[chain];
  return {
    wallet: { chain: overrides.walletChain ?? chain, app },
    builder: { chain: overrides.builderChain ?? chain },
    chainProvider: {
      chain: overrides.providerChain ?? chain,
      genesisHash: overrides.genesisHash ?? catalog.genesisHash,
      baseUrl: overrides.baseUrl ?? catalog.chainUrl,
    },
    miner: {
      chain: overrides.minerChain ?? chain,
      endpoint: overrides.endpoint ?? catalog.minerUrl,
    },
  };
}

function spentRef() {
  return {
    label: HISTORICAL_REGTEST_FIXTURE_LABEL,
    chain: "regtest" as const,
    txid: "ff".repeat(32),
    vout: 0,
    spent: true as const,
  };
}

function candidate(
  chain: ExternalChainId,
  raw: string,
  txid: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    chain,
    txid,
    rawTxHex: raw,
    amountSats: "50000",
    feeSats: "1000",
    ...overrides,
  };
}

function exactSpend(
  chain: ExternalChainId,
  raw: string,
  txid: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    format: "qsb-exact-spend-authorization-v1" as const,
    chain,
    txid,
    rawTxSha256: rawTransactionSha256(raw),
    amountSats: "50000",
    feeSats: "1000",
    directMainnetDecision:
      chain === "mainnet" ? ("explicit" as const) : ("not-requested" as const),
    mainnetEnabled: false as const,
    broadcastAuthorized: false as const,
    ...overrides,
  };
}

function grantInput(
  chain: ExternalChainId,
  app = "xverse",
  overrides: {
    raw?: string;
    txid?: string;
    exact?: Record<string, unknown>;
    candidate?: Record<string, unknown>;
    refs?: unknown;
    release?: { mainnetEnabled?: boolean; broadcastAuthorized?: boolean };
    parties?: ReturnType<typeof parties>;
  } = {},
) {
  const sample = sampleTx();
  const raw = overrides.raw ?? sample.raw;
  const txid = overrides.txid ?? sample.txid;
  return {
    parties: overrides.parties ?? parties(chain, app),
    candidate: candidate(chain, raw, txid, overrides.candidate),
    exactSpend: exactSpend(chain, raw, txid, overrides.exact),
    spentFixtureRefs: overrides.refs ?? [spentRef()],
    release: overrides.release ?? { mainnetEnabled: false as const },
  };
}

describe("external chain agreement", () => {
  it("matches the configured catalog and does not contact either endpoint", () => {
    expect(EXTERNAL_MINER_CATALOG.mainnet.chainUrl).toBe(NETWORK_CONFIG.chainUrl);
    expect(EXTERNAL_MINER_CATALOG.mainnet.minerUrl).toBe(NETWORK_CONFIG.minerUrl);
    expect(EXTERNAL_MINER_CATALOG.mainnet.genesisHash).toBe(
      NETWORK_CONFIG.genesisHash,
    );
    expect(EXTERNAL_MINER_CATALOG.testnet4.genesisHash).toBe(testnet4Genesis);
    expect(HISTORICAL_REGTEST_FIXTURE_LABEL).toBe(
      HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mainnet = agreeExternalMinerChain(parties("mainnet"));
    const testnet4 = agreeExternalMinerChain(parties("testnet4", "operator-fixture"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mainnet).toMatchObject({
      chain: "mainnet",
      partiesAgree: true,
      endpointsContacted: false,
      optionalRiskReduction: false,
      directMainnetDecisionRequired: true,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      section7Closed: false,
    });
    expect(testnet4).toMatchObject({
      chain: "testnet4",
      optionalRiskReduction: true,
      mandatoryBitcoinPrerequisite: false,
      xverseTestnet4CompatibilityEstablished: false,
      endpointsContacted: false,
    });
    expect(testnet4.limits.join(" ")).toContain("not a mandatory Bitcoin prerequisite");
    expect(REGTEST_ON_TESTNET4_PREFLIGHT).toMatchObject({
      usefulTest: false,
      repeat: false,
    });
  });

  it("rejects a wallet and miner that name different chains", () => {
    expect(() =>
      agreeExternalMinerChain(
        parties("mainnet", "xverse", { minerChain: "testnet4" }),
      ),
    ).toThrow("ChainAgreementMismatch");
    expect(() =>
      agreeExternalMinerChain(
        parties("mainnet", "xverse", {
          genesisHash: EXTERNAL_MINER_CATALOG.testnet4.genesisHash,
        }),
      ),
    ).toThrow("ChainAgreementMismatch");
    expect(() =>
      agreeExternalMinerChain(
        parties("mainnet", "xverse", {
          endpoint: "http://slipstream.mara.com",
        }),
      ),
    ).toThrow("ChainAgreementMismatch");
  });

  it("refuses a regtest transaction pointed at Testnet4 as a useful preflight", () => {
    expect(() =>
      agreeExternalMinerChain(
        parties("testnet4", "xverse", {
          walletChain: "regtest",
          builderChain: "regtest",
        }),
      ),
    ).toThrow("RegtestOnTestnet4PreflightNotUseful");
    expect(() =>
      agreeExternalMinerChain(parties("mainnet", "xverse", { walletChain: "regtest" })),
    ).toThrow("ExternalChainRefused");
  });
});

describe("spent regtest reuse", () => {
  it("refuses the historical fixture, a regtest candidate, and a spent outpoint", () => {
    const sample = sampleTx(0);
    expect(() =>
      describeExternalInclusion({
        ...grantInput("mainnet"),
        candidate: candidate("mainnet", sample.raw, sample.txid, {
          fixtureLabel: HISTORICAL_REGTEST_FIXTURE_LABEL,
        }),
      }),
    ).toThrow("SpentRegtestReuseRefused");
    expect(() =>
      describeExternalInclusion({
        ...grantInput("mainnet", "xverse", {
          candidate: { chain: "regtest" },
        }),
      }),
    ).toThrow("SpentRegtestReuseRefused");
    expect(() =>
      grantExactSpendPermit(
        grantInput("mainnet", "xverse", {
          refs: [
            {
              chain: "regtest",
              txid: "11".repeat(32),
              vout: 0,
              spent: true,
            },
          ],
          raw: sample.raw,
          txid: sample.txid,
        }),
      ),
    ).toThrow("SpentRegtestReuseRefused");
    expect(() =>
      grantExactSpendPermit(grantInput("mainnet", "xverse", { refs: [] })),
    ).toThrow("InventoryHasNoExclusionPower");
  });

  it("does not create a fixture or claim global freshness for a clean candidate", () => {
    const plan = describeExternalInclusion(grantInput("mainnet"));
    expect(plan).toMatchObject({
      fixtureCreated: false,
      freshCommitmentsCreated: false,
      spentRegtestReused: false,
      globalFreshness: false,
      searchCompleted: false,
      submitted: false,
      included: false,
      section7Closed: false,
      askUserToFund: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
    });
  });
});

describe("authorization before submit", () => {
  it("does not call the transport without a matching exact spend record", async () => {
    const transport = vi.fn();
    const sample = sampleTx();
    await expect(
      callMinerSubmit({
        permit: undefined,
        rawTxHex: sample.raw,
        transport,
      }),
    ).rejects.toThrow("SpendAuthorizationRequired");
    expect(() =>
      grantExactSpendPermit(
        grantInput("mainnet", "xverse", { exact: { feeSats: "1001" } }),
      ),
    ).toThrow("ExactSpendMismatch");
    expect(() =>
      grantExactSpendPermit(
        grantInput("mainnet", "xverse", {
          exact: { directMainnetDecision: "not-requested" },
        }),
      ),
    ).toThrow("DirectMainnetDecisionRequired");
    expect(() =>
      grantExactSpendPermit(
        grantInput("mainnet", "xverse", {
          exact: { mainnetEnabled: true },
        }),
      ),
    ).toThrow("ActivationRefused");
    expect(() =>
      grantExactSpendPermit(
        grantInput("mainnet", "xverse", {
          release: { mainnetEnabled: false, broadcastAuthorized: true },
        }),
      ),
    ).toThrow("ActivationRefused");
    const permit = grantExactSpendPermit(grantInput("mainnet"));
    const clone = { ...permit };
    await expect(
      callMinerSubmit({ permit: clone, rawTxHex: sample.raw, transport }),
    ).rejects.toThrow("SpendAuthorizationRequired");
    const other = sampleTx(3);
    await expect(
      callMinerSubmit({ permit, rawTxHex: other.raw, transport }),
    ).rejects.toThrow("ExactSpendMismatch");
    expect(transport).not.toHaveBeenCalled();
    expect(permit).toMatchObject({
      mainnetEnabled: false,
      broadcastAuthorized: false,
      inclusion: false,
      section7Closed: false,
      askUserToFund: false,
    });
    expect(release.mainnetEnabled).toBe(false);
    expect("broadcastAuthorized" in release).toBe(false);
  });

  it("does not invoke a mainnet transport from a permit minted while release broadcast is disabled", async () => {
    const sample = sampleTx();
    const permit = grantExactSpendPermit(grantInput("mainnet"));
    const transport = vi.fn().mockResolvedValue({ httpStatus: 200, status: "success" });
    await expect(
      callMinerSubmit({ permit, rawTxHex: sample.raw, transport }),
    ).rejects.toThrow("MainnetTransportRefused");
    expect(transport).not.toHaveBeenCalled();
    expect(permit.mainnetEnabled).toBe(false);
    expect(permit.broadcastAuthorized).toBe(false);
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      new Slipstream("https://slipstream.mara.com").submit(sample.raw, permit),
    ).rejects.toThrow("MainnetTransportRefused");
    expect(request).not.toHaveBeenCalled();
    const rehearsal = grantExactSpendPermit(
      grantInput("testnet4", "operator-fixture", {
        raw: sample.raw,
        txid: sample.txid,
      }),
    );
    request.mockClear();
    await expect(
      new Slipstream("https://slipstream.mara.com/").submit(sample.raw, rehearsal),
    ).rejects.toThrow("MainnetTransportRefused");
    expect(request).not.toHaveBeenCalled();
  });

  it("calls a test double only after a non-mainnet record matches, and that result is not inclusion", async () => {
    const sample = sampleTx();
    const permit = grantExactSpendPermit(
      grantInput("testnet4", "operator-fixture", {
        raw: sample.raw,
        txid: sample.txid,
      }),
    );
    const transport = vi.fn().mockResolvedValue({ httpStatus: 200, status: "success" });
    const sent = await callMinerSubmit({
      permit,
      rawTxHex: sample.raw,
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(sample.raw);
    expect(sent.included).toBe(false);
    expect(sent.httpSuccessIsInclusion).toBe(false);
    expect(sent.section7Closed).toBe(false);
    expect(sent.mainnetEnabled).toBe(false);
    expect(sent.broadcastAuthorized).toBe(false);
  });

  it("does not contact Teststream submit until a permit exists", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ chain: "main" }));
    vi.stubGlobal("fetch", request);
    const miner = new Slipstream("https://teststream.mara.com");
    await expect(miner.submit("00", undefined)).rejects.toThrow(
      "SpendAuthorizationRequired",
    );
    expect(request).not.toHaveBeenCalled();
    const sample = sampleTx();
    const permit = grantExactSpendPermit(
      grantInput("testnet4", "operator-fixture", {
        raw: sample.raw,
        txid: sample.txid,
      }),
    );
    await expect(miner.submit(sample.raw, permit)).rejects.toThrow(
      "not serving Bitcoin testnet4",
    );
    expect(request.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://teststream.mara.com/api/system",
    ]);
    expect(permit.xverseTestnet4CompatibilityEstablished).toBe(false);
    expect(permit.askUserToFund).toBe(false);
  });
});

describe("preflight is not inclusion", () => {
  const txid = "aa".repeat(32);

  it("rejects HTTP 200, mempool preflight, and a miner-reported confirmation", () => {
    for (const evidence of [
      { httpStatus: 200, expectedTxid: txid },
      { preflightAllowed: true, mempoolAccepted: true, expectedTxid: txid },
      { minerReportedConfirmed: true, httpStatus: 200, expectedTxid: txid },
      {
        expectedTxid: txid,
        chain: {
          confirmed: true,
          confirmations: 2,
          blockHash: "bb".repeat(32),
          txid,
        },
      },
    ]) {
      const judgment = judgeInclusionEvidence(evidence);
      expect(judgment.independentlyConfirmed).toBe(false);
      expect(judgment.preflightIsInclusion).toBe(false);
      expect(judgment.httpSuccessIsInclusion).toBe(false);
      expect(judgment.section7Closed).toBe(false);
      expect(judgment.observedByThisCheckout).toBe(false);
    }
  });

  it("accepts supplied block and transaction evidence without closing section 7", () => {
    const judgment = judgeInclusionEvidence({
      httpStatus: 200,
      preflightAllowed: true,
      minerReportedConfirmed: true,
      expectedTxid: txid,
      chain: {
        confirmed: true,
        confirmations: 1,
        blockHash: "bb".repeat(32),
        blockHeight: 250000,
        txid,
      },
    });
    expect(judgment.independentlyConfirmed).toBe(true);
    expect(judgment.preflightIsInclusion).toBe(false);
    expect(judgment.section7Closed).toBe(false);
    expect(judgment.observedByThisCheckout).toBe(false);
    const overclaim = judgeInclusionEvidence({
      section7Closed: true,
      expectedTxid: txid,
      chain: {
        confirmed: true,
        confirmations: 1,
        blockHash: "bb".repeat(32),
        blockHeight: 250000,
        txid,
      },
    });
    expect(overclaim.overclaim).toBe(true);
    expect(overclaim.independentlyConfirmed).toBe(false);
    expect(overclaim.section7Closed).toBe(false);
  });
});

describe("Testnet4 wallet funding", () => {
  it("does not ask the user to fund Xverse on Testnet4", () => {
    const funding = assessWalletFundingRequest({
      chain: "testnet4",
      walletApp: "Xverse",
    });
    expect(funding.askUserToFund).toBe(false);
    expect(funding.funded).toBe(false);
    expect(funding.refusedBecauseUnsupported).toBe(true);
    expect(funding.xverseTestnet4CompatibilityEstablished).toBe(false);
    expect(funding.reason).toBe(XVERSE_TESTNET4_COMPATIBILITY);
    expect(() =>
      assessWalletFundingRequest({
        chain: "testnet4",
        walletApp: "xverse",
        xverseTestnet4CompatibilityEstablished: true,
      }),
    ).toThrow("XverseTestnet4CompatibilityNotEstablished");
    const plan = describeExternalInclusion(
      grantInput("testnet4", "xverse"),
    );
    expect(plan.fundingRefused).toBe(true);
    expect(plan.askUserToFund).toBe(false);
    expect(plan.optionalRiskReduction).toBe(true);
    expect(plan.mandatoryBitcoinPrerequisite).toBe(false);
    expect(plan.xverseTestnet4CompatibilityEstablished).toBe(false);
    const transport = vi.fn();
    expect(() => grantExactSpendPermit(grantInput("testnet4", "xverse"))).toThrow(
      "UnsupportedWalletFundingRefused",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
