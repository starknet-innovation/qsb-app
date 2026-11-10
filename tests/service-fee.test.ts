import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { BITCOIN_NETWORK } from "../src/lib/network";
import {
  SERVICE_FEE_USD,
  checkServiceFeeQuote,
  kmsPublicKey,
  serviceFeeAddress,
  serviceFeeSats,
} from "../src/lib/service-fee";
import { fundingFeeForRate, fundingPsbt, fundingVsize } from "../src/lib/transactions";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { buildSweep, signSweep, sweepReport, sweepVsize, type FeeKeySigner } from "../server/service-fee-sweep";
import { PRICE_CACHE_MS, serviceFee } from "../server/service-fee";
import { SERVICE_FEE_KEY, SERVICE_FEE_PRIVATE_KEY, SERVICE_FEE_SPKI } from "./service-fee-fixture";
import { createdVault } from "./sdk-fixture";

const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const feePublicKey = secp256k1.getPublicKey(SERVICE_FEE_PRIVATE_KEY, true);
const feeAddress = btc.p2wpkh(feePublicKey, BITCOIN_NETWORK).address!;

describe("service fee amount and address", () => {
  it("is the fixed USD amount in sats at the price, rounded up", () => {
    expect(SERVICE_FEE_USD).toBe(200);
    expect(serviceFeeSats("100000")).toBe(200_000n);
    expect(serviceFeeSats("100000.00")).toBe(200_000n);
    // 200 / 97,123.45 BTC = 205,923.2... sats, rounded up.
    expect(serviceFeeSats("97123.45")).toBe(205_924n);
  });
  for (const price of ["", "abc", "-1", "1e5", "999.99", "9999.99", "100000001", "1.123456789"])
    it(`refuses the price ${JSON.stringify(price)}`, () => {
      expect(() => serviceFeeSats(price)).toThrow();
    });
  it("derives the P2WPKH address from the KMS DER public key", () => {
    expect(hex.encode(kmsPublicKey(SERVICE_FEE_SPKI))).toBe(hex.encode(feePublicKey));
    expect(serviceFeeAddress(SERVICE_FEE_KEY)).toBe(feeAddress);
    const wrongCurve = SERVICE_FEE_SPKI.slice();
    wrongCurve[20] ^= 1;
    expect(() => kmsPublicKey(wrongCurve)).toThrow("secp256k1");
    expect(() => kmsPublicKey(SERVICE_FEE_SPKI.subarray(0, 60))).toThrow("secp256k1");
  });
});

describe("checkServiceFeeQuote", () => {
  const quote = {
    usd: 200,
    btcUsd: "100000",
    source: "coinbase",
    sats: "200000",
    address: feeAddress,
    quotedAt: "2026-11-10T00:00:00.000Z",
  };
  it("accepts a self-consistent quote and gives its output", () => {
    expect(checkServiceFeeQuote(quote).output).toEqual({ address: feeAddress, amount: 200_000n });
  });
  it("refuses an amount that isn't the fee at the quote's price", () => {
    expect(() => checkServiceFeeQuote({ ...quote, sats: "300000" })).toThrow("doesn't match its price");
  });
  it("refuses an address that isn't P2WPKH, and another USD amount", () => {
    const taproot = btc.p2tr(secp256k1.getPublicKey(SERVICE_FEE_PRIVATE_KEY, true).subarray(1), undefined, BITCOIN_NETWORK).address!;
    expect(() => checkServiceFeeQuote({ ...quote, address: taproot })).toThrow("P2WPKH");
    expect(() => checkServiceFeeQuote({ ...quote, usd: 100 })).toThrow();
  });
});

