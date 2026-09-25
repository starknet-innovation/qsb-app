import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Esplora } from "../server/chain";
import { NETWORK_CONFIG } from "../src/lib/network";
import type { Withdrawal } from "../src/lib/model";

const destination = btc.p2wpkh(
  secp256k1.getPublicKey(new Uint8Array(32).fill(9)),
);
const manifest: Withdrawal = {
  vaultId: "00000000-0000-4000-8000-000000000001",
  funding: { txid: "11".repeat(32), vout: 3, value: "50000" },
  helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
  destination: destination.address!,
  outputScript: hex.encode(destination.script),
  outputValue: "59000",
  fee: "1000",
  idempotencyKey: "00000000-0000-4000-8000-000000000002",
  costAccepted: true,
};
function transaction(
  options: {
    scriptSig?: string;
    amount?: bigint;
    extraOutput?: boolean;
    wrongInput?: boolean;
    wrongScript?: boolean;
  } = {},
) {
  const tx = new btc.Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  tx.addInput({
    txid: options.wrongInput ? "33".repeat(32) : manifest.helper.txid,
    index: 1,
  });
  tx.addInput({ txid: manifest.funding.txid, index: 3 });
  tx.addOutput({
    script: options.wrongScript ? new Uint8Array([0x51]) : destination.script,
    amount: options.amount ?? 59000n,
  });
  if (options.extraOutput)
    tx.addOutput({ script: destination.script, amount: 1n });
  tx.updateInput(1, {
    finalScriptSig: hex.decode(options.scriptSig ?? "0151"),
  });
  return { id: tx.id, raw: hex.encode(tx.toBytes(true, true)) };
}
function fixture(
  options: Parameters<typeof transaction>[0] & {
    spent?: boolean;
    confirmed?: boolean;
    reorg?: boolean;
    wrongVin?: boolean;
    rawMismatch?: boolean;
    unavailable?: boolean;
  } = {},
) {
  const spender = transaction(options),
    calls: string[] = [];
  const block = "44".repeat(32);
  const chain = new Esplora("https://example.invalid", async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/block-height/0")
      return new Response(NETWORK_CONFIG.genesisHash);
    if (options.unavailable)
      return new Response("unavailable", { status: 503 });
    if (path === `/tx/${manifest.funding.txid}/outspend/3`)
      return Response.json(
        options.spent === false
          ? { spent: false }
          : {
              spent: true,
              txid: spender.id,
              vin: options.wrongVin ? 0 : 1,
              status: { confirmed: true },
            },
      );
    if (path === `/tx/${spender.id}/hex`)
      return new Response(
        options.rawMismatch ? transaction({ amount: 2n }).raw : spender.raw,
      );
    if (path === `/tx/${spender.id}/status`)
      return Response.json(
        options.confirmed === false
          ? { confirmed: false }
          : { confirmed: true, block_height: 100, block_hash: block },
      );
    if (path === "/block-height/100")
      return new Response(options.reorg ? "55".repeat(32) : block);
    if (path === "/blocks/tip/height") return new Response("102");
    throw Error(`Unexpected path ${path}`);
  });
  return { chain, spender, calls };
}
describe("withdrawal inclusion by funding outpoint", () => {
  it("recognizes a changed legacy scriptSig txid only after matching inputs, output and canonical confirmation", async () => {
    const original = transaction();
    const f = fixture({ scriptSig: "4c0151" });
    expect(f.spender.id).not.toBe(original.id);
    expect(await f.chain.withdrawalInclusion(manifest)).toMatchObject({
      txid: f.spender.id,
      confirmed: true,
      confirmations: 3,
      blockHeight: 100,
      outpointMatched: true,
      outputMatched: true,
    });
    expect(f.calls).not.toContain(`/tx/${original.id}/status`);
  });
  it("does not equate an unspent outpoint, mempool spender, or reorganized block with inclusion", async () => {
    for (const options of [
      { spent: false },
      { confirmed: false },
      { reorg: true },
    ]) {
      expect(
        await fixture(options).chain.withdrawalInclusion(manifest),
      ).toMatchObject({ confirmed: false, confirmations: 0 });
    }
    expect(
      await fixture({ spent: false }).chain.withdrawalInclusion(manifest),
    ).not.toHaveProperty("txid");
  });
  it.each([
    { amount: 58999n },
    { wrongScript: true },
    { extraOutput: true },
    { wrongInput: true },
    { wrongVin: true },
    { rawMismatch: true },
  ])("rejects an unrelated or modified spender case %#", async (options) => {
    await expect(
      fixture(options).chain.withdrawalInclusion(manifest),
    ).rejects.toThrow();
  });
  it("rejects changed manifest fee/value bindings and unavailable evidence", async () => {
    await expect(
      fixture().chain.withdrawalInclusion({ ...manifest, fee: "999" }),
    ).rejects.toThrow("output mismatch");
    await expect(
      fixture().chain.withdrawalInclusion({
        ...manifest,
        funding: { ...manifest.funding, value: "50001" },
      }),
    ).rejects.toThrow("output mismatch");
    await expect(
      fixture({ unavailable: true }).chain.withdrawalInclusion(manifest),
    ).rejects.toThrow("Chain lookup failed");
  });
});
