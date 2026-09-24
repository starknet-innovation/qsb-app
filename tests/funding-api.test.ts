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
import { release, type PublicVault } from "../src/lib/model";
import { rawTransactionSha256 } from "../server/runtime/miner-inclusion";
import { HISTORICAL_XVERSE_REGTEST_WITHDRAWAL } from "../server/runtime/fresh-proof";
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
  const raw = vi.spyOn(chain, "raw").mockResolvedValue({
    tx: previous,
    raw: previousTxHex,
  });
  const unspent = vi.spyOn(chain, "unspent").mockResolvedValue({
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
    network: "mainnet",
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
  const rawTxHex = hex.encode(tx.extract());
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
    expect(row?.rawTxHex).toBe(rawTxHex);
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
    raw,
    unspent,
    body: {
      rawTxHex,
      amount: "50000",
      fee: "10000",
      costAccepted: true as const,
      spentFixtureRefs: [
        {
          label: HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label,
          chain: "regtest" as const,
          txid: "ff".repeat(32),
          vout: 0,
          spent: true as const,
        },
      ],
    },
  };
}
it("rejects a requester-supplied exact spend and does not fund", async () => {
  const f = await setup();
  const path = "/vaults/" + f.vault.id + "/fund";
  const response = await f.app.request(
    req(
      path,
      {
        ...f.body,
        exactSpend: {
          format: "qsb-exact-spend-authorization-v1",
          chain: "mainnet",
          txid: f.tx.id,
          rawTxSha256: rawTransactionSha256(f.body.rawTxHex),
          amountSats: "50000",
          feeSats: "10000",
          inputs: [{ txid: "ab".repeat(32), vout: 0, valueSats: "100000" }],
          directMainnetDecision: "explicit",
          mainnetEnabled: false,
          broadcastAuthorized: false,
        },
      },
      f.token,
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Invalid request",
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.unspent).not.toHaveBeenCalled();
  expect(await f.store.get("OWNER#" + address, "TX#" + f.tx.id)).toBeUndefined();
  const stored = (
    await f.store.get("OWNER#" + address, "VAULT#" + f.vault.id)
  )?.vault as { status: string; funding?: unknown };
  expect(stored.status).toBe("unfunded");
  expect(stored.funding).toBeUndefined();
  const again = await f.app.request(
    req(
      path,
      {
        ...f.body,
        exactSpend: {
          directMainnetDecision: "explicit",
          inputs: [{ txid: "ab".repeat(32), vout: 0, valueSats: "100000" }],
        },
      },
      f.token,
    ),
  );
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ error: "Invalid request" });
  expect(release.mainnetEnabled).toBe(false);
  expect("broadcastAuthorized" in release).toBe(false);
});
it("does not preflight or broadcast a raw funding transaction", async () => {
  const f = await setup();
  const body = { ...f.body, exactSpend: undefined };
  const response = await f.app.request(
    req("/vaults/" + f.vault.id + "/fund", body, f.token),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Invalid request",
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.unspent).not.toHaveBeenCalled();
  expect(
    (await f.store.get("OWNER#" + address, "VAULT#" + f.vault.id))?.vault,
  ).toMatchObject({ status: "unfunded" });
});
it("does not treat a rewritten caller fee as an exact spend", async () => {
  const f = await setup();
  const response = await f.app.request(
    req(
      "/vaults/" + f.vault.id + "/fund",
      {
        ...f.body,
        exactSpend: { feeSats: "10001", directMainnetDecision: "explicit" },
      },
      f.token,
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "Invalid request" });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
});
it("does not submit a withdrawal without an exact spend record", async () => {
  const f = await setup();
  const jobId = crypto.randomUUID();
  await f.store.put({
    pk: "OWNER#" + address,
    sk: "JOB#" + jobId,
    version: 0,
    job: {
      id: jobId,
      vaultId: f.vault.id,
      owner: address,
      manifest: { outputValue: "50000", fee: "10000" },
      status: "awaiting_authorization",
    },
  });
  const response = await f.app.request(
    req("/jobs/" + jobId + "/submit", { rawTxHex: f.body.rawTxHex }, f.token),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "SpendAuthorizationRequired",
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.unspent).not.toHaveBeenCalled();
});
it("does not save a withdrawal intent before the transport refusal", async () => {
  const f = await setup();
  const jobId = crypto.randomUUID();
  await f.store.put({
    pk: "OWNER#" + address,
    sk: "JOB#" + jobId,
    version: 0,
    job: {
      id: jobId,
      vaultId: f.vault.id,
      owner: address,
      manifest: { outputValue: "50000", fee: "10000" },
      status: "awaiting_authorization",
    },
  });
  const response = await f.app.request(
    req(
      "/jobs/" + jobId + "/submit",
      {
        rawTxHex: f.body.rawTxHex,
        exactSpend: {
          directMainnetDecision: "explicit",
          inputs: [{ txid: "ab".repeat(32), vout: 0, valueSats: "100000" }],
        },
        spentFixtureRefs: f.body.spentFixtureRefs,
      },
      f.token,
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Invalid request",
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.unspent).not.toHaveBeenCalled();
  expect(await f.store.get("OWNER#" + address, "TX#" + f.tx.id)).toBeUndefined();
  expect(
    (await f.store.get("OWNER#" + address, "JOB#" + jobId))?.job,
  ).toMatchObject({ status: "awaiting_authorization" });
});
it("does not consult a rejecting mainnet miner while transport stays closed", async () => {
  const f = await setup(true);
  const response = await f.app.request(
    req("/vaults/" + f.vault.id + "/fund", f.body, f.token),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Invalid request",
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test).not.toHaveBeenCalled();
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.unspent).not.toHaveBeenCalled();
  expect(
    await f.store.get("OWNER#" + address, "TX#" + f.tx.id),
  ).toBeUndefined();
  expect(
    (await f.store.get("OWNER#" + address, "VAULT#" + f.vault.id))?.vault,
  ).toMatchObject({ status: "unfunded" });
});