describe("deposit with the service fee", () => {
  const key = new Uint8Array(32).fill(3);
  const pub = secp256k1.getPublicKey(key, true);
  const address = btc.p2wpkh(pub, BITCOIN_NETWORK).address!;
  const scriptHex = "51".repeat(100);
  function input(value = 400_000n) {
    const prev = new btc.Transaction();
    prev.addInput({ txid: "11".repeat(32), index: 0 });
    prev.addOutputAddress(address, value);
    return { txid: prev.id, vout: 0, value, previousTxHex: hex.encode(prev.toBytes(true, true)), publicKey: hex.encode(pub), address };
  }
  const serviceFee = { address: feeAddress, amount: 200_000n };

  it("pays the vault at output 0, the fee at output 1 and change last", () => {
    const quote = fundingFeeForRate([400_000n], false, 100, 50_000n, 2_000n, serviceFee.amount);
    const tx = fundingPsbt([input()], scriptHex, 50_000n, quote.fee, address, serviceFee);
    expect(tx.outputsLength).toBe(3);
    expect(hex.encode(tx.getOutput(0).script!)).toBe(scriptHex);
    expect(tx.getOutput(0).amount).toBe(50_000n);
    expect(tx.getOutput(1).amount).toBe(200_000n);
    expect(hex.encode(tx.getOutput(1).script!)).toBe(hex.encode(btc.p2wpkh(feePublicKey).script));
    expect(tx.getOutput(2).amount).toBe(400_000n - 50_000n - 200_000n - quote.fee);
  });
  it("sizes the fee output into the miner fee", () => {
    for (const change of [true, false])
      expect(fundingVsize(1, false, 100, change, true) - fundingVsize(1, false, 100, change)).toBe(31);
    // The signed size is at most the estimate (DER signatures are at most 72 bytes).
    const quote = fundingFeeForRate([400_000n], false, 100, 50_000n, 1_000n, serviceFee.amount);
    const tx = fundingPsbt([input()], scriptHex, 50_000n, quote.fee, address, serviceFee);
    tx.sign(key);
    tx.finalize();
    expect(tx.vsize).toBeLessThanOrEqual(quote.vsize);
  });
  it("refuses a deposit that can't also pay the fee", () => {
    expect(() => fundingFeeForRate([240_000n], false, 100, 50_000n, 1_000n, serviceFee.amount)).toThrow("service fees");
    expect(() => fundingPsbt([input(240_000n)], scriptHex, 50_000n, 1_000n, address, serviceFee)).toThrow("service fees");
  });
  it("refuses a fee address that isn't P2WPKH or a dust fee", () => {
    expect(() => fundingPsbt([input()], scriptHex, 50_000n, 1_000n, address, { address: btc.p2sh(btc.p2wpkh(pub)).address!, amount: 200_000n })).toThrow("P2WPKH");
    expect(() => fundingPsbt([input()], scriptHex, 50_000n, 1_000n, address, { address: feeAddress, amount: 100n })).toThrow("dust");
  });
  it("leaves a deposit without the fee unchanged", () => {
    const tx = fundingPsbt([input()], scriptHex, 50_000n, 1_000n, address);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(1).amount).toBe(400_000n - 50_000n - 1_000n);
  });
});

describe("GET /api/service-fee", () => {
  const request = (app: ReturnType<typeof createApp>, path: string) => app.request(new Request(`http://localhost/api${path}`));
  it("quotes the fee at the price, to the key's address, and the config says it's offered", async () => {
    const app = createApp(new MemoryStore(), { serviceFee: { publicKey: SERVICE_FEE_KEY, price: async () => "80000" } });
    const response = await request(app, "/service-fee");
    expect(response.status).toBe(200);
    const quote = checkServiceFeeQuote(await response.json());
    expect(quote).toMatchObject({ address: feeAddress, sats: "250000", btcUsd: "80000", usd: 200 });
    expect((await (await request(app, "/config")).json()).serviceFeeAddress).toBe(feeAddress);
  });
  it("reads the price at most once a minute, and keeps no failed read", async () => {
    let reads = 0, fail = false, clock = 0;
    const fee = serviceFee({ publicKey: SERVICE_FEE_KEY, price: async () => { reads++; if (fail) throw new Error("down"); return String(80000 + reads); } }, () => clock);
    const first = await fee!.quote();
    clock = PRICE_CACHE_MS - 1;
    expect(await fee!.quote()).toEqual(first);
    expect(reads).toBe(1);
    clock = PRICE_CACHE_MS;
    fail = true;
    await expect(fee!.quote()).rejects.toThrow("down");
    fail = false;
    expect((await fee!.quote()).btcUsd).toBe("80003");
    expect(reads).toBe(3);
  });
  it("offers no fee without a key", async () => {
    const app = createApp(new MemoryStore(), { serviceFee: { publicKey: "" } });
    expect((await request(app, "/service-fee")).status).toBe(404);
    expect((await (await request(app, "/config")).json()).serviceFeeAddress).toBe(null);
  });
  it("refuses to start with a key that isn't secp256k1", () => {
    expect(() => createApp(new MemoryStore(), { serviceFee: { publicKey: base64.encode(new Uint8Array(88)) } })).toThrow("secp256k1");
  });
});

