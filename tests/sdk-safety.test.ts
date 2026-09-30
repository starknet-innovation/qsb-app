// Regression tests for the review of #91; each one fails without its fix.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { decryptRecovery } from "../src/lib/backup";
import { formatBtc, withdrawalSchema, type Job } from "../src/lib/model";
import { loopbackTestSigner, type PendingDeposit } from "../sdk";
import { runCli } from "../sdk/cli";
import { API, createdVault, fundedVault, localQsb, solvedWithdrawal, wallet, world } from "./sdk-fixture";
import { QsbClient } from "../sdk";
import { Slipstream, type MinerCredential } from "../server/providers";

beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "disposable sdk safety passphrase";
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };

function cli(w: ReturnType<typeof world>, wif: string, extraEnv: Record<string, string> = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
  const { qsb } = localQsb();
  const run = async (...argv: string[]) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    let out = "", err = "";
    stdout.on("data", (c) => (out += c));
    stderr.on("data", (c) => (err += c));
    const code = await runCli(
      ["--signer", "test-key", ...argv],
      {
        env: { QSB_API_URL: API, QSB_HOME: path.join(cwd, "home"), QSB_PASSPHRASE: passphrase, QSB_TEST_SIGNER_KEY: wif, ...extraEnv },
        stdin: Readable.from([]),
        stdout,
        stderr,
        interactive: false,
        cwd,
        fetch: w.fetch,
      },
      qsb,
    );
    return { code, out, err };
  };
  return { run, file: (name: string) => path.join(cwd, name) };
}
/** Change the stored job, as a coordinator or a compromised server could. */
async function editJob(w: ReturnType<typeof world>, owner: string, jobId: string, edit: (job: Job) => void) {
  const row = (await w.store.get(`OWNER#${owner}`, `JOB#${jobId}`))!;
  const job = structuredClone(row.job as Job);
  edit(job);
  await w.store.put({ ...row, version: row.version + 1, job }, row.version);
}
const posts = (w: ReturnType<typeof world>, suffix: string) =>
  w.requests.filter((r) => r.method === "POST" && r.url.endsWith(suffix)).length;

describe("the CLI never overwrites a file", () => {
  it("refuses an output that is an input backup, another output or an existing file, before any work", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const c = cli(w, owner.wif);
    const created = await c.run("vault", "create", "--name", "overwrite", "--backup", "vault.json");
    expect(created.code).toBe(0);
    const { vault } = JSON.parse(created.out);
    const backup = readFileSync(c.file("vault.json"), "utf8");
    writeFileSync(c.file("notes.json"), "keep me");
    const before = w.requests.length;
    const prepare = (...out: string[]) =>
      c.run("deposit", "prepare", vault.id, "--backup", "vault.json", "--amount", "0.002", "--fee-rate", "2",
        "--utxo", `${owner.fundingTxid}:0`, ...out);
    for (const out of [
      ["--out", "vault.json"],
      ["--out", "deposit.json", "--psbt-out", "vault.json"],
      ["--out", "deposit.json", "--psbt-out", "deposit.json"],
      ["--out", "notes.json"],
    ])
      expect((await prepare(...out)).code, out.join(" ")).toBe(2);
    expect(readFileSync(c.file("vault.json"), "utf8")).toBe(backup);
    expect(readFileSync(c.file("notes.json"), "utf8")).toBe("keep me");
    expect(w.requests.length).toBe(before);
    expect((await prepare("--out", "deposit.json")).code).toBe(0);
  }, 120000);

  it("won't write the signed withdrawal over the backup it was assembled from", async () => {
    const s = await solvedWithdrawal(passphrase);
    const c = cli(s.w, s.owner.wif);
    writeFileSync(c.file("withdrawal.json"), s.backups[1]);
    const result = await c.run("withdraw", "assemble", s.job.id, "--backup", "withdrawal.json",
      "--out-backup", "signing.json", "--out", "withdrawal.json");
    expect(result.code).toBe(2);
    expect(readFileSync(c.file("withdrawal.json"), "utf8")).toBe(s.backups[1]);
    expect(existsSync(c.file("signing.json"))).toBe(false);
  }, 120000);
});

