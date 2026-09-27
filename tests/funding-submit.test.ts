import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore } from "../server/store";
import { ChainError, ChainNotFound, Esplora } from "../server/chain";
import { submitFunding } from "../server/submit-funding";
import { createApp } from "../server/app";
import { SubmitDisabled } from "../server/submit-exact";
import { MinerHttpError, MinerRejection, Slipstream } from "../server/providers";
import { issueExactSubmitPermit } from "../server/exact-submit-permit";
import { transactionId } from "../server/runtime/miner-inclusion";
import { BITCOIN_NETWORK } from "../src/lib/network";
import type { PublicVault } from "../src/lib/model";

// Unsigned transactions only: the server checks what a deposit pays, never its signatures
// (MARA validates those), so no keys or signatures are needed here.
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const owner = address;
const scriptHex = "51".repeat(100);

function deposit(value = 50_000n, script = scriptHex, seed = 1) {
  const tx = new btc.Transaction({ ...opts, version: 2 });
  tx.addInput({ txid: new Uint8Array(32).fill(seed), index: 0, sequence: 0xfffffffe });
  tx.addOutput({ amount: value, script: hex.decode(script) });
  tx.addOutputAddress(address, 40_000n, BITCOIN_NETWORK);
  return hex.encode(tx.toBytes(true, false));
}

async function setup() {
  const store = new MemoryStore();
  const vault = {
    id: crypto.randomUUID(),
    scriptHex,
    config: "A",
    publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
    scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"),
    paymentAddress: address,
    network: "mainnet",
    status: "unfunded",
  } as PublicVault;
  await store.put({ pk: "OWNER#" + owner, sk: "VAULT#" + vault.id, version: 0, vault });
  const miner = {
    submitFunding: vi.fn(async (raw: string) => ({ status: "success", message: transactionId(raw) })),
    seen: vi.fn(async () => false),
  };
  const row = () => store.get("OWNER#" + owner, "VAULT#" + vault.id);
  return { store, vault, miner, row, deps: { store, miner, enabled: true } };
}

