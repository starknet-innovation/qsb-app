import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QSB_CONFIG_A_MAX_SCRIPTSIG,
  belowMinerFloor,
  fundingFeeForRate,
  fundingVsize,
  nestedPaymentAddress,
  parseFeeRate,
  transactionVsize,
  withdrawalFeeForRate,
  withdrawalVsize,
} from "../src/lib/transactions";

const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const WITNESS_PER_INPUT = 1 + 1 + 72 + 1 + 33; // item count, DER signature (max), compressed key

// The unsigned serialization omits scriptSigs and witnesses. Add the nested scriptSig
// bytes and the worst-case witness, then compare with fundingVsize.
function expectedVsize(inputs: number, nested: boolean, scriptLength: number, change: boolean) {
  const tx = new btc.Transaction({ ...opts, version: 2 });
  const payment = new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]);
  for (let i = 0; i < inputs; i++)
    tx.addInput({
      txid: new Uint8Array(32).fill(i + 1),
      index: 0,
      sequence: 0xfffffffe,
      witnessUtxo: { amount: 100_000n, script: payment },
    });
  tx.addOutput({ amount: 50_000n, script: new Uint8Array(scriptLength).fill(0x51) });
  if (change)
    tx.addOutput({
      amount: 1_000n,
      script: nested
        ? new Uint8Array([0xa9, 0x14, ...new Uint8Array(20), 0x87])
        : payment,
    });
  const base = tx.unsignedTx.length + (nested ? 23 * inputs : 0);
  return Math.ceil((base * 4 + 2 + inputs * WITNESS_PER_INPUT) / 4);
}

describe("fundingVsize", () => {
  for (const nested of [false, true])
    for (const scriptLength of [100, 252, 253, 4_000, 10_000])
      for (const inputs of [1, 2, 8])
        for (const change of [true, false])
          it(`matches the serialized size: ${inputs} ${nested ? "nested" : "native"} input(s), ${scriptLength}-byte script, change=${change}`, () => {
            expect(fundingVsize(inputs, nested, scriptLength, change)).toBe(
              expectedVsize(inputs, nested, scriptLength, change),
            );
          });

  it("counts a nested input's scriptSig in full and a native input's witness at a quarter", () => {
    // One native input with change and a 100-byte script: 191 base bytes, 110 witness bytes.
    expect(fundingVsize(1, false, 100, true)).toBe(Math.ceil((191 * 4 + 110) / 4));
    expect(fundingVsize(1, true, 100, true) - fundingVsize(1, false, 100, true)).toBe(24);
  });

  it("refuses an empty input set", () => {
    expect(() => fundingVsize(0, false, 100, true)).toThrow("Select at least one");
  });
});

describe("parseFeeRate", () => {
  it("parses whole and decimal sat/vB rates into millisatoshis per vB", () => {
    expect(parseFeeRate("2")).toBe(2_000n);
    expect(parseFeeRate(" 1.5 ")).toBe(1_500n);
    expect(parseFeeRate("0.001")).toBe(1n);
    expect(parseFeeRate("1000")).toBe(1_000_000n);
  });
  for (const value of ["", "0", "0.000", "-1", "1e3", "abc", "1.2345", "1000.001", "12345"])
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(() => parseFeeRate(value)).toThrow();
    });
});

describe("fundingFeeForRate", () => {
  const script = 100;
  it("charges rate × vsize, rounded up, and keeps change above dust", () => {
    const vsize = fundingVsize(1, false, script, true);
    const quote = fundingFeeForRate([100_000n], false, script, 50_000n, 1_500n);
    expect(quote).toEqual({ fee: BigInt(Math.ceil(vsize * 1.5)), vsize, change: true });
  });

  it("drops change below 546 sats and adds it to the fee", () => {
    const feeWithChange = BigInt(fundingVsize(1, false, script, true) * 2);
    const amount = 100_000n - feeWithChange - 545n;
    const quote = fundingFeeForRate([100_000n], false, script, amount, 2_000n);
    expect(quote.change).toBe(false);
    expect(quote.fee).toBe(100_000n - amount);
    expect(quote.vsize).toBe(fundingVsize(1, false, script, false));
  });

  it("keeps change at exactly 546 sats", () => {
    const feeWithChange = BigInt(fundingVsize(1, false, script, true) * 2);
    const amount = 100_000n - feeWithChange - 546n;
    expect(fundingFeeForRate([100_000n], false, script, amount, 2_000n).change).toBe(true);
  });

  it("refuses inputs that can't cover the amount and the fee", () => {
    expect(() => fundingFeeForRate([50_100n], false, script, 50_000n, 2_000n)).toThrow("Insufficient funds");
  });

  it("sums several inputs and sizes for all of them", () => {
    const quote = fundingFeeForRate([30_000n, 30_000n, 30_000n], true, 4_000, 50_000n, 1_000n);
    expect(quote.vsize).toBe(fundingVsize(3, true, 4_000, true));
    expect(quote.fee).toBe(BigInt(quote.vsize));
  });
});

describe("nestedPaymentAddress", () => {
  const address = btc.Address(BITCOIN_NETWORK);
  it("tells nested SegWit from native P2WPKH", () => {
    expect(nestedPaymentAddress(address.encode({ type: "sh", hash: new Uint8Array(20) }))).toBe(true);
    expect(nestedPaymentAddress(address.encode({ type: "wpkh", hash: new Uint8Array(20) }))).toBe(false);
  });
  it("refuses other address types", () => {
    expect(() => nestedPaymentAddress(address.encode({ type: "tr", pubkey: new Uint8Array(32).fill(2) }))).toThrow("Only Xverse");
  });
});