describe("withdrawals.submit", () => {
  it("refuses a stored intent that differs from the one bound at assembly, before showing it", async () => {
    const s = await solvedWithdrawal(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
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
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
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
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
    answer = { txid: signed.txid, status: "conflict" };
    const error = await rejection(s.client.withdrawals.submit(signed, { approve: (review) => review.txid }));
    expect(error.message).toContain("Funding outpoint was spent by a different transaction");
    expect(error.message).not.toContain("Unexpected submission response");
    // A conflict reported for another transaction is still unexpected.
    answer = { txid: "00".repeat(32), status: "conflict" };
    await expect(s.client.withdrawals.submit(signed, { approve: (review) => review.txid })).rejects.toThrow("Unexpected submission response");
  }, 120000);

  it("exits non-zero when MARA's answer is lost", async () => {
    const s = await solvedWithdrawal(passphrase);
    const c = cli(s.w, s.owner.wif);
    writeFileSync(c.file("withdrawal.json"), s.backups[1]);
    expect((await c.run("withdraw", "assemble", s.job.id, "--backup", "withdrawal.json", "--out-backup", "signing.json", "--out", "signed.json")).code).toBe(0);
    const { txid } = JSON.parse(readFileSync(c.file("signed.json"), "utf8"));
    s.w.lost.withdrawal = true;
    const result = await c.run("withdraw", "submit", "--signed", "signed.json", "--approve-txid", txid);
    expect(JSON.parse(result.out)).toEqual({ txid, status: "uncertain" });
    expect(result.code).toBe(1);
  }, 120000);
});

// The API answers a failed chain or miner request with a 502 or 503 (docs/API.md). On the
// submission routes that is never a refusal: an earlier attempt may have reached the miner.
const providerFailures = [
  [502, { error: "Unable to complete the request. Please retry.", code: "miner_request_failed" }],
  [503, { error: "Unable to complete the request. Please retry.", code: "miner_unavailable" }],
  [503, { error: "Miner API credential is unavailable. Contact the service operator.", code: "miner_unavailable" }],
  [503, { error: "Unable to complete the request. Please retry.", code: "chain_unavailable" }],
  [503, { error: "Chain lookup failed (500). Retry before signing.", code: "chain_unavailable" }],
  [502, { error: "Unable to complete the request. Please retry.", code: "chain_error" }],
] as const;
/** The miner's credential store is down: Slipstream.credential() rejects with miner_unavailable. */
const unreadableCredential = () =>
  new Slipstream("https://slipstream.mara.com", async () => {
    throw new Error("secret store down");
  }).credential();
/** The error `promise` rejects with; a resolved promise fails the test. */
const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    (value) => {
      throw new Error(`Expected a failure, got ${JSON.stringify(value)}`);
    },
    (error: Error) => error,
  );
/** Record the status of each response whose URL ends with `suffix`. */
function recordStatuses(suffix: string, statuses: number[]) {
  return (next: typeof fetch) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await next(input, init);
    if (String(input).endsWith(suffix)) statuses.push(response.status);
    return response;
  }) as typeof fetch;
}

describe("provider failures on submission stay uncertain", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports every provider-failure 502 and 503 from jobs/:id/submit as uncertain", async () => {
    let answer: (typeof providerFailures)[number] | undefined;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) =>
      answer !== undefined && String(input).endsWith("/submit")
        ? new Response(JSON.stringify(answer[1]), { status: answer[0] })
        : next(input, init)) as typeof fetch);
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
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
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
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
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
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
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
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
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
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
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
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

  it("shows the public configuration and rates without a wallet", async () => {
    const w = world();
    for (const command of ["config", "rates"]) {
      const stdout = new PassThrough();
      let out = "";
      stdout.on("data", (chunk) => (out += chunk));
      const code = await runCli([command], {
        env: { QSB_API_URL: API }, stdin: Readable.from([]), stdout, stderr: new PassThrough(), interactive: false, cwd: tmpdir(), fetch: w.fetch,
      });
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject(command === "config" ? { network: "mainnet" } : { submit_fee_rate: 1 });
    }
    // /v1 by default; --base-path /api reaches the compatibility alias.
    const code = await runCli(["--base-path", "/api", "config"], {
      env: { QSB_API_URL: API }, stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(), interactive: false, cwd: tmpdir(), fetch: w.fetch,
    });
    expect(code).toBe(0);
    expect(w.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/config", "/v1/rates", "/api/config"]);
  });
});

