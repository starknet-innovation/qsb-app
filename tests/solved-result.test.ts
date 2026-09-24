import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expect, it } from "vitest";
import { deployedApiApp } from "../server/lambda";
import { MemoryStore } from "../server/store";
import capability from "../server/mainnet-capability.json";
import { release, type Job, type Withdrawal } from "../src/lib/model";
import { coordinatorPublicSolvedResult } from "../src/mainnet/coordinatorResult";
import {
  rebuildWithdrawalFromSolvedResult,
  signedCoordinatorResult,
} from "../src/mainnet/localSignature";
import type { FundingInput } from "../src/lib/transactions";

const privateKey = new Uint8Array(32).fill(1);
const publicKey = hex.encode(secp256k1.getPublicKey(privateKey));
const address = btc.p2wpkh(hex.decode(publicKey)).address!;
const secretState = "SECRET_RECOVERY_STATE_JSON_DO_NOT_EXPORT";
const options = { allowUnknownInputs: true, allowUnknownOutputs: true };

function digest(value: string) {
  return hex.encode(sha256(new TextEncoder().encode(value)));
}

function solvedJob() {
  const previous = new btc.Transaction(options);
  previous.addInput({ txid: "55".repeat(32), index: 0 });
  previous.addOutputAddress(address, 20000n);
  previous.addOutput({ script: hex.decode("51".repeat(100)), amount: 100000n });
  const previousTxHex = hex.encode(previous.toBytes(true, true));
  const vaultId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const manifest: Withdrawal = {
    vaultId,
    funding: { txid: previous.id, vout: 1, value: "100000" },
    helper: { txid: previous.id, vout: 0, value: "20000" },
    destination: address,
    outputScript: hex.encode(btc.p2wpkh(hex.decode(publicKey)).script),
    outputValue: "110000",
    fee: "10000",
    idempotencyKey: jobId,
    costAccepted: true,
  };
  const solution = {
    sequence: 2147483648,
    locktime: 500000000,
    round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    round2: [10, 11, 12, 13, 14, 15, 16, 17, 18],
  };
  const raw = new btc.Transaction({
    ...options,
    version: 1,
    lockTime: solution.locktime,
  });
  raw.addInput({ txid: previous.id, index: 0, sequence: 0xfffffffe });
  raw.addInput({ txid: previous.id, index: 1, sequence: solution.sequence });
  raw.addOutputAddress(address, 110000n);
  raw.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
  const job = {
    id: jobId,
    owner: address,
    vaultId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "awaiting_authorization",
    stage: "verification",
    manifest,
    manifestHash: digest(JSON.stringify(manifest)),
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
    solution,
    runpodId: secretState,
    error: secretState,
  } as Job;
  const helper: FundingInput = {
    txid: manifest.helper.txid,
    vout: manifest.helper.vout,
    value: BigInt(manifest.helper.value),
    previousTxHex,
    publicKey,
    address,
  };
  return {
    job,
    helper,
    previousTxHex,
    raw: hex.encode(raw.toBytes(true, true)),
  };
}

