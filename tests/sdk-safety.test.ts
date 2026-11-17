// Public planner doubles replace GPU solves; submission checks still use the real API and wallet signatures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import type { Job } from "../src/lib/model";
import type { PendingDeposit } from "../sdk/index";
import { createdVault, solvedWithdrawal, world } from "./sdk-fixture";
import { Slipstream, type MinerCredential } from "../server/providers";
vi.mock("../sdk/public-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("../sdk/public-runtime")>();
  const { publicPlannerDouble } = await import("./sdk-planner-double");
  return { publicRuntime: () => publicPlannerDouble(actual.publicRuntime()) };
});
beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "unused compatibility argument";
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
async function editJob(w: ReturnType<typeof world>, owner: string, jobId: string, edit: (job: Job) => void) {
  const row = (await w.store.get(`OWNER#${owner}`, `JOB#${jobId}`))!;
  const job = structuredClone(row.job as Job);
  edit(job);
  await w.store.put({ ...row, version: row.version + 1, job }, row.version);
}
const providerFailures = [
  [502, { error: "Unable to complete the request. Please retry.", code: "miner_request_failed" }],
  [503, { error: "Unable to complete the request. Please retry.", code: "miner_unavailable" }],
  [503, { error: "Miner API credential is unavailable. Contact the service operator.", code: "miner_unavailable" }],
  [503, { error: "Unable to complete the request. Please retry.", code: "chain_unavailable" }],
  [503, { error: "Chain lookup failed (500). Retry before signing.", code: "chain_unavailable" }],
  [502, { error: "Unable to complete the request. Please retry.", code: "chain_error" }],
] as const;
const unreadableCredential = () =>
  new Slipstream("https://slipstream.mara.com", async () => {
    throw new Error("secret store down");
  }).credential();
const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    (value) => {
      throw new Error(`Expected a failure, got ${JSON.stringify(value)}`);
    },
    (error: Error) => error,
  );
function recordStatuses(suffix: string, statuses: number[]) {
  return (next: typeof fetch) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await next(input, init);
    if (String(input).endsWith(suffix)) statuses.push(response.status);
    return response;
  }) as typeof fetch;
}
const posts = (w: ReturnType<typeof world>, suffix: string) => w.requests.filter(r => r.method === "POST" && r.url.endsWith(suffix)).length;
describe("withdrawals.submit", () => {
it("refuses a stored intent that differs from the one bound at assembly, before showing it", async () => {
    const s = await solvedWithdrawal(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    // The QSB input doesn't commit to its amount, so a lower funding value still balances, with a lower fee.
    await editJob(s.w, s.owner.address, s.job.id, (job) => {
      job.manifest.funding.value = String(BigInt(job.manifest.funding.value) - 1000n);
      job.manifest.fee = String(BigInt(job.manifest.fee) - 1000n);
    });
    const approve = vi.fn((review: { txid: string }) => review.txid);
    await expect(s.client.withdrawals.submit(signed, { approve })).rejects.toThrow("differs from the one bound at assembly");
    expect(approve).not.toHaveBeenCalled();
    expect(posts(s.w, `/jobs/${s.job.id}/submit`)).toBe(0);
  }, 120000);
it("treats only the server's disabled refusal as final; any other 503 is uncertain", async () => {
    let answer: unknown;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
      answer !== undefined && String(input).endsWith("/submit")
        ? new Response(JSON.stringify(answer), { status: 503 })
        : next(input, init)) as typeof fetch);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    for (const [body, outcome] of [
      [{ message: "Service Unavailable" }, "uncertain"],
      [{ error: "Service Unavailable" }, "uncertain"],
      [{ error: "Miner API credential is unavailable. Contact the service operator.", code: "miner_unavailable" }, "uncertain"],
      [{ error: "Miner request failed (502)", code: "miner_request_failed" }, "uncertain"],
      [{ error: "Unable to complete the request. Please retry.", code: "internal_error" }, "uncertain"],
      // Without the code, even the server's exact message could come from a gateway or an older server.
      [{ error: "mainnet withdrawals are disabled." }, "uncertain"],
      [{ error: "Exact submission is disabled." }, "uncertain"],
      [{ error: "mainnet withdrawals are disabled.", code: "submit_disabled" }, "disabled"],
      [{ error: "Exact submission is disabled.", code: "submit_disabled" }, "disabled"],
    ] as const) {
      answer = body;
      await expect(
        s.client.withdrawals.submit(signed, { approve: (review) => review.txid }),
        JSON.stringify(body),
      ).rejects.toThrow(outcome === "disabled" ? "Submission is disabled" : "outcome is uncertain");
    }
  }, 120000);
it("names a conflicting spend instead of reporting an unexpected response", async () => {
    let answer: unknown;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
      answer !== undefined && String(input).endsWith("/submit")
        ? new Response(JSON.stringify(answer), { status: 200 })
        : next(input, init)) as typeof fetch);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    answer = { txid: signed.txid, status: "conflict" };
    const error = await rejection(s.client.withdrawals.submit(signed, { approve: (review) => review.txid }));
    expect(error.message).toContain("Funding outpoint was spent by a different transaction");
    expect(error.message).not.toContain("Unexpected submission response");
    // A conflict reported for another transaction is still unexpected.
    answer = { txid: "00".repeat(32), status: "conflict" };
    await expect(s.client.withdrawals.submit(signed, { approve: (review) => review.txid })).rejects.toThrow("Unexpected submission response");
  }, 120000);
});
describe("provider failures on submission stay uncertain", () => {
afterEach(() => vi.unstubAllGlobals());
it("reports every provider-failure 502 and 503 from jobs/:id/submit as uncertain", async () => {
    let answer: (typeof providerFailures)[number] | undefined;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
      answer !== undefined && String(input).endsWith("/submit")
        ? new Response(JSON.stringify(answer[1]), { status: answer[0] })
        : next(input, init)) as typeof fetch);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    for (const failure of providerFailures) {
      answer = failure;
      const error = await rejection(s.client.withdrawals.submit(signed, { approve: (review) => review.txid }));
      expect(error.message, JSON.stringify(failure)).toContain("outcome is uncertain");
      expect(error.message, JSON.stringify(failure)).not.toContain("Submission is disabled");
    }
  }, 120000);