describe("one intent and one assembly per vault on this device", () => {
  it("won't sign a second assembly from an older backup, in a later CLI process", async () => {
    const s = await solvedWithdrawal(passphrase);
    const c = cli(s.w, s.owner.wif);
    writeFileSync(c.file("withdrawal.json"), s.backups[1]);
    expect((await c.run("withdraw", "assemble", s.job.id, "--backup", "withdrawal.json", "--out-backup", "signing.json", "--out", "signed.json")).code).toBe(0);
    // The server now reports another solution. The withdrawal backup doesn't bind one; this device does.
    await editJob(s.w, s.owner.address, s.job.id, (job) => {
      job.solution = { ...job.solution!, locktime: job.solution!.locktime + 1 };
    });
    const again = await c.run("withdraw", "assemble", s.job.id, "--backup", "withdrawal.json", "--out-backup", "signing-2.json", "--out", "signed-2.json");
    expect(again.code).toBe(1);
    expect(again.err).toContain("already authorizes a different withdrawal or assembly");
    expect(existsSync(c.file("signing-2.json"))).toBe(false);
    expect(existsSync(c.file("signed-2.json"))).toBe(false);
  }, 120000);

  it("remembers an intent only once a backup holds it, so a failed save blocks nothing", async () => {
    const f = await fundedVault(passphrase);
    const create = (saveBackup: (text: string) => Promise<void>) =>
      f.client.withdrawals.create({
        vaultId: f.vault.id, backup: f.backups[0], passphrase, helper: { txid: f.owner.fundingTxid, vout: 1 },
        destination: f.destination, feeRate: "3", costAccepted: true, saveBackup,
      });
    await expect(create(async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(posts(f.w, "/v1/jobs")).toBe(0);
    const { job } = await create(f.keep);
    expect(job.status).toBe("queued");
  }, 120000);

  it("asks for --out-backup before any work for a new withdrawal, and doesn't block the retry", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const c = cli(w, owner.wif);
    const { vault } = JSON.parse((await c.run("vault", "create", "--name", "retry", "--backup", "vault.json")).out);
    expect((await c.run("deposit", "prepare", vault.id, "--backup", "vault.json", "--amount", "0.002", "--fee-rate", "2",
      "--utxo", `${owner.fundingTxid}:0`, "--out", "deposit.json")).code).toBe(0);
    const prepared = JSON.parse(readFileSync(c.file("deposit.json"), "utf8"));
    writeFileSync(c.file("signed.psbt"), await loopbackTestSigner(owner.wif, API).signPsbt(owner.address, prepared.psbt, prepared.signInputs));
    const deposit = JSON.parse((await c.run("deposit", "submit", "--prepared", "deposit.json", "--signed", "signed.psbt", "--accept-costs")).out);
    w.chain.mine(deposit.txid);
    const withdraw = (...extra: string[]) =>
      c.run("withdraw", "create", vault.id, "--backup", "vault.json", "--helper", `${owner.fundingTxid}:1`,
        "--destination", owner.address, "--fee-rate", "3", "--accept-costs", ...extra);
    const before = w.requests.length;
    const missing = await withdraw();
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--out-backup");
    expect((await withdraw("--out-backup", "no-such-dir/withdrawal.json")).code).toBe(2);
    expect(w.requests.length).toBe(before);
    expect(existsSync(c.file("home/authorizations"))).toBe(false);
    expect((await withdraw("--out-backup", "withdrawal.json")).code).toBe(0);
    expect(posts(w, "/v1/jobs")).toBe(1);
  }, 120000);

  it("won't make a second intent from the original backup when the first one's job wasn't created", async () => {
    let dropJobs = false;
    const f = await fundedVault(passphrase, {
      wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (dropJobs && String(input).endsWith("/v1/jobs") && init?.method === "POST") throw new TypeError("fetch failed");
        return next(input, init);
      }) as typeof fetch,
    });
    const create = (backup: string) =>
      f.client.withdrawals.create({
        vaultId: f.vault.id, backup, passphrase, helper: { txid: f.owner.fundingTxid, vout: 1 },
        destination: f.destination, feeRate: "3", costAccepted: true, saveBackup: f.keep,
      });
    dropJobs = true;
    const lost = (await create(f.backups[0]).then(() => new Error("created"), (error: Error) => error)) as Error;
    expect(lost.message).toContain("fetch failed");
    expect(lost.message).toContain("retry withdrawals.create with it");
    expect(lost.cause).toBeInstanceOf(TypeError);
    expect(f.backups).toHaveLength(2);
    dropJobs = false;
    // No job exists, but the original backup would bind the same one-time keys to a second payout.
    await expect(create(f.backups[0])).rejects.toThrow("already authorizes a different withdrawal or assembly");
    expect(f.backups).toHaveLength(2);
    expect(posts(f.w, "/v1/jobs")).toBe(0);
    const saved = withdrawalSchema.parse(JSON.parse((await decryptRecovery(f.backups[1], passphrase)).authorization!.manifestJson));
    const { job } = await f.client.withdrawals.create({
      vaultId: f.vault.id, backup: f.backups[1], passphrase, costAccepted: true, saveBackup: f.keep,
    });
    expect(job.id).toBe(saved.idempotencyKey);
  }, 120000);
});

