import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { fundingPsbt } from "../src/lib/transactions";
import { release, type PublicVault } from "../src/lib/model";

const key = new Uint8Array(32).fill(7),
  pub = secp256k1.getPublicKey(key),
  address = btc.p2wpkh(pub).address!,
  script = "51".repeat(100),
  opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const post = (path: string, body: unknown, token?: string) =>
  new Request("http://localhost/api" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (path: string, token: string) =>
  new Request("http://localhost/api" + path, {
    headers: { authorization: "Bearer " + token },
  });
function deposit(scriptHex: string, amount: bigint, inputTxid: string) {
  const previous = new btc.Transaction();
  previous.addInput({ txid: inputTxid, index: 0 });
  previous.addOutputAddress(address, 100000n);
  const previousTxHex = hex.encode(previous.toBytes(true, true));
  const built = fundingPsbt(
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
    scriptHex,
    amount,
    10000n,
    address,
  );
  built.sign(key);
  built.finalize();
  const raw = hex.encode(built.extract());
  const tx = btc.Transaction.fromRaw(hex.decode(raw), opts);
  return { tx, raw, txid: tx.id };
}
function vaultOf(scriptHex: string): PublicVault {
  return {
    id: crypto.randomUUID(),
    name: "Vault",
    createdAt: "2026-09-24T00:00:00.000Z",
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash: createHash("sha256")
      .update(Buffer.from(scriptHex, "hex"))
      .digest("hex"),
    publicStateJson: JSON.stringify({
      config: "A",
      full_script_hex: scriptHex,
    }),
    paymentAddress: address,
    status: "unfunded",
  };
}
async function signIn(app: ReturnType<typeof createApp>) {
  const challenge = await (
    await app.request(post("/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF().encode(key),
    address,
    challenge.message,
  );
  const login = await app.request(
    post("/auth/verify", { id: challenge.id, signature }),
  );
  expect(login.status).toBe(200);
  return (await login.json()).token as string;
}
async function harness(confirmed = true) {
  const store = new MemoryStore(),
    chain = new Esplora(),
    miner = new Slipstream(),
    payment = deposit(script, 50000n, "11".repeat(32)),
    otherScript = deposit("52".repeat(100), 50000n, "33".repeat(32)),
    known = new Map([
      [payment.txid, payment],
      [otherScript.txid, otherScript],
    ]);
  const raw = vi.spyOn(chain, "raw").mockImplementation(async (id) => {
    const found = known.get(id.toLowerCase());
    if (!found) throw new Error("missing " + id);
    return { tx: found.tx, raw: found.raw };
  });
  const status = vi.spyOn(chain, "status").mockResolvedValue(
    confirmed
      ? {
          confirmed: true,
          confirmations: 3,
          blockHash: "22".repeat(32),
          blockHeight: 100,
        }
      : { confirmed: false, confirmations: 0 },
  );
  const submit = vi.spyOn(miner, "submit");
  const probe = vi.spyOn(miner, "test");
  const vault = vaultOf(script);
  await store.put({
    pk: "OWNER#" + address,
    sk: "VAULT#" + vault.id,
    version: 0,
    vault,
  });
  const app = createApp(store, { chain, miner, enabled: true });
  const token = await signIn(app);
  return {
    store,
    app,
    token,
    vault,
    payment,
    otherScript,
    raw,
    status,
    submit,
    probe,
  };
}
async function stored(store: MemoryStore, id: string) {
  return (await store.get("OWNER#" + address, "VAULT#" + id))?.vault as
    | PublicVault
    | undefined;
}
const body = (txid: string, amount = "50000") => ({
  txid,
  amount,
  costAccepted: true as const,
});

it("records vault funding when the confirmed payment matches", async () => {
  const h = await harness();
  const response = await h.app.request(
    post("/vaults/" + h.vault.id + "/fund", body(h.payment.txid), h.token),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    vault: {
      status: "confirmed",
      funding: { txid: h.payment.txid, vout: 0, value: "50000" },
    },
  });
  expect(await stored(h.store, h.vault.id)).toMatchObject({
    status: "confirmed",
    funding: { txid: h.payment.txid, vout: 0, value: "50000" },
  });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.probe).not.toHaveBeenCalled();
  expect(release.mainnetEnabled).toBe(false);
  expect("broadcastAuthorized" in release).toBe(false);
  const version = (await h.store.get("OWNER#" + address, "VAULT#" + h.vault.id))
    ?.version;
  const put = vi.spyOn(h.store, "put");
  const watched = await h.app.request(
    get("/vaults/" + h.vault.id + "/funding", h.token),
  );
  expect(watched.status).toBe(200);
  expect((await watched.json()).vault.status).toBe("confirmed");
  expect(put).not.toHaveBeenCalled();
  expect(
    (await h.store.get("OWNER#" + address, "VAULT#" + h.vault.id))?.version,
  ).toBe(version);
});

it("does not record a payment to the wrong script", async () => {
  const h = await harness();
  const response = await h.app.request(
    post(
      "/vaults/" + h.vault.id + "/fund",
      body(h.otherScript.txid),
      h.token,
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "Funding transaction does not pay this vault.",
  });
  const vault = await stored(h.store, h.vault.id);
  expect(vault?.status).toBe("unfunded");
  expect(vault?.funding).toBeUndefined();
  expect(h.submit).not.toHaveBeenCalled();
});

it("does not record a payment of the wrong amount", async () => {
  const h = await harness();
  const response = await h.app.request(
    post(
      "/vaults/" + h.vault.id + "/fund",
      body(h.payment.txid, "40000"),
      h.token,
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "Funding amount does not match.",
  });
  const vault = await stored(h.store, h.vault.id);
  expect(vault?.status).toBe("unfunded");
  expect(vault?.funding).toBeUndefined();
  expect(h.submit).not.toHaveBeenCalled();
});

it("does not record an unconfirmed transaction", async () => {
  const h = await harness(false);
  const put = vi.spyOn(h.store, "put");
  const response = await h.app.request(
    post("/vaults/" + h.vault.id + "/fund", body(h.payment.txid), h.token),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "Funding transaction is not confirmed.",
  });
  expect(put).not.toHaveBeenCalled();
  const vault = await stored(h.store, h.vault.id);
  expect(vault?.status).toBe("unfunded");
  expect(vault?.funding).toBeUndefined();
  expect(h.submit).not.toHaveBeenCalled();
});