it("keeps the deposit pending on every provider-failure 502 and 503 from fund/submit", async () => {
    const pending = new Map<string, PendingDeposit>();
    let answer: (typeof providerFailures)[number] | undefined;
    const v = await createdVault(passphrase, {
      wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
        answer !== undefined && String(input).endsWith("/fund/submit")
          ? new Response(JSON.stringify(answer[1]), { status: answer[0] })
          : next(input, init)) as typeof fetch,
      options: {
        pendingDeposits: {
          get: async (id) => pending.get(id),
          set: async (id, deposit) => void pending.set(id, deposit),
          delete: async (id) => void pending.delete(id),
        },
      },
    });
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    for (const failure of providerFailures) {
      answer = failure;
      const error = await rejection(v.client.deposits.submit(prepared, signed, { costAccepted: true }));
      expect(error.message, JSON.stringify(failure)).toContain("isn't confirmed");
      expect(error.message, JSON.stringify(failure)).not.toContain("The deployment refused");
      expect(pending.get(v.vault.id), JSON.stringify(failure)).toBeDefined();
    }
  }, 120000);
it("keeps a deposit pending through the server's real 503 and 502 miner failures, then resends only its bytes", async () => {
    const pending = new Map<string, PendingDeposit>();
    const statuses: number[] = [];
    const v = await createdVault(passphrase, {
      wrap: recordStatuses("/fund/submit", statuses),
      options: {
        pendingDeposits: {
          get: async (id) => pending.get(id),
          set: async (id, deposit) => void pending.set(id, deposit),
          delete: async (id) => void pending.delete(id),
        },
      },
    });
    const miner = v.w.miner as unknown as Record<string, unknown>;
    const { credential, seen } = miner;
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    // The credential can't be read: 503 miner_unavailable, before anything is recorded or sent.
    miner.credential = unreadableCredential;
    await expect(v.client.deposits.submit(prepared, signed, { costAccepted: true })).rejects.toThrow("isn't confirmed");
    expect(statuses).toEqual([503]);
    expect(pending.get(v.vault.id)).toBeDefined();
    expect(v.w.minerSubmissions).toEqual([]);
    // MARA's answer to the POST is lost: recorded, still pending.
    miner.credential = credential;
    v.w.lost.deposit = true;
    expect((await v.client.deposits.resubmit(v.vault.id)).submission).toBe("uncertain");
    expect(pending.get(v.vault.id)).toBeDefined();
    // The resend's check with MARA fails: 502 miner_request_failed, and no second POST.
    v.w.lost.deposit = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const mara = new Slipstream("https://slipstream.mara.com", async () => undefined);
    miner.seen = (id: string, held: MinerCredential) => mara.seen(id, held);
    await expect(v.client.deposits.resubmit(v.vault.id)).rejects.toThrow("isn't confirmed");
    expect(statuses).toEqual([503, 201, 502]);
    expect(pending.get(v.vault.id)).toBeDefined();
    expect(v.w.minerSubmissions).toEqual([]);
    // Once MARA answers, the same bytes go out once.
    miner.seen = seen;
    const { txid } = pending.get(v.vault.id)!;
    expect((await v.client.deposits.resubmit(v.vault.id)).submission).toBe("submitted");
    expect(pending.get(v.vault.id)).toBeUndefined();
    expect(v.w.minerSubmissions).toHaveLength(1);
    expect(btc.Transaction.fromRaw(Buffer.from(v.w.minerSubmissions[0], "hex"), opts).id).toBe(txid);
  }, 120000);