describe("withdrawalVsize", () => {
  // Helper input 0 (P2WPKH or nested SegWit) plus the legacy QSB input 1 and one output.
  function expected(nested: boolean, outputScriptLength: number, scriptSigLength: number) {
    const tx = new btc.Transaction({ ...opts, version: 1 });
    const payment = new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]);
    tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0, sequence: 0xfffffffe, witnessUtxo: { amount: 10_000n, script: payment } });
    tx.addInput({ txid: new Uint8Array(32).fill(2), index: 0, sequence: 0xffffffff });
    tx.addOutput({ amount: 50_000n, script: new Uint8Array(outputScriptLength).fill(0x51) });
    // The unsigned serialization has two empty scriptSigs (a 1-byte length each).
    const varint = scriptSigLength < 0xfd ? 1 : 3;
    const base = tx.unsignedTx.length - 1 + varint + scriptSigLength + (nested ? 23 : 0);
    return Math.ceil((base * 4 + 2 + WITNESS_PER_INPUT + 1) / 4);
  }
  for (const nested of [false, true])
    for (const outputScriptLength of [22, 23, 25, 34])
      for (const scriptSigLength of [1_149, QSB_CONFIG_A_MAX_SCRIPTSIG])
        it(`matches the serialized size: ${nested ? "nested" : "native"} helper, ${outputScriptLength}-byte output, ${scriptSigLength}-byte scriptSig`, () => {
          expect(withdrawalVsize(nested, outputScriptLength, scriptSigLength)).toBe(
            expected(nested, outputScriptLength, scriptSigLength),
          );
        });

  it("defaults to the Config A scriptSig upper bound", () => {
    expect(withdrawalVsize(false, 22)).toBe(expected(false, 22, QSB_CONFIG_A_MAX_SCRIPTSIG));
  });

  it("charges rate × the upper-bound size, rounded up", () => {
    const vsize = withdrawalVsize(true, 22);
    expect(withdrawalFeeForRate(true, 22, 1_500n)).toEqual({ fee: BigInt(Math.ceil(vsize * 1.5)), vsize });
  });
});

describe("QSB_CONFIG_A_MAX_SCRIPTSIG", () => {
  // Re-derives the bound from the vendored pipeline, so a change there fails this test.
  const pipeline = readFileSync(resolve(__dirname, "../public/qsb/qsb_pipeline.py"), "utf8");
  const builder = readFileSync(resolve(__dirname, "../public/qsb/bitcoin_tx.py"), "utf8");
  it("matches Config A's round parameters and push sizes", () => {
    const config = /'A':\s*\{'n': (\d+), 't1s': (\d+), 't1b': (\d+), 't2s': (\d+), 't2b': (\d+)/.exec(pipeline);
    expect(config).not.toBeNull();
    const [n, t1s, t1b, t2s, t2b] = config!.slice(1).map(Number);
    expect(n).toBeLessThan(1_000); // index numbers stay 3-byte pushes at most
    const key = 1 + 33, preimage = 1 + 20, index = 3;
    const round = (signed: number, bucket: number) =>
      2 * key + (signed + bucket) * key + signed * preimage + (signed + bucket) * index;
    expect(round(t1s, t1b) + round(t2s, t2b) + 2 * key).toBe(QSB_CONFIG_A_MAX_SCRIPTSIG);
    expect(builder).toContain("secret = os.urandom(20)");
  });
  it("matches the scriptSig layout cmd_assemble builds", () => {
    for (const line of [
      "witness += push_data(rr['key_puzzle'])",
      "witness += push_data(rr['key_nonce'])",
      "for pub in reversed(rr['dummy_pubkeys']):",
      "for pre in reversed(rr['preimages']):",
      "witness += push_number(ivs[j])",
      "witness += push_data(key_puzzle_pin)",
      "witness += push_data(key_nonce_pin)",
      "script_sig = witness",
    ])
      expect(pipeline).toContain(line);
  });
});

describe("transactionVsize", () => {
  it("reads the virtual size of a raw transaction", () => {
    const tx = new btc.Transaction({ ...opts, version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(3), index: 1 });
    tx.addOutput({ amount: 1_000n, script: new Uint8Array(22).fill(0x51) });
    const raw = tx.toBytes(true, false);
    expect(transactionVsize(Buffer.from(raw).toString("hex"))).toBe(raw.length);
  });
});

describe("belowMinerFloor", () => {
  it("compares a rate with MARA's floor, rounding the floor up to a millisatoshi", () => {
    expect(belowMinerFloor(2_000n, 2)).toBe(false);
    expect(belowMinerFloor(1_999n, 2)).toBe(true);
    expect(belowMinerFloor(1_500n, 1.5)).toBe(false);
    expect(belowMinerFloor(1_000n, 1.0001)).toBe(true);
    expect(belowMinerFloor(1n, 0)).toBe(false);
  });
  it("refuses an invalid floor", () => {
    expect(() => belowMinerFloor(1_000n, Number.NaN)).toThrow("Invalid miner fee floor");
    expect(() => belowMinerFloor(1_000n, -1)).toThrow("Invalid miner fee floor");
  });
});
