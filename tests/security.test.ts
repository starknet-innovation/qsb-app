import { describe, it, expect } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { MemoryStore, Conflict } from "../server/store";
import {
  parseBtc,
  release,
  validatePublicState,
  type Recovery,
} from "../src/lib/model";
import { encryptRecovery, decryptRecovery } from "../src/lib/backup";
import {
  fundingPsbt,
  helperPsbt,
  verifySignedPsbt,
} from "../src/lib/transactions";
const privateKey = new Uint8Array(32).fill(1),
  pub = secp256k1.getPublicKey(privateKey),
  address = btc.p2wpkh(pub).address!;
const request = (path: string, body?: unknown, token?: string) =>
  new Request(`http://localhost/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
describe("wallet authorization", () => {
  it("requires a real signature, consumes nonce once, and expires sessions", async () => {
    const store = new MemoryStore(),
      app = createApp(store);
    expect((await app.request(request("/vaults"))).status).toBe(401);
    const c = await (
      await app.request(request("/auth/challenge", { address }))
    ).json();
    expect(
      (
        await app.request(
          request("/auth/verify", { id: c.id, signature: "invalid" }),
        )
      ).status,
    ).toBe(401);
    const signature = Signer.sign(
      btc.WIF().encode(privateKey),
      address,
      c.message,
    );
    const login = await app.request(
      request("/auth/verify", { id: c.id, signature }),
    );
    expect(login.status).toBe(200);
    const { token } = await login.json();
    expect(
      (await app.request(request("/vaults", undefined, token))).status,
    ).toBe(200);
    expect(
      (await app.request(request("/auth/verify", { id: c.id, signature })))
        .status,
    ).toBe(401);
    for (const row of store.rows.values())
      if (row.pk.startsWith("SESSION")) row.expiresAt = 1;
    expect(
      (await app.request(request("/vaults", undefined, token))).status,
    ).toBe(401);
  });
  it("rejects a signature for a different message", async () => {
    const app = createApp(new MemoryStore());
    const c = await (
      await app.request(request("/auth/challenge", { address }))
    ).json();
    const signature = Signer.sign(
      btc.WIF().encode(privateKey),
      address,
      "unrelated",
    );
    expect(
      (await app.request(request("/auth/verify", { id: c.id, signature })))
        .status,
    ).toBe(401);
  });
  it("keeps mainnet gate closed in server-owned release manifest", () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(release.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual([
      "wallet",
      "miner",
    ]);
  });
});
describe("state and input validation", () => {
  it("rejects stale writes and duplicate creates", async () => {
    const store = new MemoryStore();
    await store.put({ pk: "a", sk: "b", version: 0 });
    await expect(
      store.put({ pk: "a", sk: "b", version: 0 }),
    ).rejects.toBeInstanceOf(Conflict);
    await store.put({ pk: "a", sk: "b", version: 1 }, 0);
    await expect(
      store.put({ pk: "a", sk: "b", version: 2 }, 0),
    ).rejects.toBeInstanceOf(Conflict);
  });
  it("rejects secrets in GPU/public state", () => {
    expect(() =>
      validatePublicState(JSON.stringify({ hors_secrets: ["private"] })),
    ).toThrow();
    expect(() =>
      validatePublicState(
        JSON.stringify({
          config: "A",
          hash_mode: "sha256",
          n: 150,
          round_sigs: [{ r: 1, s: 2, sig: "00", k: 3 }],
        }),
      ),
    ).toThrow();
  });
  it("uses exact satoshi arithmetic without float rounding", () => {
    expect(parseBtc("0.00000001")).toBe(1n);
    expect(parseBtc("21000000")).toBe(2100000000000000n);
    for (const value of ["1e-8", "0.000000001", "-1", "0", "21000001", "NaN"])
      expect(() => parseBtc(value)).toThrow();
  });
});
describe("encrypted recovery", () => {
  const recovery: Recovery = {
    format: "qsb-recovery-v1",
    stateJson: '{"hors_secrets":["private-only"]}',
    vault: {
      id: crypto.randomUUID(),
      name: "Test",
      createdAt: new Date().toISOString(),
      network: "mainnet",
      config: "A",
      scriptHex: "51",
      scriptHash: "00".repeat(32),
      paymentAddress: address,
      publicStateJson: "{}",
      status: "unfunded",
    },
  };
  it("restores exactly and rejects wrong passwords and tampering", async () => {
    const text = await encryptRecovery(recovery, "a long test passphrase");
    expect(text).not.toContain("private-only");
    expect(await decryptRecovery(text, "a long test passphrase")).toEqual(
      recovery,
    );
    await expect(decryptRecovery(text, "wrong")).rejects.toThrow(
      "Unable to unlock",
    );
    const e = JSON.parse(text);
    e.ciphertext = "AA" + e.ciphertext.slice(2);
    await expect(
      decryptRecovery(JSON.stringify(e), "a long test passphrase"),
    ).rejects.toThrow();
  });
  it("refuses an attacker-controlled KDF iteration count", async () => {
    const text = await encryptRecovery(recovery, "a long test passphrase");
    const e = JSON.parse(text);
    e.iterations = 1;
    await expect(
      decryptRecovery(JSON.stringify(e), "a long test passphrase"),
    ).rejects.toThrow();
  });
});
describe("transaction invariants", () => {
  function withdrawal() {
    const helper = input();
    const previous = new btc.Transaction({ allowUnknownOutputs: true });
    previous.addInput({ txid: "22".repeat(32), index: 0 });
    previous.addOutput({
      amount: 100000n,
      script: hex.decode("51".repeat(100)),
    });
    const spend = new btc.Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    spend.addInput({ txid: helper.txid, index: 0 });
    spend.addInput({ txid: previous.id, index: 0 });
    spend.addOutputAddress(address, 180000n);
    spend.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
    return { helper, previous, spend };
  }
  it("preserves QSB authorization while preparing the helper PSBT and rejects wallet replacement", () => {
    const { helper, previous, spend } = withdrawal();
    const expected = helperPsbt(
      hex.encode(spend.toBytes(true, true)),
      helper,
      hex.encode(previous.toBytes(true, true)),
    );
    expect(hex.encode(expected.getInput(1).finalScriptSig!)).toBe("0101");
    expect(expected.getInput(0).sighashType).toBe(1);
    expect(() => verifySignedPsbt(expected, expected.toPSBT())).not.toThrow();
    const altered = expected.clone();
    altered.updateInput(1, { finalScriptSig: hex.decode("0102") }, true);
    expect(hex.encode(altered.unsignedTx)).toBe(
      hex.encode(expected.unsignedTx),
    );
    expect(() => verifySignedPsbt(expected, altered.toPSBT())).toThrow(
      "QSB authorization",
    );
  });
  it("rejects a helper signed with a sighash other than SIGHASH_ALL", () => {
    const { helper, previous, spend } = withdrawal();
    const expected = helperPsbt(
      hex.encode(spend.toBytes(true, true)),
      helper,
      hex.encode(previous.toBytes(true, true)),
    );
    const signed = expected.clone();
    if (!signed.signIdx(privateKey, 0)) throw new Error("missing helper signature");
    const input = signed.getInput(0);
    const signature = input.partialSig?.[0]?.[1];
    if (!signature) throw new Error("missing helper signature");
    const anyoneCanPay = Uint8Array.from(signature);
    anyoneCanPay[anyoneCanPay.length - 1] = 0x82;
    const bad = expected.clone();
    bad.updateInput(0, {
      partialSig: [[input.partialSig![0][0], anyoneCanPay]],
    });
    expect(() => verifySignedPsbt(expected, bad.toPSBT())).toThrow(
      "SIGHASH_ALL",
    );
  });
  it("rejects a helper public key that does not control the quoted payment address", () => {
    const { helper, previous, spend } = withdrawal();
    const wrongKey = hex.encode(
      secp256k1.getPublicKey(new Uint8Array(32).fill(2)),
    );
    expect(() =>
      helperPsbt(
        hex.encode(spend.toBytes(true, true)),
        { ...helper, publicKey: wrongKey },
        hex.encode(previous.toBytes(true, true)),
      ),
    ).toThrow("helper payment key");
  });
  function input() {
    const prev = new btc.Transaction();
    prev.addInput({ txid: "11".repeat(32), index: 0 });
    prev.addOutputAddress(address, 100000n);
    return {
      txid: prev.id,
      vout: 0,
      value: 100000n,
      previousTxHex: hex.encode(prev.toBytes(true, true)),
      publicKey: hex.encode(pub),
      address,
    };
  }
  it("constructs funding without losing sats and detects a changed destination", () => {
    const i = input();
    const tx = fundingPsbt([i], "51".repeat(100), 50000n, 12000n, address);
    expect(tx.getOutput(1).amount).toBe(38000n);
    const altered = tx.clone();
    altered.updateOutput(0, { amount: 49000n });
    expect(() => verifySignedPsbt(tx, altered.toPSBT())).toThrow(
      "changed the transaction",
    );
    expect(() =>
      fundingPsbt([i, i], "51".repeat(100), 50000n, 10000n, address),
    ).toThrow("Duplicate");
  });
  it("checks previous output amounts rather than trusting quoted values", () => {
    expect(() =>
      fundingPsbt(
        [{ ...input(), value: 90000n }],
        "51".repeat(100),
        50000n,
        12000n,
        address,
      ),
    ).toThrow("Input amount");
  });
});
