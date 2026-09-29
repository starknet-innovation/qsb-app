import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Signer as Bip322 } from "bip322-js";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { decryptRecovery } from "../src/lib/backup";
import { transactionVsize } from "../src/lib/transactions";
import { ApiRequestError, QsbClient, loopbackTestSigner, type WithdrawalReview } from "../sdk";
import { runCli } from "../sdk/cli";
import type { CliIo } from "../sdk/cli-io";
import { API, localQsb, solvedWithdrawal as solved, world } from "./sdk-fixture";

beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "disposable sdk client passphrase";
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const newAddress = () => btc.p2wpkh(secp256k1.getPublicKey(randomBytes(32), true)).address!;

describe("withdrawals.submit approval", () => {
  it("shows the exact values bound to the txid and sends nothing without that approval", async () => {
    const s = await solved(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id, {
      backup: s.backups[1],
      passphrase,
      saveBackup: s.keep,
    });
    const submits = () => s.w.requests.filter((r) => r.url.endsWith(`/jobs/${s.job.id}/submit`)).length;
    await expect(s.client.withdrawals.submit(signed, {} as never)).rejects.toThrow("approve callback");
    for (const answer of [undefined, false, true, "ab".repeat(32), signed.txid.toUpperCase()])
      await expect(s.client.withdrawals.submit(signed, { approve: () => answer as string })).rejects.toThrow("not approved");
    expect(submits()).toBe(0);

    // What the callback sees is derived from the signed bytes and the stored job, not from the file.
    const tx = btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), opts);
    const output = tx.getOutput(0);
    const fee = BigInt(s.job.manifest.funding.value) + BigInt(s.job.manifest.helper.value) - output.amount!;
    const vsize = transactionVsize(signed.rawTxHex);
    const seen: WithdrawalReview[] = [];
    const result = await s.client.withdrawals.submit(signed, {
      approve: async (review) => {
        seen.push(review);
        expect(submits()).toBe(0);
        return review.txid;
      },
    });
    expect(seen).toEqual([
      {
        network: "mainnet",
        jobId: s.job.id,
        vaultId: s.vault.id,
        txid: tx.id,
        destination: btc.Address(btc.NETWORK).encode(btc.OutScript.decode(output.script!)),
        outputValue: output.amount!.toString(),
        fee: fee.toString(),
        vsize,
        feeRate: Number((fee * 1000n) / BigInt(vsize)) / 1000,
        minerMinimumFeeRate: 2,
      },
    ]);
    expect(seen[0].destination).toBe(s.destination);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(result).toEqual({ txid: tx.id, status: "submitted" });
    expect(submits()).toBe(1);
    // A second submit stops before asking: the withdrawal already has its transaction.
    const approve = vi.fn(() => signed.txid);
    await expect(s.client.withdrawals.submit(signed, { approve })).rejects.toThrow("already submitted");
    expect(approve).not.toHaveBeenCalled();
    expect(submits()).toBe(1);
  }, 120000);

  it("refuses a signed result whose transaction was edited, before asking for approval", async () => {
    const s = await solved(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id, { backup: s.backups[1], passphrase, saveBackup: s.keep });
    const payout = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(s.destination)));
    const redirected = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(newAddress())));
    expect(signed.rawTxHex.split(payout)).toHaveLength(2);
    const approve = vi.fn(() => signed.txid);
    await expect(
      s.client.withdrawals.submit({ ...signed, rawTxHex: signed.rawTxHex.replace(payout, redirected) }, { approve }),
    ).rejects.toThrow("differs from the approved intent");
    expect(approve).not.toHaveBeenCalled();
  }, 120000);
});