it("reports the server's real 503 on jobs/:id/submit as uncertain, with no intent recorded", async () => {
    const statuses: number[] = [];
    const s = await solvedWithdrawal(passphrase, recordStatuses(`/submit`, statuses));
    const signed = await s.client.withdrawals.assemble(s.job.id);
    const before = statuses.length;
    (s.w.miner as unknown as Record<string, unknown>).credential = unreadableCredential;
    await expect(s.client.withdrawals.submit(signed, { approve: (review) => review.txid })).rejects.toThrow("outcome is uncertain");
    expect(statuses.slice(before)).toEqual([503]);
    expect(await s.w.store.list(`OWNER#${s.owner.address}`, "TX#")).toEqual([]);
    expect(s.w.minerSubmissions).toHaveLength(1); // the deposit only
  }, 120000);
});
describe("Codex review of #91", () => {
it("won't submit while operations are off, even with exact submission on", async () => {
    let operationsOff = false;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await next(input, init);
      if (!operationsOff || !String(input).endsWith("/v1/config")) return response;
      return new Response(JSON.stringify({ ...(await response.json()), operationsEnabled: false, exactSubmitEnabled: true }));
    }) as typeof fetch);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    operationsOff = true;
    const approve = vi.fn((review: { txid: string }) => review.txid);
    await expect(s.client.withdrawals.submit(signed, { approve })).rejects.toThrow("Transactions are disabled");
    expect(approve).not.toHaveBeenCalled();
    expect(posts(s.w, `/jobs/${s.job.id}/submit`)).toBe(0);
  }, 120000);