describe("deposits.submit", () => {
  async function signedDeposit(staging: Parameters<typeof createdVault>[1] = {}) {
    const v = await createdVault(passphrase, staging);
    const prepared = await v.client.deposits.prepare(v.vault.id, {
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
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

describe("CLI outcomes", () => {
  it("warns that --approve-txid is non-interactive, shows every value, and still needs the exact txid", async () => {
    const s = await solvedWithdrawal(passphrase);
    const c = cli(s.w, s.owner.wif);
    writeFileSync(c.file("withdrawal.json"), s.backups[1]);
    expect((await c.run("withdraw", "assemble", s.job.id, "--backup", "withdrawal.json", "--out-backup", "signing.json", "--out", "signed.json")).code).toBe(0);
    const { txid, rawTxHex } = JSON.parse(readFileSync(c.file("signed.json"), "utf8"));
    const tx = btc.Transaction.fromRaw(Buffer.from(rawTxHex, "hex"), opts);
    const payout = tx.getOutput(0).amount!;
    const fee = BigInt(s.job.manifest.funding.value) + BigInt(s.job.manifest.helper.value) - payout;
    const shown = (err: string) => {
      expect(err).toContain("--approve-txid approves non-interactively");
      expect(err).toContain(`Transaction ID: ${txid}`);
      expect(err).toContain(`Destination:    ${s.destination}`);
      expect(err).toContain(`Payout:         ${formatBtc(payout)} BTC (${payout.toLocaleString("en-US")} sats)`);
      expect(err).toContain(`Miner fee:      ${formatBtc(fee)} BTC (${fee.toLocaleString("en-US")} sats)`);
      expect(err).toMatch(/Fee rate: {7}\d+\.\d{2} sat\/vB over \d+ vB/);
    };
    const wrong = await c.run("withdraw", "submit", "--signed", "signed.json", "--approve-txid", txid.replace(/^./, (x: string) => (x === "0" ? "1" : "0")));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("not approved");
    shown(wrong.err);
    expect(posts(s.w, `/jobs/${s.job.id}/submit`)).toBe(0);
    const right = await c.run("withdraw", "submit", "--signed", "signed.json", "--approve-txid", txid);
    expect(right.code).toBe(0);
    shown(right.err);
    expect(right.err.indexOf("non-interactively")).toBeLessThan(right.err.indexOf("submitted:"));
    expect(posts(s.w, `/jobs/${s.job.id}/submit`)).toBe(1);
  }, 120000);

  it("exits non-zero while a deposit's outcome is unclear, and says when a resume wrote no backup", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const c = cli(w, owner.wif);
    const { vault } = JSON.parse((await c.run("vault", "create", "--name", "outcomes", "--backup", "vault.json")).out);
    expect((await c.run("deposit", "prepare", vault.id, "--backup", "vault.json", "--amount", "0.002", "--fee-rate", "2",
      "--utxo", `${owner.fundingTxid}:0`, "--out", "deposit.json")).code).toBe(0);
    const signer = loopbackTestSigner(owner.wif, API);
    const prepared = JSON.parse(readFileSync(c.file("deposit.json"), "utf8"));
    writeFileSync(c.file("signed.psbt"), await signer.signPsbt(owner.address, prepared.psbt, prepared.signInputs));
    w.lost.deposit = true;
    expect((await c.run("deposit", "submit", "--prepared", "deposit.json", "--signed", "signed.psbt", "--accept-costs")).code).toBe(1);
    const unclear = await c.run("deposit", "resubmit", vault.id);
    expect(JSON.parse(unclear.out).submission).toBe("uncertain");
    expect(unclear.code).toBe(1);
    w.lost.deposit = false;
    const resent = await c.run("deposit", "resubmit", vault.id);
    expect(JSON.parse(resent.out).submission).toBe("submitted");
    expect(resent.code).toBe(0);
    w.chain.mine(JSON.parse(resent.out).txid);
    expect((await c.run("deposit", "status", vault.id)).code).toBe(0);
    const destination = owner.address;
    expect((await c.run("withdraw", "create", vault.id, "--backup", "vault.json", "--out-backup", "withdrawal.json",
      "--helper", `${owner.fundingTxid}:1`, "--destination", destination, "--fee-rate", "3", "--accept-costs")).code).toBe(0);
    const resumed = await c.run("withdraw", "create", vault.id, "--backup", "withdrawal.json", "--out-backup", "unused.json", "--accept-costs");
    expect(resumed.code).toBe(0);
    expect(resumed.err).toContain("Resumed the intent saved in withdrawal.json; no new backup was written.");
    expect(existsSync(c.file("unused.json"))).toBe(false);
  }, 120000);
});

describe("per-owner limits (#89)", () => {
  /** Answer POSTs to `route` with one refusal while `answer` is set; everything else reaches the app. */
  const intercept = (route: RegExp, holder: { answer?: { status: number; body: unknown } }) => (next: typeof fetch) =>
    (async (input: RequestInfo | URL, init?: RequestInit) =>
      holder.answer && init?.method === "POST" && route.test(new URL(String(input)).pathname)
        ? new Response(JSON.stringify(holder.answer.body), { status: holder.answer.status })
        : next(input, init)) as typeof fetch;

  it("refuses before generating anything when the wallet isn't allowlisted", async () => {
    const w = world({ ownerLimits: { allowlist: new Set(["bc1qsomeoneelse"]), maxActiveJobs: null, maxGpuSeconds: null } });
    const owner = wallet(w.chain);
    const client = new QsbClient({ baseUrl: API, signer: loopbackTestSigner(owner.wif, API), fetch: w.fetch, qsb: localQsb().qsb });
    await client.login();
    expect((await client.config()).ownerLimits).toEqual({ allowlist: true, allowlisted: false, maxActiveJobs: null, maxGpuSeconds: null });
    const saveBackup = vi.fn(async () => {});
    await expect(client.vaults.create({ name: "not allowed", passphrase, saveBackup })).rejects.toThrow(
      "isn't on this deployment's allowlist (owner_not_allowlisted). Nothing was changed.",
    );
    expect(saveBackup).not.toHaveBeenCalled();
    expect(posts(w, "/v1/vaults")).toBe(0);
  }, 120000);

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
      backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
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

  it("reports a withdrawal refused by an owner limit as final, keeping the backup that holds its intent", async () => {
    const holder: { answer?: { status: number; body: unknown } } = {};
    const f = await fundedVault(passphrase, { wrap: intercept(/^\/v1\/jobs(\/[0-9a-f-]{36}\/resume)?$/, holder) });
    const create = (backup: string, fresh = true) =>
      f.client.withdrawals.create({
        vaultId: f.vault.id, backup, passphrase, costAccepted: true, saveBackup: f.keep,
        ...(fresh ? { helper: { txid: f.owner.fundingTxid, vout: 1 }, destination: f.destination, feeRate: "3" } : {}),
      });
    holder.answer = { status: 429, body: { error: "This wallet already has 1 withdrawal queued or searching.", code: "owner_active_withdrawal_limit" } };
    await expect(create(f.backups[0])).rejects.toThrow(
      /refused to create the search \(owner_active_withdrawal_limit\).*Nothing was reserved\. The new backup holds this intent/,
    );
    holder.answer = { status: 503, body: { error: "This deployment's owner limits are misconfigured. Nothing was changed.", code: "owner_limits_invalid" } };
    await expect(create(f.backups[1], false)).rejects.toThrow("per-owner limits are misconfigured; contact the operator");
    holder.answer = undefined;
    const { job } = await create(f.backups[1], false);
    await f.client.withdrawals.pause(job.id);
    holder.answer = { status: 429, body: { error: "GPU budget reached.", code: "owner_gpu_budget_reached" } };
    await expect(f.client.withdrawals.resume(job.id)).rejects.toThrow("refused to resume the search (owner_gpu_budget_reached)");
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
        backup: v.backups[0], passphrase, amount: 200000n, feeRate: "2", utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
      }),
    ).rejects.toThrow("per-owner limits are misconfigured (owner_limits_invalid)");
    expect(v.w.requests.slice(before).map((r) => new URL(r.url).pathname)).toEqual(["/v1/config"]);
  }, 120000);

  it("prints the server's code with a CLI error", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const result = await cli(w, owner.wif).run("withdraw", "status", crypto.randomUUID());
    expect(result.code).toBe(1);
    expect(result.err).toContain("qsb: Job not found (job_not_found)");
  }, 120000);
});

