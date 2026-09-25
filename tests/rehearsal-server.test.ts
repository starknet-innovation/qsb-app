import { afterEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Signer } from "bip322-js";
vi.mock("../src/lib/network", () => ({
  NETWORK_ID: "testnet4",
  BITCOIN_NETWORK: btc.TEST_NETWORK,
  NETWORK_CONFIG: {
    chainUrl: "https://mempool.space/testnet4/api",
    minerUrl: "https://teststream.mara.com",
  },
}));
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import type { Job } from "../src/lib/model";
import { rehearsalAddressAllowed, testnet4Genesis } from "../server/network";
const key = new Uint8Array(32).fill(7),
  pub = secp256k1.getPublicKey(key);
const address = btc.p2wpkh(pub, btc.TEST_NETWORK).address!;
const post = (path: string, body: unknown, token?: string) =>
  new Request("https://rehearsal.invalid/api" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("pins testnet4 genesis and rejects a provider serving a different chain", async () => {
  const wrong = new Esplora(
    "https://example.invalid",
    vi.fn().mockResolvedValue(new Response("00".repeat(32))),
  );
  await expect(wrong.raw("11".repeat(32))).rejects.toThrow(
    "not Bitcoin testnet4",
  );
  const correct = new Esplora(
    "https://example.invalid",
    vi.fn().mockResolvedValue(new Response(testnet4Genesis)),
  );
  await expect(correct.assertNetwork()).resolves.toBeUndefined();
});
it("never resolves production authorization for Teststream", async () => {
  const authorization = vi.fn().mockResolvedValue("should-never-be-resolved");
  const request = vi
    .fn()
    .mockImplementation(async (url: string) =>
      Response.json(url.endsWith("/api/system") ? { chain: "testnet4" } : {}),
    );
  vi.stubGlobal("fetch", request);
  await new Slipstream("https://teststream.mara.com", authorization).test("00");
  expect(authorization).not.toHaveBeenCalled();
  expect(
    new Headers(request.mock.calls[0][1].headers).has("Authorization"),
  ).toBe(false);
});
it("accepts test-wallet authentication, rejects mainnet addresses and scopes the signed challenge", async () => {
  const app = createApp(new MemoryStore());
  expect(
    (
      await app.request(
        post("/auth/challenge", { address: btc.p2wpkh(pub).address! }),
      )
    ).status,
  ).toBe(400);
  const response = await app.request(post("/auth/challenge", { address }));
  expect(response.status).toBe(200);
  const challenge = await response.json();
  expect(challenge.message).toContain("Network: bitcoin-testnet4");
  const signature = Signer.sign(
    btc.WIF(btc.TEST_NETWORK).encode(key),
    address,
    challenge.message,
  );
  const signedIn = await app.request(
    post("/auth/verify", { id: challenge.id, signature }),
  );
  expect(signedIn.status).toBe(200);
  const { token } = await signedIn.json();
  const blocked = await app.request(post("/vaults/any/fund", {}, token));
  expect(blocked.status).toBe(503);
});
it("requires exact explicit allowlisting even when an injected operations gate is on", async () => {
  vi.stubEnv("QSB_REHEARSAL_ADDRESSES", "");
  expect(rehearsalAddressAllowed(address)).toBe(false);
  vi.stubEnv("QSB_REHEARSAL_ADDRESSES", ` ${address} `);
  expect(rehearsalAddressAllowed(address)).toBe(true);
  expect(rehearsalAddressAllowed(btc.p2wpkh(pub).address!)).toBe(false);
  const store = new MemoryStore();
  const app = createApp(store, { enabled: true });
  const challenge = await (
    await app.request(post("/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF(btc.TEST_NETWORK).encode(key),
    address,
    challenge.message,
  );
  const { token } = await (
    await app.request(post("/auth/verify", { id: challenge.id, signature }))
  ).json();
  vi.stubEnv("QSB_REHEARSAL_ADDRESSES", "");
  expect((await app.request(post("/vaults/any/fund", {}, token))).status).toBe(
    503,
  );
});

it("resumes a paused job when only another coverage account is stopped", async () => {
  vi.stubEnv("QSB_REHEARSAL_ADDRESSES", address);
  const store = new MemoryStore();
  const app = createApp(store, { enabled: true });
  const challenge = await (
    await app.request(post("/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF(btc.TEST_NETWORK).encode(key),
    address,
    challenge.message,
  );
  const { token } = await (
    await app.request(post("/auth/verify", { id: challenge.id, signature }))
  ).json();
  const jobId = "paused-job";
  const job = {
    id: jobId,
    owner: address,
    vaultId: "v",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    status: "paused",
    stage: "pinning",
    manifest: {},
    manifestHash: "a".repeat(64),
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
  } as Job;
  const account = {
    solverPin: "qsb-config-a-ranked-v2-2791ed0",
    pinning: [],
    subsets: {},
    stopped: true,
    stopReason: "deterministic-failure",
  };
  await store.put({
    pk: `OWNER#${address}`,
    sk: `JOB#${jobId}`,
    version: 0,
    job,
    validation: {
      coverageLedger: {
        holdSolverBinarySha256: null,
        measuresHoldSolverBinary: false,
        accounts: [{ ...account, sessionId: "other-session" }],
      },
    },
  });
  const resumed = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(resumed.status).toBe(202);
  expect((await resumed.json()).job.status).toBe("queued");
  await store.put(
    {
      pk: `OWNER#${address}`,
      sk: `JOB#${jobId}`,
      version: 1,
      job: { ...job, status: "paused", revision: 1 },
      validation: {
        coverageLedger: {
          holdSolverBinarySha256: null,
          measuresHoldSolverBinary: false,
          accounts: [{ ...account, sessionId: `${address}/${jobId}` }],
        },
      },
    },
    1,
  );
  const blocked = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({
    error: "Stopped coverage cannot be resumed on this account.",
  });
});

it("refuses to resume an unknown submission even when a list miss set an allowance", async () => {
  vi.stubEnv("QSB_REHEARSAL_ADDRESSES", address);
  const store = new MemoryStore();
  const app = createApp(store, { enabled: true });
  const challenge = await (
    await app.request(post("/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF(btc.TEST_NETWORK).encode(key),
    address,
    challenge.message,
  );
  const { token } = await (
    await app.request(post("/auth/verify", { id: challenge.id, signature }))
  ).json();
  const jobId = "unknown-job";
  const job = {
    id: jobId,
    owner: address,
    vaultId: "v",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    status: "paused",
    stage: "pinning",
    manifest: {},
    manifestHash: "a".repeat(64),
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
    error: "Submission outcome unknown. Reconcile Runpod before resuming.",
  } as Job;
  await store.put({
    pk: `OWNER#${address}`,
    sk: `JOB#${jobId}`,
    version: 0,
    job,
  });
  const blocked = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(blocked.status).toBe(409);
  await store.put(
    {
      pk: `OWNER#${address}`,
      sk: `JOB#${jobId}`,
      version: 1,
      job: { ...job, oneSubmissionAllowed: true },
    },
    0,
  );
  const resumed = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(resumed.status).toBe(409);
  expect(await resumed.json()).toEqual({
    error: "Reconcile the unknown compute provider submission before retrying.",
  });
  const kept = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))
    ?.job as Job;
  expect(kept.status).toBe("paused");
  expect(kept.oneSubmissionAllowed).toBe(true);
  expect(kept.runpodId).toBeUndefined();
  const row = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))!;
  await store.put(
    {
      ...row,
      version: row.version + 1,
      job: {
        ...kept,
        submissionReconciliation: {
          kind: "not-submitted",
          reason: "rejected-before-acceptance",
          operator: "operator@example",
          evidence: "audit://incident/1",
          at: new Date().toISOString(),
          revision: kept.revision,
        },
      },
    },
    row.version,
  );
  const allowed = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(allowed.status).toBe(202);
  const queued = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))!
    .job as Job;
  expect(queued.oneSubmissionAllowed).toBeUndefined();
  expect(
    (await app.request(post(`/jobs/${jobId}/resume`, {}, token))).status,
  ).toBe(409);
  const again = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))!;
  await store.put(
    {
      ...again,
      version: again.version + 1,
      job: { ...queued, status: "paused", error: job.error },
    },
    again.version,
  );
  expect(
    (await app.request(post(`/jobs/${jobId}/resume`, {}, token))).status,
  ).toBe(409);
});
it("blocks Teststream preflight when the miner reports a different chain and does not submit without a permit", async () => {
  const request = vi
    .fn()
    .mockImplementation(async () => Response.json({ chain: "main" }));
  vi.stubGlobal("fetch", request);
  const miner = new Slipstream("https://teststream.mara.com");
  await expect(miner.test("00")).rejects.toThrow(
    "not serving Bitcoin testnet4",
  );
  expect(
    request.mock.calls.every(([url]) => String(url).endsWith("/api/system")),
  ).toBe(true);
  request.mockClear();
  await expect(miner.submit("00", undefined)).rejects.toThrow(
    "SpendAuthorizationRequired",
  );
  expect(request).not.toHaveBeenCalled();
});
