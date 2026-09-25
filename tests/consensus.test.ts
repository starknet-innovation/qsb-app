import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { CoreConsensus } from "../server/consensus";
import { Esplora } from "../server/chain";

function fixture(taproot: boolean | "legacy") {
  // Public, synthetic test key and nonexistent funding only. Never broadcast.
  const key = new Uint8Array(32).fill(7),
    pub = secp256k1.getPublicKey(key);
  const payment = taproot === true ? btc.p2tr(pub.slice(1)) : btc.p2wpkh(pub);
  const vault = taproot === "legacy" ? btc.p2sh(btc.p2pk(pub)) : payment;
  const previous = new btc.Transaction();
  previous.addInput({ txid: "11".repeat(32), index: 0 });
  previous.addOutput({ script: payment.script, amount: 100000n });
  previous.addOutput({ script: vault.script, amount: 200000n });
  const tx = new btc.Transaction();
  for (let i = 0; i < 2; i++)
    tx.addInput({
      txid: previous.id,
      index: i,
      witnessUtxo: {
        script: i ? vault.script : payment.script,
        amount: i ? 200000n : 100000n,
      },
      ...(taproot === true ? { tapInternalKey: pub.slice(1) } : {}),
      ...(taproot === "legacy" && i === 1
        ? {
            nonWitnessUtxo: previous.toBytes(true, true),
            redeemScript: btc.p2pk(pub).script,
          }
        : {}),
    });
  tx.addOutput({ script: btc.p2wpkh(pub).script, amount: 290000n });
  tx.sign(key);
  tx.finalize();
  const chain = new Esplora();
  vi.spyOn(chain, "raw").mockResolvedValue({
    tx: previous,
    raw: hex.encode(previous.toBytes(true, true)),
  });
  vi.spyOn(chain, "unspent").mockResolvedValue({
    previousTxHex: hex.encode(previous.toBytes(true, true)),
    confirmations: 2,
  });
  return { tx, chain, previous };
}
it("fails closed when native verifier is unavailable", async () => {
  const { tx, chain } = fixture(false);
  await expect(
    new CoreConsensus("/nonexistent/qsb-consensus").verify(
      hex.encode(tx.extract()),
      chain,
    ),
  ).rejects.toThrow("consensus");
});
it("rejects unconfirmed/spent chain outputs before native invocation", async () => {
  const { tx, chain } = fixture(false);
  vi.mocked(chain.unspent).mockRejectedValue(Error("spent"));
  await expect(
    new CoreConsensus().verify(hex.encode(tx.extract()), chain),
  ).rejects.toThrow("consensus");
});
it("starts both previous-output reads together while preserving ordered input verification", async () => {
  const { tx, chain, previous } = fixture(false);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(chain.raw).mockImplementation(async () => {
    await barrier;
    return { tx: previous, raw: hex.encode(previous.toBytes(true, true)) };
  });
  const result = new CoreConsensus("/nonexistent/qsb-consensus").verify(
    hex.encode(tx.extract()),
    chain,
  );
  const rejected = expect(result).rejects.toThrow("consensus");
  expect(chain.raw).toHaveBeenCalledTimes(2);
  expect(chain.unspent).not.toHaveBeenCalled();
  release();
  await rejected;
  expect(
    vi.mocked(chain.unspent).mock.calls.map((call) => call[0].vout),
  ).toEqual([0, 1]);
});
// Fake executable only observes that contextual guards precede interpreter launch.
// These tests do not claim cryptographic verification.
it("rejects money-range and immature coinbase inputs before interpreter launch", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qsb-consensus-guards-"));
  const executable = path.join(dir, "fake"),
    marker = path.join(dir, "invoked");
  writeFileSync(
    executable,
    "#!/bin/sh\ncat >/dev/null\ntouch '" +
      marker +
      "'\nprintf 'core-27.2-api2-all-inputs-valid\\n'\n",
    { mode: 0o700 },
  );
  try {
    const verifier = new CoreConsensus(executable);
    for (const kind of [
      "output-max",
      "output-total",
      "input-max",
      "input-total",
      "overspend",
      "coinbase-99",
    ]) {
      const { tx, chain, previous } = fixture(false);
      const decoded = btc.RawTx.decode(tx.extract());
      if (kind === "output-max") decoded.outputs[0].amount = 2100000000000001n;
      if (kind === "output-total")
        decoded.outputs = [
          { amount: 2100000000000000n, script: new Uint8Array([0x51]) },
          { amount: 1n, script: new Uint8Array([0x51]) },
        ];
      if (kind === "overspend") decoded.outputs[0].amount = 300001n;
      if (kind === "input-max")
        previous.updateOutput(0, { amount: 2100000000000001n });
      if (kind === "input-total")
        previous.updateOutput(0, { amount: 2100000000000000n });
      if (kind === "coinbase-99") {
        previous.updateInput(0, { txid: "00".repeat(32), index: 0xffffffff });
        vi.mocked(chain.unspent).mockResolvedValue({
          previousTxHex: "",
          confirmations: 99,
        });
      }
      await expect(
        verifier.verify(hex.encode(btc.RawTx.encode(decoded)), chain),
      ).rejects.toThrow("consensus");
      expect(existsSync(marker)).toBe(false);
    }
    const { tx, chain, previous } = fixture(false);
    previous.updateInput(0, { txid: "00".repeat(32), index: 0xffffffff });
    vi.mocked(chain.unspent).mockResolvedValue({
      previousTxHex: "",
      confirmations: 100,
    });
    await verifier.verify(hex.encode(tx.extract()), chain);
    expect(existsSync(marker)).toBe(true); // mature boundary reaches fake interpreter
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// Opt-in real native gate. The ordinary unit suite never pretends a mock is Core.
const native = process.env.QSB_TEST_CONSENSUS_BINARY;
describe.skipIf(!native)("real Core script interpreter", () => {
  for (const taproot of [false, true, "legacy"] as const)
    it(`${taproot === "legacy" ? "SegWit plus legacy P2SH" : taproot ? "Taproot" : "SegWit"} accepts signed original and rejects output/amount/fee/add-output mutations`, async () => {
      const { tx, chain, previous } = fixture(taproot),
        verifier = new CoreConsensus(native);
      const raw = hex.encode(tx.extract());
      await verifier.verify(raw, chain);
      expect(chain.unspent).toHaveBeenCalledTimes(2);
      if (taproot === "legacy")
        expect(
          btc.RawTx.decode(hex.decode(raw)).inputs[1].finalScriptSig.length,
        ).toBeGreaterThan(0);
      for (const mode of [
        "destination",
        "amount",
        "fee",
        "extra-output",
        "signature",
      ]) {
        const decoded = btc.RawTx.decode(hex.decode(raw));
        if (mode === "destination")
          decoded.outputs[0].script = btc.p2wpkh(
            secp256k1.getPublicKey(new Uint8Array(32).fill(8)),
          ).script;
        if (mode === "amount") decoded.outputs[0].amount += 1n;
        if (mode === "fee") decoded.outputs[0].amount -= 1n;
        if (mode === "extra-output")
          decoded.outputs.push({ amount: 0n, script: new Uint8Array([0x51]) });
        if (mode === "signature") decoded.witnesses![0][0][10] ^= 1;
        await expect(
          verifier.verify(hex.encode(btc.RawTx.encode(decoded)), chain),
        ).rejects.toThrow("consensus");
      }
      for (const kind of ["amount", "script"]) {
        const changed = btc.Transaction.fromRaw(previous.toBytes(true, true));
        changed.updateOutput(
          0,
          kind === "amount"
            ? { amount: 100001n }
            : {
                script: btc.p2wpkh(
                  secp256k1.getPublicKey(new Uint8Array(32).fill(8)),
                ).script,
              },
        );
        vi.mocked(chain.raw).mockResolvedValue({
          tx: changed,
          raw: hex.encode(changed.toBytes(true, true)),
        });
        await expect(verifier.verify(raw, chain)).rejects.toThrow("consensus");
      }
    });
  it("binds the amount and script of a non-signing other input in Taproot sighash", async () => {
    const key = new Uint8Array(32).fill(7),
      pub = secp256k1.getPublicKey(key);
    const payment = btc.p2tr(pub.slice(1));
    const previous = new btc.Transaction({ allowUnknownOutputs: true });
    previous.addInput({ txid: "22".repeat(32), index: 0 });
    previous.addOutput({ amount: 100000n, script: payment.script });
    // Consensus-valid anyone-can-spend synthetic output, deliberately no signature.
    previous.addOutput({ amount: 200000n, script: new Uint8Array([0x51]) });
    const tx = new btc.Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    tx.addInput({
      txid: previous.id,
      index: 0,
      witnessUtxo: { script: payment.script, amount: 100000n },
      tapInternalKey: pub.slice(1),
    });
    tx.addInput({
      txid: previous.id,
      index: 1,
      witnessUtxo: { script: new Uint8Array([0x51]), amount: 200000n },
    });
    tx.addOutput({ amount: 290000n, script: btc.p2wpkh(pub).script });
    tx.signIdx(key, 0);
    tx.finalizeIdx(0);
    tx.updateInput(1, { finalScriptSig: new Uint8Array([0]) });
    const raw = hex.encode(tx.extract());
    const chain = new Esplora();
    vi.spyOn(chain, "raw").mockResolvedValue({
      tx: previous,
      raw: hex.encode(previous.toBytes(true, true)),
    });
    vi.spyOn(chain, "unspent").mockResolvedValue({
      previousTxHex: hex.encode(previous.toBytes(true, true)),
      confirmations: 2,
    });
    const verifier = new CoreConsensus(native);
    await verifier.verify(raw, chain);
    for (const mutation of ["amount", "script"]) {
      const changed = btc.Transaction.fromRaw(previous.toBytes(true, true), {
        allowUnknownOutputs: true,
      });
      changed.updateOutput(
        1,
        mutation === "amount"
          ? { amount: 200001n }
          : { script: new Uint8Array([0x51, 0x51]) },
      );
      vi.mocked(chain.raw).mockResolvedValue({
        tx: changed,
        raw: hex.encode(changed.toBytes(true, true)),
      });
      // Both alternate scripts still succeed independently; only input 0's Taproot
      // signature's commitment to the other spent output can reject this change.
      await expect(verifier.verify(raw, chain)).rejects.toThrow("consensus");
    }
  });
});