it("keeps a pending deposit unless the answer is about this vault and these bytes", async () => {
    const pending = new Map<string, PendingDeposit>();
    let answer: unknown;
    const v = await createdVault(passphrase, {
      wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
        answer !== undefined && String(input).endsWith("/fund/submit")
          ? new Response(JSON.stringify(answer), { status: 201 })
          : next(input, init)) as typeof fetch,
      options: {
        pendingDeposits: {
          get: async (id) => pending.get(id),
          set: async (id, deposit) => void pending.set(id, deposit),
          delete: async (id) => void pending.delete(id),
        },
      },
    });
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    const other = { ...v.vault, id: crypto.randomUUID() };
    for (const body of [{}, { submission: "submitted" }, { vault: other, submission: "rejected" }, { vault: v.vault, submission: "submitted" }]) {
      answer = body;
      await expect(v.client.deposits.submit(prepared, signed, { costAccepted: true }), JSON.stringify(body)).rejects.toThrow("isn't confirmed");
      expect(pending.get(v.vault.id)).toBeDefined();
    }
    answer = undefined;
    expect((await v.client.deposits.resubmit(v.vault.id)).submission).toBe("submitted");
    expect(pending.get(v.vault.id)).toBeUndefined();
  }, 120000);
});
describe("deposits.submit", () => {
async function signedDeposit(staging: Parameters<typeof createdVault>[1] = {}) {
    const v = await createdVault(passphrase, staging);
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    return { ...v, prepared, signed };
  }
it("checks MARA's floor again right before sending", async () => {
    const d = await signedDeposit();
    d.w.rates.market_rate = 5;
    await expect(d.client.deposits.submit(d.prepared, d.signed, { costAccepted: true })).rejects.toThrow("below MARA's current minimum");
    expect(posts(d.w, "/fund/submit")).toBe(0);
    d.w.rates.market_rate = 2;
    expect((await d.client.deposits.submit(d.prepared, d.signed, { costAccepted: true })).submission).toBe("submitted");
  }, 120000);
it("never replaces the waiting deposit's bytes with a re-signed copy", async () => {
    const pending = new Map<string, PendingDeposit>();
    const d = await signedDeposit({
      options: {
        pendingDeposits: {
          get: async (id) => pending.get(id),
          set: async (id, deposit) => void pending.set(id, deposit),
          delete: async (id) => void pending.delete(id),
        },
      },
    });
    const tx = btc.Transaction.fromPSBT(base64.decode(d.signed), opts);
    tx.finalize();
    // An earlier signing of the same deposit: the same txid, other witness bytes. Flip the last
    // witness byte (the random key's last byte); overwriting it with a constant can leave it unchanged.
    const flipped = (parseInt(tx.hex.slice(-10, -8), 16) ^ 1).toString(16).padStart(2, "0");
    const earlier = { txid: tx.id, amount: d.prepared.amount, rawTxHex: `${tx.hex.slice(0, -10)}${flipped}${tx.hex.slice(-8)}` };
    expect(earlier.rawTxHex).not.toBe(tx.hex);
    pending.set(d.vault.id, earlier);
    await expect(d.client.deposits.submit(d.prepared, d.signed, { costAccepted: true })).rejects.toThrow("already waiting");
    expect(pending.get(d.vault.id)).toEqual(earlier);
    expect(posts(d.w, "/fund/submit")).toBe(0);
  }, 120000);
});
describe("per-owner limits (#89)", () => {
const intercept = (route: RegExp, holder: { answer?: { status: number; body: unknown } }) => (next: typeof fetch) =>
    (async (input: RequestInfo | URL, init?: RequestInit) =>
      holder.answer && init?.method === "POST" && route.test(new URL(String(input)).pathname)
        ? new Response(JSON.stringify(holder.answer.body), { status: holder.answer.status })
        : next(input, init)) as typeof fetch;
it("reports a deposit refused by an owner limit as final for that request, and keeps its bytes pending", async () => {
    const holder: { answer?: { status: number; body: unknown } } = {};
    const pending = new Map<string, PendingDeposit>();
    const v = await createdVault(passphrase, {
      wrap: intercept(/\/fund\/(submit|resubmit)$/, holder),
      options: {
        pendingDeposits: {
          get: async (id) => pending.get(id),
          set: async (id, deposit) => void pending.set(id, deposit),
          delete: async (id) => void pending.delete(id),
        },
      },
    });
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    holder.answer = { status: 403, body: { error: "This wallet is not on this deployment's allowlist.", code: "owner_not_allowlisted" } };
    const error = (await v.client.deposits.submit(prepared, signed, { costAccepted: true }).then(() => new Error("sent"), (e: Error) => e)) as Error;
    expect(error.message).toContain("refused the deposit (owner_not_allowlisted)");
    expect(error.message).toContain("Nothing was written or sent by this request");
    expect(error.message).not.toContain("isn't confirmed");
    expect(pending.get(v.vault.id)).toBeDefined();
    holder.answer = { status: 503, body: { error: "This deployment's owner limits are misconfigured. Nothing was changed.", code: "owner_limits_invalid" } };
    await expect(v.client.deposits.resubmit(v.vault.id)).rejects.toThrow("per-owner limits are misconfigured; contact the operator");
    holder.answer = undefined;
    expect((await v.client.deposits.resubmit(v.vault.id)).submission).toBe("submitted");
  }, 120000);
it("reports a deposit refused because another vault holds the script as final, and sends nothing", async () => {
    const v = await createdVault(passphrase);
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
    });
    const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
    // The operator's backfill gave this vault's script to another vault row.
    const key = `SCRIPT#${v.vault.scriptHash}|RESERVATION`;
    v.w.store.rows.set(key, { ...v.w.store.rows.get(key)!, vaultId: "00000000-0000-4000-8000-000000000000" });
    const error = (await v.client.deposits.submit(prepared, signed, { costAccepted: true }).then(() => new Error("sent"), (e: Error) => e)) as Error;
    expect(error.message).toContain("refused the deposit (vault_script_registered)");
    expect(error.message).toContain("Nothing was written or sent by this request");
    expect(error.message).toContain("Don't resend this deposit or sign another for this vault.");
    // An earlier send may still confirm, so the backup still matters.
    expect(error.message).toContain("If it was sent before, it may still confirm: deposits.status shows it once it's mined, so keep this vault's backup.");
    expect(error.message).not.toContain("isn't confirmed");
    // The pending deposit is dropped: nothing for this vault can be resent, and the server's own
    // resend gets the same final answer.
    await expect(v.client.deposits.resubmit(v.vault.id)).rejects.toThrow("refused to resend the deposit (vault_script_registered)");
    // And a new deposit is refused before anything is signed.
    expect((await v.client.vaults.list()).noDeposit).toEqual([v.vault.id]);
    await expect(
      v.client.deposits.prepare(v.vault.id, {
        amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
      }),
    ).rejects.toThrow("so this vault takes no deposit. Nothing was prepared; don't pay into its script.");
    expect(v.w.minerSubmissions).toEqual([]);
  }, 120000);
it("stops before any work when the deployment reports misconfigured owner limits", async () => {
    let broken = false;
    const v = await createdVault(passphrase, {
      wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await next(input, init);
        if (!broken || !String(input).endsWith("/v1/config")) return response;
        return new Response(JSON.stringify({ ...(await response.json()), ownerLimits: null }));
      }) as typeof fetch,
    });
    broken = true;
    const before = v.w.requests.length;
    await expect(
      v.client.deposits.prepare(v.vault.id, {
        amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
      }),
    ).rejects.toThrow("per-owner limits are misconfigured (owner_limits_invalid)");
    expect(v.w.requests.slice(before).map((r) => new URL(r.url).pathname)).toEqual(["/v1/config"]);
  }, 120000);
});