describe("service fee sweep", () => {
  const destination = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true), BITCOIN_NETWORK).address!;
  const utxos = [
    { txid: "aa".repeat(32), vout: 1, value: 200_000n },
    { txid: "bb".repeat(32), vout: 0, value: 250_000n },
  ];
  // A KMS stand-in that, like KMS, may return high-S signatures.
  const signer = (highS: boolean): FeeKeySigner => ({
    publicKey: async () => feePublicKey,
    sign: async (digest) => {
      const low = secp256k1.Signature.fromBytes(secp256k1.sign(digest, SERVICE_FEE_PRIVATE_KEY, { prehash: false }), "compact");
      return (highS ? new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s) : low).toBytes("der");
    },
  });
  it("moves every output to the destination less a fee within the size estimate", async () => {
    const plan = buildSweep(utxos, feePublicKey, destination, 2_000n);
    expect(plan.total).toBe(450_000n);
    expect(plan.fee).toBe(BigInt(sweepVsize(2, 22)) * 2n);
    expect(plan.amount).toBe(450_000n - plan.fee);
    const signed = await signSweep(plan.tx, feePublicKey, signer(true));
    expect(signed.vsize).toBeLessThanOrEqual(plan.vsize);
    const report = sweepReport(signed, plan, destination);
    const parsed = btc.Transaction.fromRaw(hex.decode(report.rawTxHex), opts);
    expect(parsed.outputsLength).toBe(1);
    expect(parsed.getOutput(0).amount).toBe(plan.amount);
    // Each witness is a low-S SIGHASH_ALL signature by the fee key over its own input.
    const scriptCode = btc.OutScript.encode({ type: "pkh", hash: btc.p2wpkh(feePublicKey).hash });
    for (let i = 0; i < parsed.inputsLength; i++) {
      const [signature, key] = parsed.getInput(i).finalScriptWitness!;
      expect(hex.encode(key)).toBe(hex.encode(feePublicKey));
      expect(signature[signature.length - 1]).toBe(btc.SigHash.ALL);
      const parsedSignature = secp256k1.Signature.fromBytes(signature.subarray(0, -1), "der");
      expect(parsedSignature.hasHighS()).toBe(false);
      const digest = parsed.preimageWitnessV0(i, scriptCode, btc.SigHash.ALL, utxos[i].value);
      expect(secp256k1.verify(parsedSignature.toBytes("compact"), digest, feePublicKey, { prehash: false })).toBe(true);
    }
  });
  it("refuses a signature by another key", async () => {
    const plan = buildSweep(utxos, feePublicKey, destination, 2_000n);
    const other: FeeKeySigner = {
      publicKey: async () => feePublicKey,
      sign: async (digest) => secp256k1.Signature.fromBytes(secp256k1.sign(digest, new Uint8Array(32).fill(5), { prehash: false }), "compact").toBytes("der"),
    };
    await expect(signSweep(plan.tx, feePublicKey, other)).rejects.toThrow("doesn't verify");
  });
  it("refuses nothing to move, duplicates and a dust result", () => {
    expect(() => buildSweep([], feePublicKey, destination, 1_000n)).toThrow("no confirmed outputs");
    expect(() => buildSweep([utxos[0], utxos[0]], feePublicKey, destination, 1_000n)).toThrow("Duplicate");
    expect(() => buildSweep([{ ...utxos[0], value: 400n }], feePublicKey, destination, 1_000n)).toThrow("dust");
    expect(() => buildSweep(utxos, feePublicKey, destination, 1_000_000n)).toThrow("over 10%");
  });
});