describe("submitFunding", () => {
  it("records the intent before the POST, then marks it submitted", async () => {
    const f = await setup();
    const raw = deposit();
    f.miner.submitFunding.mockImplementationOnce(async (hexTx: string) => {
      const during = await f.row();
      expect((during!.vault as PublicVault).funding?.txid).toBe(transactionId(raw));
      expect(during!.fundingRawTxHex).toBe(raw);
      expect(during!.fundingSubmission).toBe("uncertain");
      return { status: "success", message: transactionId(hexTx) };
    });
    const result = await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
    expect(result.submission).toBe("submitted");
    expect(result.vault.status).toBe("submitted");
    expect(result.vault.funding).toEqual({ txid: transactionId(raw), vout: 0, value: "50000" });
    expect((await f.row())!.fundingSubmission).toBe("submitted");
    expect(f.miner.submitFunding).toHaveBeenCalledTimes(1);
  });

  it("refuses a transaction that doesn't pay this vault the stated amount, before any POST", async () => {
    const f = await setup();
    await expect(submitFunding(owner, f.vault.id, deposit(50_000n, "52".repeat(100)), 50_000n, f.deps)).rejects.toThrow("does not pay this vault");
    await expect(submitFunding(owner, f.vault.id, deposit(49_999n), 50_000n, f.deps)).rejects.toThrow("amount does not match");
    await expect(submitFunding(owner, f.vault.id, "zz", 50_000n, f.deps)).rejects.toThrow("Invalid funding transaction");
    expect(f.miner.submitFunding).not.toHaveBeenCalled();
    expect(((await f.row())!.vault as PublicVault).funding).toBeUndefined();
  });

  it("is refused while miner submission is disabled", async () => {
    const f = await setup();
    await expect(submitFunding(owner, f.vault.id, deposit(), 50_000n, { ...f.deps, enabled: false })).rejects.toBeInstanceOf(SubmitDisabled);
    expect(f.miner.submitFunding).not.toHaveBeenCalled();
  });

  it("clears a fresh intent the miner definitely refused, so nothing is left pending", async () => {
    const f = await setup();
    f.miner.submitFunding.mockRejectedValueOnce(new MinerRejection("min relay fee not met"));
    const result = await submitFunding(owner, f.vault.id, deposit(), 50_000n, f.deps);
    expect(result).toMatchObject({ submission: "rejected", reason: "min relay fee not met" });
    const after = await f.row();
    expect((after!.vault as PublicVault).status).toBe("unfunded");
    expect((after!.vault as PublicVault).funding).toBeUndefined();
    expect(after!.fundingRawTxHex).toBeUndefined();
    expect(after!.lastFundingRejection).toMatchObject({ reason: "min relay fee not met" });
  });

  it("keeps the intent when the outcome is unknown, and a retry resubmits the same bytes", async () => {
    const f = await setup();
    const raw = deposit();
    f.miner.submitFunding.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps)).submission).toBe("uncertain");
    expect(((await f.row())!.vault as PublicVault).funding?.txid).toBe(transactionId(raw));
    const retry = await submitFunding(owner, f.vault.id, raw.toUpperCase(), 50_000n, f.deps);
    expect(retry.submission).toBe("submitted");
    expect(f.miner.seen).toHaveBeenCalledWith(transactionId(raw));
    expect(f.miner.submitFunding).toHaveBeenCalledTimes(2);
    expect(f.miner.submitFunding.mock.calls[1][0]).toBe(raw);
  });

  it("doesn't POST again when the miner already has the transaction", async () => {
    const f = await setup();
    const raw = deposit();
    f.miner.submitFunding.mockRejectedValueOnce(new Error("timeout"));
    await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
    f.miner.seen.mockResolvedValueOnce(true);
    expect((await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps)).submission).toBe("submitted");
    expect(f.miner.submitFunding).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown intent even if a retry is refused", async () => {
    const f = await setup();
    const raw = deposit();
    f.miner.submitFunding.mockRejectedValueOnce(new Error("timeout"));
    await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
    f.miner.submitFunding.mockRejectedValueOnce(new MinerRejection("txn-already-known"));
    expect((await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps)).submission).toBe("uncertain");
    expect(((await f.row())!.vault as PublicVault).funding?.txid).toBe(transactionId(raw));
  });

  it("refuses a second, different deposit once an intent exists", async () => {
    const f = await setup();
    f.miner.submitFunding.mockRejectedValueOnce(new Error("timeout"));
    await submitFunding(owner, f.vault.id, deposit(), 50_000n, f.deps);
    await expect(submitFunding(owner, f.vault.id, deposit(50_000n, scriptHex, 2), 50_000n, f.deps)).rejects.toBeInstanceOf(ChainError);
    expect(f.miner.submitFunding).toHaveBeenCalledTimes(1);
  });

  it("doesn't resubmit a deposit that's already confirmed", async () => {
    const f = await setup();
    const raw = deposit();
    await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
    const current = (await f.row())!;
    await f.store.put({ ...current, version: current.version + 1, vault: { ...(current.vault as PublicVault), status: "confirmed" } }, current.version);
    expect((await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps)).submission).toBe("submitted");
    expect(f.miner.submitFunding).toHaveBeenCalledTimes(1);
  });
});

