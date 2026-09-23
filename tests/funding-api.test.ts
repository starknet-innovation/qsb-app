import { createHash } from "node:crypto";
import { it, expect, vi } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { fundingPsbt } from "../src/lib/transactions";
import type { PublicVault } from "../src/lib/model";
const key = new Uint8Array(32).fill(7),
  pub = secp256k1.getPublicKey(key),
  address = btc.p2wpkh(pub).address!;
const req = (path: string, body: unknown, token?: string) =>
  new Request("http://localhost/api" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
async function setup(reject = false) {
  const store = new MemoryStore(),
    miner = new Slipstream(),
    chain = new Esplora();
  const previous = new btc.Transaction();
  previous.addInput({ txid: "11".repeat(32), index: 0 });
  previous.addOutputAddress(address, 100000n);
  const previousTxHex = hex.encode(previous.toBytes(true, true));
  vi.spyOn(chain, "raw").mockResolvedValue({
    tx: previous,
    raw: previousTxHex,
  });
  vi.spyOn(chain, "unspent").mockResolvedValue({
    previousTxHex,
    confirmations: 2,
  });
  const vault = {
    id: crypto.randomUUID(),
    scriptHex: "51".repeat(100),
    config: "A",
    publicStateJson: JSON.stringify({
      config: "A",
      full_script_hex: "51".repeat(100),
    }),
    scriptHash: createHash("sha256")
      .update(Buffer.from("51".repeat(100), "hex"))
      .digest("hex"),
    paymentAddress: address,
    status: "unfunded",
  } as PublicVault;
  await store.put({
    pk: "OWNER#" + address,
    sk: "VAULT#" + vault.id,
    version: 0,
    vault,
  });
  const tx = fundingPsbt(
    [
      {
        txid: previous.id,
        vout: 0,
        value: 100000n,
        previousTxHex,
        publicKey: hex.encode(pub),
        address,
      },
    ],
    vault.scriptHex,
    50000n,
    10000n,
    address,
  );
  tx.sign(key);
  tx.finalize();
  const test = vi.spyOn(miner, "test").mockResolvedValue([
    {
      txid: tx.id,
      allowed: !reject,
      "reject-reason": reject ? "nonstandard" : undefined,
    },
  ]);
  const submit = vi.spyOn(miner, "submit").mockImplementation(async () => {
    const row = await store.get("OWNER#" + address, "TX#" + tx.id);
    expect(row?.status).toBe("submitting");
    expect(row?.rawTxHex).toBe(hex.encode(tx.extract()));
    throw Error("Lost HTTP response");
  });
  const app = createApp(store, { chain, miner, enabled: true });
  const c = await (
    await app.request(req("/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(btc.WIF().encode(key), address, c.message);
  const { token } = await (
    await app.request(req("/auth/verify", { id: c.id, signature }))
  ).json();
  return {
    store,
    app,
    vault,
    tx,
    token,
    submit,
    test,
    body: {
      rawTxHex: hex.encode(tx.extract()),
      amount: "50000",
      fee: "10000",
      costAccepted: true,
    },
  };
}
it("saves signed intent before submission and never blindly repeats an uncertain broadcast", async () => {
  const f = await setup();
  const path = "/vaults/" + f.vault.id + "/fund";
  const response = await f.app.request(req(path, f.body, f.token));
  expect(response.status).toBe(202);
  expect((await response.json()).submission).toEqual({
    txid: f.tx.id,
    status: "uncertain",
  });
  expect((await f.app.request(req(path, f.body, f.token))).status).toBe(409);
  expect(f.submit).toHaveBeenCalledTimes(1);
});
it("miner rejection leaves no funding intent and never broadcasts", async () => {
  const f = await setup(true);
  expect(
    (
      await f.app.request(
        req("/vaults/" + f.vault.id + "/fund", f.body, f.token),
      )
    ).status,
  ).toBe(409);
  expect(f.submit).not.toHaveBeenCalled();
  expect(
    await f.store.get("OWNER#" + address, "TX#" + f.tx.id),
  ).toBeUndefined();
  expect(
    (await f.store.get("OWNER#" + address, "VAULT#" + f.vault.id))?.vault,
  ).toMatchObject({ status: "unfunded" });
});
