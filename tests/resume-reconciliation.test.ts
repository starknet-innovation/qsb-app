import { afterEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Signer } from "bip322-js";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import type { Job } from "../src/lib/model";

const key = new Uint8Array(32).fill(7),
  pub = secp256k1.getPublicKey(key);
const address = btc.p2wpkh(pub).address!;
const post = (path: string, body: unknown, token?: string) =>
  new Request("https://qsb.invalid/api" + path, {
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

// A paid submission is never repeated: an unknown one blocks resume until an operator records
// that nothing was submitted, and an allowance from a list miss alone isn't that record.
it("refuses to resume an unknown submission even when a list miss set an allowance", async () => {
  const store = new MemoryStore();
  const app = createApp(store, { enabled: true });
  const challenge = await (await app.request(post("/auth/challenge", { address }))).json();
  const signature = Signer.sign(btc.WIF().encode(key), address, challenge.message);
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
    error: "Submission outcome unknown. Reconcile the compute provider before resuming.",
  } as Job;
  await store.put({ pk: `OWNER#${address}`, sk: `JOB#${jobId}`, version: 0, job });
  expect((await app.request(post(`/jobs/${jobId}/resume`, {}, token))).status).toBe(409);
  await store.put(
    { pk: `OWNER#${address}`, sk: `JOB#${jobId}`, version: 1, job: { ...job, oneSubmissionAllowed: true } },
    0,
  );
  const resumed = await app.request(post(`/jobs/${jobId}/resume`, {}, token));
  expect(resumed.status).toBe(409);
  expect(await resumed.json()).toEqual({
    error: "Reconcile the unknown compute provider submission before retrying.",
    code: "reconcile_required",
  });
  const kept = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))?.job as Job;
  expect(kept.status).toBe("paused");
  expect(kept.oneSubmissionAllowed).toBe(true);
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
  const queued = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))!.job as Job;
  expect(queued.oneSubmissionAllowed).toBeUndefined();
  // The allowance is spent: the same unknown outcome blocks again.
  expect((await app.request(post(`/jobs/${jobId}/resume`, {}, token))).status).toBe(409);
  const again = (await store.get(`OWNER#${address}`, `JOB#${jobId}`))!;
  await store.put(
    { ...again, version: again.version + 1, job: { ...queued, status: "paused", error: job.error } },
    again.version,
  );
  expect((await app.request(post(`/jobs/${jobId}/resume`, {}, token))).status).toBe(409);
});
