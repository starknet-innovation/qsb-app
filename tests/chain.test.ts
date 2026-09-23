import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Esplora } from "../server/chain";
import { MemoryStore } from "../server/store";
import { checkFunding } from "../server/transaction-checks";
import { fundingPsbt } from "../src/lib/transactions";
import type { PublicVault } from "../src/lib/model";

const key = new Uint8Array(32).fill(9),
  pub = secp256k1.getPublicKey(key),
  payment = btc.p2wpkh(pub);
function fixture(mode: "ok" | "spent" | "reorg" | "wrong-raw" = "ok") {
  const prev = new btc.Transaction();
  prev.addInput({ txid: "11".repeat(32), index: 0 });
  prev.addOutputAddress(payment.address!, 100000n);
  const raw = hex.encode(prev.toBytes(true, true)),
    block = "22".repeat(32);
  const chain = new Esplora("https://example.invalid", async (url: any) => {
    const p = new URL(String(url)).pathname;
    let data: any;
    if (p === "/block-height/0")
      return new Response("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f");
    if (p.endsWith("/hex"))
      return new Response(
        mode === "wrong-raw" ? raw.replace("0100000000", "0200000000") : raw,
      );
    if (p.endsWith("/status"))
      data = { confirmed: true, block_height: 100, block_hash: block };
    else if (p.includes("/outspend/")) data = { spent: mode === "spent" };
    else if (p.includes("/block-height/"))
      return new Response(mode === "reorg" ? "33".repeat(32) : block);
    else if (p.endsWith("/tip/height")) return new Response("102");
    else throw Error("Unexpected URL " + p);
    return Response.json(data);
  });
  return {
    chain,
    prev,
    raw,
    point: { txid: prev.id, vout: 0, value: "100000" },
  };
}
describe("chain checks and reservations", () => {
  it("requires the exact previous output, unspent status and canonical confirmation block", async () => {
    const f = fixture();
    expect(
      (await f.chain.unspent(f.point, hex.encode(payment.script)))
        .confirmations,
    ).toBe(3);
    await expect(
      f.chain.unspent(
        { ...f.point, value: "99999" },
        hex.encode(payment.script),
      ),
    ).rejects.toThrow("amount or script");
    const spent = fixture("spent");
    await expect(
      spent.chain.unspent(spent.point, hex.encode(payment.script)),
    ).rejects.toThrow("already been spent");
    const reorg = fixture("reorg");
    await expect(
      reorg.chain.unspent(reorg.point, hex.encode(payment.script)),
    ).rejects.toThrow("reorganized");
  });
  it("accepts exact signed funding intent and rejects a changed fee or vault script", async () => {
    const f = fixture();
    const vault = {
      scriptHex: "51".repeat(100),
      paymentAddress: payment.address!,
    } as PublicVault;
    const tx = fundingPsbt(
      [
        {
          ...f.point,
          value: 100000n,
          previousTxHex: f.raw,
          publicKey: hex.encode(pub),
          address: payment.address!,
        },
      ],
      vault.scriptHex,
      50000n,
      10000n,
      payment.address!,
    );
    tx.sign(key);
    tx.finalize();
    const raw = hex.encode(tx.extract());
    expect(await checkFunding(raw, vault, 50000n, 10000n, f.chain)).toEqual({
      txid: tx.id,
      vout: 0,
      value: "50000",
    });
    await expect(
      checkFunding(raw, vault, 50000n, 11000n, f.chain),
    ).rejects.toThrow("approved intent");
    await expect(
      checkFunding(
        raw,
        { ...vault, scriptHex: "52".repeat(100) },
        50000n,
        10000n,
        f.chain,
      ),
    ).rejects.toThrow("approved intent");
  });
  it("reserves both inputs and job atomically; a racing job leaves no partial rows", async () => {
    const store = new MemoryStore();
    await store.atomicPut([
      {
        row: {
          pk: "OUTPOINT#helper",
          sk: "RESERVATION",
          version: 0,
          job: "first",
        },
      },
    ]);
    await expect(
      store.atomicPut([
        { row: { pk: "OWNER#user", sk: "JOB#second", version: 0 } },
        { row: { pk: "OUTPOINT#funding", sk: "RESERVATION", version: 0 } },
        { row: { pk: "OUTPOINT#helper", sk: "RESERVATION", version: 0 } },
      ]),
    ).rejects.toThrow("reserved");
    expect(await store.get("OWNER#user", "JOB#second")).toBeUndefined();
    expect(await store.get("OUTPOINT#funding", "RESERVATION")).toBeUndefined();
    expect((await store.get("OUTPOINT#helper", "RESERVATION"))?.job).toBe(
      "first",
    );
  });
});
