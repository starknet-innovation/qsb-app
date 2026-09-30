import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { Slipstream } from "../server/providers";
import {
  MinerInclusionError,
  judgeInclusionEvidence,
  reportEsploraInclusion,
  transactionId,
} from "../server/miner-inclusion";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sampleTx() {
  const tx = new btc.Transaction();
  tx.addInput({ txid: "11".repeat(32), index: 1, sequence: 0xfffffffe });
  tx.addOutputAddress(
    btc.p2wpkh(hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).address!,
    50000n,
  );
  return { raw: hex.encode(tx.toBytes(true, true)), txid: tx.id };
}

describe("transactionId", () => {
  it("returns the transaction's id", () => {
    const { raw, txid } = sampleTx();
    expect(transactionId(raw)).toBe(txid);
  });

  it("refuses bytes that aren't a transaction", () => {
    for (const raw of ["", "0", "zz", "00"])
      expect(() => transactionId(raw), raw).toThrow(MinerInclusionError);
  });
});

describe("miner.submit", () => {
  it("refuses without a live exact permit and never contacts the miner", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ status: "success" }));
    vi.stubGlobal("fetch", request);
    const { raw } = sampleTx();
    for (const base of ["https://slipstream.mara.com", "https://teststream.mara.com"]) {
      const miner = new Slipstream(base);
      // A permit is live only when issueExactSubmitPermit made it; a look-alike object isn't.
      for (const permit of [undefined, {}, { rawHash: "00".repeat(32) }])
        await expect(miner.submit(raw, permit)).rejects.toThrow("ExactSubmitPermitRequired");
    }
    expect(request).not.toHaveBeenCalled();
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
      expect(judgment.structurallyComplete).toBe(false);
      expect(judgment.preflightIsInclusion).toBe(false);
      expect(judgment.httpSuccessIsInclusion).toBe(false);
      expect(judgment.section7Closed).toBe(false);
      expect(judgment.observedByThisCheckout).toBe(false);
    }
  });

  it("treats a supplied block record as structural completeness, not confirmation", () => {
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
    expect(judgment.structurallyComplete).toBe(true);
    expect(judgment.independentlyConfirmed).toBe(false);
    expect(judgment.reason).toContain("did not query");
    const observed = reportEsploraInclusion(judgment, true);
    expect(observed.independentlyConfirmed).toBe(true);
    expect(observed.observedByThisCheckout).toBe(true);
    expect(observed.section7Closed).toBe(false);
    expect(observed.reason).toContain("queried Esplora");
    expect(observed.reason).not.toContain("did not query");
    expect(observed.limits.join(" ")).not.toContain("caller-supplied");
    expect(reportEsploraInclusion(judgment, false).independentlyConfirmed).toBe(
      false,
    );
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