describe("submitFunding refusals and races", () => {
  it("keeps a fresh intent when MARA has the transaction despite refusing a POST", async () => {
    const f = await setup();
    f.miner.submitFunding.mockRejectedValueOnce(new MinerRejection("txn-already-known"));
    f.miner.seen.mockResolvedValueOnce(true);
    expect((await submitFunding(owner, f.vault.id, deposit(), 50_000n, f.deps)).submission).toBe("submitted");
    expect(((await f.row())!.vault as PublicVault).funding).toBeDefined();
  });

  it("keeps a fresh intent when MARA can't be asked after a refusal", async () => {
    const f = await setup();
    f.miner.submitFunding.mockRejectedValueOnce(new MinerRejection("refused"));
    f.miner.seen.mockRejectedValueOnce(new Error("status unavailable"));
    expect((await submitFunding(owner, f.vault.id, deposit(), 50_000n, f.deps)).submission).toBe("uncertain");
    expect(((await f.row())!.vault as PublicVault).funding).toBeDefined();
  });

  it("a first request refused as a duplicate can't clear an intent while a retry's POST is in flight", async () => {
    const f = await setup();
    const raw = deposit();
    let release!: () => void;
    let retryStarted!: () => void;
    const started = new Promise<void>((r) => (retryStarted = r));
    let retry: Promise<unknown> | undefined;
    f.miner.seen.mockResolvedValue(false); // MARA's status lags behind its acceptance
    f.miner.submitFunding
      .mockImplementationOnce(async () => {
        // A resend from another tab starts while this first POST is in flight...
        retry = submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
        await started;
        // ...and this first POST is then refused as a duplicate.
        throw new MinerRejection("txn-already-known");
      })
      .mockImplementationOnce(async (hexTx: string) => {
        retryStarted();
        await new Promise<void>((r) => (release = r));
        return { status: "success", message: transactionId(hexTx) };
      });
    const first = await submitFunding(owner, f.vault.id, raw, 50_000n, f.deps);
    expect(first.submission).toBe("uncertain");
    expect(((await f.row())!.vault as PublicVault).funding?.txid).toBe(transactionId(raw));
    release();
    expect(await retry).toMatchObject({ submission: "submitted" });
    expect((await f.row())!.fundingRawTxHex).toBe(raw);
  });
});