describe("SDK deposit with the opted-in service fee", () => {
  const passphrase = "correct horse battery staple service fee";
  // At 1,000,000 USD/BTC the fee is 20,000 sats, which the fixture wallet's 300,000-sat output covers.
  const server = { serviceFee: { publicKey: SERVICE_FEE_KEY, price: async () => "1000000" } };
  const prepare = (v: Awaited<ReturnType<typeof createdVault>>, serviceFee?: { maxSats: bigint | string; address?: string }) =>
    v.client.deposits.prepare(v.vault.id, {
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }], serviceFee,
    });
  const other = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true), BITCOIN_NETWORK).address!;

  it("adds the fee as output 1, and the server records the vault's output 0", async () => {
    const v = await createdVault(passphrase, { server });
    expect((await v.client.config()).serviceFeeAddress).toBe(feeAddress);
    expect(await v.client.serviceFee()).toMatchObject({ sats: "20000", address: feeAddress });
    const prepared = await prepare(v, { maxSats: 20000n, address: feeAddress });
    expect(prepared.serviceFee).toMatchObject({ address: feeAddress, amount: "20000", usd: 200 });
    expect(BigInt(prepared.change)).toBe(300000n - 200000n - 20000n - BigInt(prepared.fee));
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    const deposit = await v.client.deposits.submit(prepared, signed, { costAccepted: true });
    const raw = btc.Transaction.fromRaw(hex.decode(v.w.minerSubmissions[0]), opts);
    expect(raw.id).toBe(deposit.txid);
    expect(raw.getOutput(1)).toMatchObject({ amount: 20000n });
    expect(hex.encode(raw.getOutput(1).script!)).toBe(hex.encode(btc.p2wpkh(feePublicKey).script));
    expect(deposit.vault.funding).toMatchObject({ vout: 0, value: "200000" });
  }, 120000);

  it("pays no fee unless asked", async () => {
    const v = await createdVault(passphrase, { server });
    const prepared = await prepare(v);
    expect(prepared.serviceFee).toBeUndefined();
    expect(btc.Transaction.fromPSBT(base64.decode(prepared.psbt), opts).outputsLength).toBe(2);
  }, 120000);

  it("refuses a quote above the caller's limit or to another address than expected", async () => {
    const v = await createdVault(passphrase, { server });
    await expect(prepare(v, { maxSats: 19999n })).rejects.toThrow("above your limit of 19999 sats");
    await expect(prepare(v, { maxSats: 20000n, address: other })).rejects.toThrow(`not ${other}`);
  }, 120000);

  it("refuses a quote whose address isn't the configured one", async () => {
    // The quote route answers for another key than the one /config names.
    const v = await createdVault(passphrase, { server, wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await next(input, init);
      if (!String(input).endsWith("/service-fee")) return response;
      return Response.json({ ...(await response.json()), address: other });
    }) as typeof fetch });
    await expect(prepare(v, { maxSats: 20000n })).rejects.toThrow("configured fee address");
  }, 120000);

  it("refuses a prepared file whose fee pays another address or another amount", async () => {
    const v = await createdVault(passphrase, { server });
    const prepared = await prepare(v, { maxSats: 20000n });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    await expect(
      v.client.deposits.submit({ ...prepared, serviceFee: { ...prepared.serviceFee!, address: other } }, signed, { costAccepted: true }),
    ).rejects.toThrow("doesn't pay this deployment's fee address");
    await expect(
      v.client.deposits.submit({ ...prepared, serviceFee: { ...prepared.serviceFee!, amount: "40000" } }, signed, { costAccepted: true }),
    ).rejects.toThrow("doesn't match its price");
    expect(v.w.minerSubmissions).toEqual([]);
  }, 120000);

  it("submits a signed deposit with the fee while the price source is down", async () => {
    let down = false;
    const v = await createdVault(passphrase, { server: { serviceFee: { publicKey: SERVICE_FEE_KEY, price: async () => { if (down) throw new Error("down"); return "1000000"; } } } });
    const prepared = await prepare(v, { maxSats: 20000n });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    down = true;
    expect((await v.client.deposits.submit(prepared, signed, { costAccepted: true })).submission).toBe("submitted");
  }, 120000);
});