describe("local test signer", () => {
  const key = randomBytes(32);
  it("works only with a loopback API", () => {
    for (const api of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"])
      expect(loopbackTestSigner(key, api).loopbackOnly).toBe(true);
    for (const api of ["https://qsb.example", "https://127.0.0.1.example", "http://192.168.1.2:8787", "https://user:pw@localhost"])
      expect(() => loopbackTestSigner(key, api)).toThrow();
    const signer = loopbackTestSigner(key, API);
    expect(() => new QsbClient({ baseUrl: "https://qsb.example", signer })).toThrow("loopback");
    // Nor through a local relay: the challenge it would sign names the deployment's own origin.
    expect(() => new QsbClient({ baseUrl: API, appOrigin: "https://qsb.example", signer })).toThrow("loopback app origin");
  });
  it("is refused by the CLI for a remote API before any request", async () => {
    const fetch = vi.fn();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c) => (err += c));
    const code = await runCli(["--signer", "test-key", "vault", "list"], {
      env: { QSB_API_URL: "https://qsb.example", QSB_TEST_SIGNER_KEY: btc.WIF().encode(key) },
      stdin: Readable.from([]),
      stdout: new PassThrough(),
      stderr,
      interactive: false,
      cwd: tmpdir(),
      fetch: fetch as never,
    });
    expect(code).toBe(1);
    expect(err).toContain("loopback");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("client boundaries", () => {
  const signer = loopbackTestSigner(randomBytes(32), API);
  const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  it("signs only the app's session-only sign-in message", async () => {
    const signMessage = vi.spyOn(signer, "signMessage");
    const client = new QsbClient({
      baseUrl: API,
      signer,
      fetch: respond({ id: crypto.randomUUID(), message: "Transfer all funds to the operator" }) as never,
    });
    await expect(client.login()).rejects.toThrow("Nothing was signed");
    expect(signMessage).not.toHaveBeenCalled();
  });
  it("signs a challenge only when it names the expected app origin", async () => {
    const challenge = (origin: string) =>
      `QSB Vault sign-in\nOrigin: ${origin}\nAddress: ${signer.address}\nNetwork: bitcoin-mainnet\nNonce: ${crypto.randomUUID()}\nExpires: ${new Date().toISOString()}\nThis signature authorizes this session only. It does not authorize a Bitcoin transaction.`;
    const serving = (origin: string) =>
      (async (url: string) =>
        new Response(JSON.stringify(url.endsWith("/challenge") ? { id: crypto.randomUUID(), message: challenge(origin) } : { token: "T".repeat(43) }))) as never;
    const signMessage = vi.spyOn(signer, "signMessage");
    signMessage.mockClear();
    // A relayed challenge from another deployment is refused.
    await expect(new QsbClient({ baseUrl: API, signer, fetch: serving("https://qsb.example") }).login()).rejects.toThrow("Nothing was signed");
    expect(signMessage).not.toHaveBeenCalled();
    await new QsbClient({ baseUrl: API, signer, fetch: serving(API) }).login();
    // A wallet signer (not loopback-only) signs in to a deployment whose app origin is set explicitly.
    const wallet = { ...signer, loopbackOnly: undefined };
    await new QsbClient({ baseUrl: "https://api.qsb.example", appOrigin: "https://qsb.example/", signer: wallet, fetch: serving("https://qsb.example") }).login();
    expect(signMessage).toHaveBeenCalledTimes(2);
  });
  it("carries a machine-readable code when the server sends one", async () => {
    const coded = new QsbClient({ baseUrl: API, signer, fetch: respond({ error: "Vault not found", code: "vault_not_found" }, 404) as never });
    await expect(coded.vaults.list()).rejects.toMatchObject({ name: "ApiRequestError", status: 404, code: "vault_not_found", message: "Vault not found" });
    const plain = new QsbClient({ baseUrl: API, signer, fetch: respond({ error: "Session expired. Please reconnect." }, 401) as never });
    const error = await plain.vaults.list().catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, code: undefined });
  });
  it("sends every request to the configured origin and base path, without following redirects", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const recording = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return new Response(JSON.stringify({ network: "mainnet" }));
    }) as never;
    const wallet = { ...signer, loopbackOnly: undefined };
    await new QsbClient({ baseUrl: "https://qsb.example/app", signer: wallet, fetch: recording }).config();
    // The /api compatibility alias still works.
    await new QsbClient({ baseUrl: "https://qsb.example/app", basePath: "/api", signer: wallet, fetch: recording }).config();
    expect(seen.map(([url]) => url)).toEqual(["https://qsb.example/app/v1/config", "https://qsb.example/app/api/config"]);
    expect(seen.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(() => new QsbClient({ baseUrl: API, basePath: "/v2" as never, signer })).toThrow("/v1 or /api");
    expect(() => new QsbClient({ baseUrl: "http://qsb.example", signer: wallet })).toThrow("https");
  });
});

