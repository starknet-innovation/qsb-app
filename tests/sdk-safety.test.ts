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

beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "disposable sdk safety passphrase";
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };

function cli(w: ReturnType<typeof world>, wif: string) {
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
        env: { QSB_API_URL: API, QSB_HOME: path.join(cwd, "home"), QSB_PASSPHRASE: passphrase, QSB_TEST_SIGNER_KEY: wif },
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

describe("Codex review of #91", () => {
  it("won't submit while operations are off, even with exact submission on", async () => {
    let operationsOff = false;
    const s = await solvedWithdrawal(passphrase, (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await next(input, init);
      if (!operationsOff || !String(input).endsWith("/api/config")) return response;
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
    expect(posts(f.w, "/api/jobs")).toBe(0);
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
    expect(posts(w, "/api/jobs")).toBe(1);
  }, 120000);

  it("won't make a second intent from the original backup when the first one's job wasn't created", async () => {
    let dropJobs = false;
    const f = await fundedVault(passphrase, {
      wrap: (next) => (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (dropJobs && String(input).endsWith("/api/jobs") && init?.method === "POST") throw new TypeError("fetch failed");
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
    expect(posts(f.w, "/api/jobs")).toBe(0);
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
    // An earlier signing of the same deposit: the same txid, other witness bytes.
    const earlier = { txid: tx.id, amount: d.prepared.amount, rawTxHex: `${tx.hex.slice(0, -10)}00${tx.hex.slice(-8)}` };
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