describe("Slipstream deposit transport", () => {
  const env = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { QSB_NETWORK: "mainnet", QSB_MAINNET_ENABLED: "true", QSB_EXACT_SUBMIT_ENABLED: "true" });
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });
  const miner = () => new Slipstream("https://slipstream.mara.com", async () => undefined);
  const respond = (status: number, body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("posts the exact bytes and checks the returned txid", async () => {
    const raw = deposit();
    const fetch = respond(200, { status: "success", message: transactionId(raw) });
    await miner().submitFunding(raw, issueExactSubmitPermit(raw));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://slipstream.mara.com/api/transactions");
    expect(JSON.parse(String(init!.body))).toEqual({ tx_hex: raw });
  });

  it("maps a 400 refusal to MinerRejection with MARA's message", async () => {
    const raw = deposit();
    respond(400, { status: "error", message: "min relay fee not met" });
    await expect(miner().submitFunding(raw, issueExactSubmitPermit(raw))).rejects.toThrow(new MinerRejection("min relay fee not met"));
  });

  it("doesn't treat a 400 without status \"error\" as a refusal", async () => {
    const raw = deposit();
    respond(400, { is_success: false, message: "unexpected" });
    const error = await miner().submitFunding(raw, issueExactSubmitPermit(raw)).catch((e) => e);
    expect(error).toBeInstanceOf(MinerHttpError);
    expect(error).not.toBeInstanceOf(MinerRejection);
  });

  it("leaves other failures unknown", async () => {
    const raw = deposit();
    respond(502, { message: "bad gateway" });
    const error = await miner().submitFunding(raw, issueExactSubmitPermit(raw)).catch((e) => e);
    expect(error).toBeInstanceOf(MinerHttpError);
    expect(error).not.toBeInstanceOf(MinerRejection);
  });

  it("needs a live permit for the exact bytes, and both switches", async () => {
    const raw = deposit();
    const fetch = respond(200, { status: "success", message: transactionId(raw) });
    await expect(miner().submitFunding(raw, { rawHash: "x" })).rejects.toThrow("ExactSubmitPermitRequired");
    await expect(miner().submitFunding(deposit(50_000n, scriptHex, 3), issueExactSubmitPermit(raw))).rejects.toThrow("ExactSubmitBytesChanged");
    process.env.QSB_EXACT_SUBMIT_ENABLED = "false";
    await expect(miner().submitFunding(raw, issueExactSubmitPermit(raw))).rejects.toThrow("ExactSubmitDisabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads MARA's 'Transaction not found' as unseen", async () => {
    respond(400, { is_success: false, message: "Transaction not found" });
    expect(await miner().seen("00".repeat(32))).toBe(false);
  });
});

describe("chain lookup errors", () => {
  // The funding status fallback trusts only a definitive 404, never a provider failure.
  const read = (status: number) =>
    (new Esplora("https://chain.test", async () => new Response("", { status })) as unknown as {
      read(path: string): Promise<string>;
    }).read("/tx/" + "00".repeat(32) + "/status");
  it("raises ChainNotFound for a 404", async () => {
    await expect(read(404)).rejects.toBeInstanceOf(ChainNotFound);
  });
  for (const status of [429, 500, 503])
    it(`raises a plain ChainError for ${status}`, async () => {
      const error = await read(status).catch((e) => e);
      expect(error).toBeInstanceOf(ChainError);
      expect(error).not.toBeInstanceOf(ChainNotFound);
    });
});

describe("deposit routes", () => {
  // A seeded session stands in for sign-in, so no wallet signature is needed.
  const token = "A".repeat(43);
  async function app(chainStatus?: () => Promise<unknown>, chainRaw?: () => Promise<unknown>) {
    const f = await setup();
    await f.store.put({
      pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      owner,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const chain = new Esplora("https://chain.test", async () => new Response("", { status: 500 }));
    if (chainStatus) vi.spyOn(chain, "status").mockImplementation(chainStatus as never);
    if (chainRaw) vi.spyOn(chain, "raw").mockImplementation(chainRaw as never);
    const miner = new Slipstream("https://slipstream.mara.com", async () => undefined);
    const submit = vi.spyOn(miner, "submitFunding").mockImplementation(async (raw: string) => ({ status: "success" as const, message: transactionId(raw) }));
    const seen = vi.spyOn(miner, "seen").mockResolvedValue(false);
    const server = createApp(f.store, { chain, miner, enabled: true, exactSubmit: true });
    const call = (path: string, body?: unknown) =>
      server.request(new Request("http://localhost/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    return { ...f, call, submit, seen };
  }

  it("submits a signed deposit through POST /fund/submit", async () => {
    const f = await app();
    const raw = deposit();
    const response = await f.call(`/vaults/${f.vault.id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ submission: "submitted", vault: { status: "submitted" } });
    expect(f.submit).toHaveBeenCalledWith(raw, expect.anything());
  });

  it("resends the stored bytes through POST /fund/resubmit, and refuses without them", async () => {
    const f = await app();
    expect((await f.call(`/vaults/${f.vault.id}/fund/resubmit`, {})).status).toBe(409);
    const raw = deposit();
    f.submit.mockRejectedValueOnce(new Error("timeout"));
    await f.call(`/vaults/${f.vault.id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true });
    const response = await f.call(`/vaults/${f.vault.id}/fund/resubmit`, {});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ submission: "submitted" });
    expect(f.submit).toHaveBeenLastCalledWith(raw, expect.anything());
  });

  it("GET /funding falls back to the stored bytes only on a 404, without changing status", async () => {
    const notFound = () => Promise.reject(new ChainNotFound("Chain lookup failed (404). Retry before signing."));
    const f = await app(notFound, notFound);
    const raw = deposit();
    await f.call(`/vaults/${f.vault.id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true });
    const current = (await f.row())!;
    await f.store.put({ ...current, version: current.version + 1, vault: { ...(current.vault as PublicVault), status: "confirmed" } }, current.version);
    const response = await f.call(`/vaults/${f.vault.id}/funding`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: { confirmed: false }, previousTxHex: raw, submission: "submitted", vault: { status: "confirmed" } });
    expect(((await f.row())!.vault as PublicVault).status).toBe("confirmed");
  });

  it("GET /funding propagates a provider failure and leaves the status alone", async () => {
    const failing = () => Promise.reject(new ChainError("Chain lookup failed (500). Retry before signing."));
    const f = await app(failing, failing);
    await f.call(`/vaults/${f.vault.id}/fund/submit`, { rawTxHex: deposit(), amount: "50000", costAccepted: true });
    const current = (await f.row())!;
    await f.store.put({ ...current, version: current.version + 1, vault: { ...(current.vault as PublicVault), status: "confirmed" } }, current.version);
    expect((await f.call(`/vaults/${f.vault.id}/funding`)).status).toBe(409);
    expect(((await f.row())!.vault as PublicVault).status).toBe("confirmed");
  });
});