describe("CLI secrets and the external signer", () => {
  function io(w: ReturnType<typeof world>, cwd: string, env: Record<string, string>, stdin: NodeJS.ReadableStream = Readable.from([])) {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const out = { stdout: "", stderr: "" };
    stdout.on("data", (c) => (out.stdout += c));
    stderr.on("data", (c) => (out.stderr += c));
    const cli: CliIo = { env: { QSB_API_URL: API, QSB_HOME: path.join(cwd, "home"), ...env }, stdin, stdout, stderr, interactive: false, cwd, fetch: w.fetch };
    return { cli, out };
  }
  it("never takes a passphrase from arguments", async () => {
    const w = world();
    const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
    const { cli, out } = io(w, cwd, { QSB_TEST_SIGNER_KEY: btc.WIF().encode(randomBytes(32)) });
    expect(await runCli(["--signer", "test-key", "vault", "create", "--name", "x", "--backup", "b.json", "--passphrase", "hunter2hunter2hunter2"], cli)).toBe(2);
    expect(out.stderr).toContain("Unknown option '--passphrase'");
    expect(out.stderr).not.toContain("hunter2");
    expect(await runCli(["--signer", "test-key", "vault", "create", "--name", "x", "--backup", "b.json"], cli)).toBe(2);
    expect(out.stderr).toContain("--passphrase-fd");
    expect(w.requests).toEqual([]);
    expect(existsSync(path.join(cwd, "b.json"))).toBe(false);
  });
  it("signs in and authorizes the helper through files and stdin, never holding the key", async () => {
    const s = await solved(passphrase);
    const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
    writeFileSync(path.join(cwd, "withdrawal.json"), s.backups[1]);
    const { qsb } = localQsb();
    const env = { QSB_ADDRESS: s.owner.address, QSB_PUBLIC_KEY: s.signer.publicKey, QSB_PASSPHRASE: passphrase };
    // Sign-in: the challenge goes to stderr and the file; the signature comes back on stdin.
    const stdin = new PassThrough();
    const login = io(s.w, cwd, env, stdin);
    let signedIn = false;
    const answered = new Promise<void>((resolve) =>
      login.cli.stderr.on("data", () => {
        if (signedIn || !existsSync(path.join(cwd, "challenge.txt"))) return;
        signedIn = true;
        const message = readFileSync(path.join(cwd, "challenge.txt"), "utf8");
        stdin.write(`${Bip322.sign(s.owner.wif, s.owner.address, message)}\n`);
        resolve();
      }),
    );
    expect(await runCli(["login", "--message-out", "challenge.txt"], login.cli)).toBe(0);
    await answered;
    expect(login.out.stderr).toContain("authorizes no transaction");
    // Assembly writes the unsigned helper PSBT and stops; the wallet signs it; a re-run finishes.
    const first = io(s.w, cwd, env);
    expect(await runCli(["withdraw", "assemble", s.job.id, "--backup", "withdrawal.json", "--out-backup", "signing.json",
      "--out", "signed.json", "--psbt-out", "helper.psbt"], first.cli, qsb), first.out.stderr).toBe(3);
    expect(first.out.stderr).toContain("--signed-psbt");
    expect(first.out.stderr).toContain("--backup signing.json");
    const unsigned = readFileSync(path.join(cwd, "helper.psbt"), "utf8").trim();
    writeFileSync(path.join(cwd, "helper-signed.psbt"), await s.signer.signPsbt(s.owner.address, unsigned, [0]));
    const second = io(s.w, cwd, env);
    expect(await runCli(["withdraw", "assemble", s.job.id, "--backup", "signing.json", "--out", "signed.json",
      "--psbt-out", "helper.psbt", "--signed-psbt", "helper-signed.psbt"], second.cli, qsb), second.out.stderr).toBe(0);
    expect(readFileSync(path.join(cwd, "helper.psbt"), "utf8").trim()).toBe(unsigned);
    const signed = JSON.parse(readFileSync(path.join(cwd, "signed.json"), "utf8"));
    expect(signed.helperSignatureVerified).toBe(true);
    const recovery = await decryptRecovery(s.backups[0], passphrase);
    for (const request of s.w.requests) {
      const sent = `${request.url}${JSON.stringify(request.headers)}${request.body}`;
      for (const value of [recovery.stateJson, passphrase, s.owner.wif, ...JSON.parse(recovery.stateJson).hors_secrets.flat()])
        expect(sent.includes(value)).toBe(false);
    }
  }, 120000);
});