describe("API keys (#87)", () => {
  it("authenticates the CLI with an API key that appears only in the Authorization header", async () => {
    const w = world({ apiKeys: true });
    const owner = wallet(w.chain);
    const session = new QsbClient({ baseUrl: API, signer: loopbackTestSigner(owner.wif, API), fetch: w.fetch, qsb: localQsb().qsb });
    await session.login();
    // The owner mints a key once with a wallet session; keys can't mint keys.
    const minted = (await (
      await w.fetch(`${API}/v1/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ name: "sdk test", scopes: ["read", "vaults"], expiresInDays: 1 }),
      })
    ).json()) as { key: string };
    expect(minted.key).toMatch(/^qsb_mainnet_[A-Za-z0-9_-]{43}$/);
    const before = w.requests.length;
    const c = cli(w, owner.wif, { QSB_API_KEY: minted.key });
    const outputs: string[] = [];
    for (const argv of [["vault", "create", "--name", "keyed", "--backup", "vault.json"], ["vault", "list"]]) {
      const result = await c.run(...argv);
      expect(result.code, result.err).toBe(0);
      outputs.push(result.out, result.err);
    }
    const keyed = w.requests.slice(before);
    expect(keyed.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toContain("POST /v1/vaults");
    // No wallet sign-in, and the key only ever as the bearer credential.
    expect(keyed.some((r) => r.url.includes("/auth/"))).toBe(false);
    for (const request of w.requests) {
      const { authorization, ...others } = request.headers;
      if (keyed.includes(request)) expect(authorization).toBe(`Bearer ${minted.key}`);
      const elsewhere = `${request.url}\n${decodeURIComponent(request.url)}\n${JSON.stringify(others)}\n${request.body}`;
      expect(elsewhere.includes(minted.key)).toBe(false);
    }
    for (const output of outputs) expect(output.includes(minted.key)).toBe(false);
    expect(existsSync(c.file("home/session.json"))).toBe(false);
    // Never from arguments, and never echoed in a refusal.
    const argv = await cli(w, owner.wif).run("--api-key", minted.key, "vault", "list");
    expect(argv.code).toBe(2);
    expect(argv.err.includes(minted.key)).toBe(false);
    const testnet = `qsb_testnet4_${minted.key.slice("qsb_mainnet_".length)}`;
    const wrong = await cli(w, owner.wif, { QSB_API_KEY: testnet }).run("vault", "list");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("isn't a mainnet key");
    expect(wrong.err.includes(testnet)).toBe(false);
  }, 120000);
});