it("refuses a second funding txid", async () => {
  const h = await harness();
  const first = await h.app.request(
    post("/vaults/" + h.vault.id + "/fund", body(h.payment.txid), h.token),
  );
  expect(first.status).toBe(201);
  h.raw.mockClear();
  h.status.mockClear();
  const second = await h.app.request(
    post(
      "/vaults/" + h.vault.id + "/fund",
      body(h.otherScript.txid),
      h.token,
    ),
  );
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({
    error:
      "Vault already has a funding intent. Reconcile that transaction first.",
  });
  expect(h.raw).not.toHaveBeenCalled();
  expect(h.status).not.toHaveBeenCalled();
  expect(await stored(h.store, h.vault.id)).toMatchObject({
    status: "confirmed",
    funding: { txid: h.payment.txid, vout: 0, value: "50000" },
  });
});

it("writes the funding GET when confirmation changes and not when it does not", async () => {
  const h = await harness();
  const vault = vaultOf(script);
  vault.funding = { txid: h.payment.txid, vout: 0, value: "50000" };
  vault.status = "submitted";
  await h.store.put({
    pk: "OWNER#" + address,
    sk: "VAULT#" + vault.id,
    version: 4,
    vault,
  });
  const changed = await h.app.request(
    get("/vaults/" + vault.id + "/funding", h.token),
  );
  expect(changed.status).toBe(200);
  expect((await changed.json()).vault.status).toBe("confirmed");
  expect(
    (await h.store.get("OWNER#" + address, "VAULT#" + vault.id))?.version,
  ).toBe(5);
  const put = vi.spyOn(h.store, "put");
  const same = await h.app.request(
    get("/vaults/" + vault.id + "/funding", h.token),
  );
  expect(same.status).toBe(200);
  expect((await same.json()).vault.status).toBe("confirmed");
  expect(put).not.toHaveBeenCalled();
  expect(
    (await h.store.get("OWNER#" + address, "VAULT#" + vault.id))?.version,
  ).toBe(5);
});

it("does not read the chain while funding is disabled", async () => {
  const store = new MemoryStore(),
    chain = new Esplora(),
    raw = vi.spyOn(chain, "raw"),
    app = createApp(store, { chain });
  const token = await signIn(app);
  const response = await app.request(
    post(
      "/vaults/00000000-0000-4000-8000-000000000001/fund",
      body("ab".repeat(32)),
      token,
    ),
  );
  expect(response.status).toBe(503);
  expect(raw).not.toHaveBeenCalled();
  expect(release.mainnetEnabled).toBe(false);
  expect("broadcastAuthorized" in release).toBe(false);
});