function request(path: string, token?: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn(app: ReturnType<typeof deployedApiApp>) {
  const challenge = await (
    await app.request(request("/api/auth/challenge", undefined, { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF().encode(privateKey),
    address,
    challenge.message,
  );
  const login = await app.request(
    request("/api/auth/verify", undefined, {
      id: challenge.id,
      signature,
    }),
  );
  expect(login.status).toBe(200);
  return (await login.json()).token as string;
}

it("delivers the coordinator solved result and signs it locally without exporting secrets", async () => {
  expect(release.mainnetEnabled).toBe(false);
  expect(capability.broadcastAuthorized).toBe(false);
  const store = new MemoryStore();
  const app = deployedApiApp("mainnet", store);
  const token = await signIn(app);
  const fixture = solvedJob();
  await store.put({
    pk: `OWNER#${address}`,
    sk: `JOB#${fixture.job.id}`,
    version: 0,
    job: fixture.job,
  });
  const denied = await app.request(
    request(`/api/jobs/${fixture.job.id}/solved-result`),
  );
  expect(denied.status).toBe(401);
  const response = await app.request(
    request(`/api/jobs/${fixture.job.id}/solved-result`, token),
  );
  expect(response.status).toBe(200);
  const solved = await response.json();
  expect(solved).toEqual(coordinatorPublicSolvedResult(fixture.job));
  expect(solved.mainnetEnabled).toBe(false);
  expect(solved.broadcastAuthorized).toBe(false);
  expect(JSON.stringify(solved)).not.toContain(secretState);
  expect(Object.keys(solved).sort()).toEqual([
    "broadcastAuthorized",
    "format",
    "jobId",
    "mainnetEnabled",
    "manifest",
    "manifestHash",
    "network",
    "solution",
    "vaultId",
  ]);
  const queued = {
    ...fixture.job,
    id: crypto.randomUUID(),
    status: "queued" as const,
    stage: "pinning" as const,
    solution: undefined,
  };
  await store.put({
    pk: `OWNER#${address}`,
    sk: `JOB#${queued.id}`,
    version: 0,
    job: queued,
  });
  expect(
    (
      await app.request(request(`/api/jobs/${queued.id}/solved-result`, token))
    ).status,
  ).toBe(404);

  const calls: string[] = [];
  const rebuilt = await rebuildWithdrawalFromSolvedResult({
    solved,
    job: fixture.job,
    stateJson: secretState,
    helper: fixture.helper,
    fundingPreviousTxHex: fixture.previousTxHex,
    assemble: async (state, manifest, solution) => {
      calls.push(state, JSON.stringify(manifest), JSON.stringify(solution));
      return fixture.raw;
    },
  });
  expect(calls[0]).toBe(secretState);
  expect(rebuilt.transaction.getInput(0).sighashType).toBe(1);
  const honest = btc.Transaction.fromPSBT(rebuilt.transaction.toPSBT(), options);
  if (!rebuilt.transaction.signIdx(privateKey, 0))
    throw new Error("local helper signature failed");
  const signed = signedCoordinatorResult(
    rebuilt.solved,
    honest,
    rebuilt.transaction.toPSBT(),
    { address, publicKey, type: "p2wpkh" },
  );
  expect(signed.helperSighash).toBe("SIGHASH_ALL");
  expect(signed.broadcastAuthorized).toBe(false);
  expect(signed.mainnetEnabled).toBe(false);
  expect(signed.qsbConsensusProven).toBe(false);
  expect(JSON.stringify(signed)).not.toContain(secretState);
  const extracted = btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), options);
  const witness = extracted.getInput(0).finalScriptWitness;
  expect(witness?.[0]?.at(-1)).toBe(0x01);
  expect(extracted.id).toBe(signed.txid);

  const input = rebuilt.transaction.getInput(0);
  const signature = input.partialSig?.[0]?.[1];
  if (!signature) throw new Error("missing helper signature");
  const reused = Uint8Array.from(signature);
  reused[reused.length - 1] = 0x82;
  const replaced = btc.Transaction.fromPSBT(honest.toPSBT(), options);
  replaced.updateInput(0, {
    sighashType: 0x82,
    partialSig: [[input.partialSig![0][0], reused]],
  });
  expect(() =>
    signedCoordinatorResult(rebuilt.solved, honest, replaced.toPSBT(), {
      address,
      publicKey,
      type: "p2wpkh",
    }),
  ).toThrow(/SIGHASH_ALL/);

  const submitted = await app.request(
    request(`/api/jobs/${fixture.job.id}/submit`, token, {
      rawTxHex: signed.rawTxHex,
    }),
  );
  expect(submitted.status).toBe(503);
  expect(release.mainnetEnabled).toBe(false);
  expect(capability.broadcastAuthorized).toBe(false);
});
