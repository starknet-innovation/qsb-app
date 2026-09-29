import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { decryptRecovery } from "../src/lib/backup";
import { release, type Job, type PublicVault } from "../src/lib/model";
import capability from "../server/mainnet-capability.json";
import { runCli } from "../sdk/cli";
import { loopbackTestSigner } from "../sdk";
import { API, localQsb, solve, wallet, world, type Recorded } from "./sdk-fixture";

// Every request must go through the recording transport: anything else fails the test.
const stray: string[] = [];
beforeEach(() => {
  vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id);
  vi.stubGlobal("fetch", async (input: unknown) => {
    stray.push(String(input));
    throw new Error("Unrecorded request");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const passphrase = "disposable sdk e2e passphrase";
/** An owner-only file's text, checked and read through one descriptor. */
function readOwnerOnly(file: string): string {
  const fd = openSync(file, "r");
  try {
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Encodings a leak could use: as-is, JSON-escaped, base64, and upper/lowercase hex. */
function text(value: string) {
  return [value, JSON.stringify(value).slice(1, -1), base64.encode(new TextEncoder().encode(value))];
}
function bytes(hexValue: string) {
  return [hexValue.toLowerCase(), hexValue.toUpperCase(), base64.encode(hex.decode(hexValue))];
}
/**
 * What must stay on the caller's machine. A QSB spend reveals the HORS preimages of the
 * solution's signed indices in its scriptSig (cmd_assemble pushes the first t1s = 8 and
 * t2s = 7 sorted indices of each round): the webapp submits the same bytes, and that is why
 * a vault is assembled only once. So those preimages may appear in the withdrawal submit and
 * the miner submission, and nowhere else. The other 285 secrets, the nonces (pin_k and each
 * round's k, which bridge.py keeps out of the public state), the whole state, the passphrase,
 * the key and the backups themselves must never appear anywhere. The assembler double puts a
 * placeholder in the scriptSig, so here the revealed preimages appear nowhere at all.
 */
async function secrets(backups: string[], wif: string, privateKey: Uint8Array, solution: NonNullable<Job["solution"]>) {
  const recovery = await decryptRecovery(backups[0], passphrase);
  const state = JSON.parse(recovery.stateJson) as { hors_secrets: string[][] };
  const nonces = [...recovery.stateJson.matchAll(/"(?:pin_k|k)":\s*(\d+)/g)].map((m) => m[1]);
  expect(nonces).toHaveLength(3);
  const signed = [solution.round1, solution.round2].map((round, r) =>
    [...round].sort((a, b) => a - b).slice(0, r === 0 ? 8 : 7).map((i) => state.hors_secrets[r][i]),
  );
  const revealed = new Set(signed.flat());
  const unrevealed = state.hors_secrets.flat().filter((secret) => !revealed.has(secret));
  expect([revealed.size, unrevealed.length]).toEqual([15, 285]);
  const never = [
    ...text(recovery.stateJson),
    ...text(JSON.stringify(recovery)),
    "hors_secrets",
    ...unrevealed.flatMap(bytes),
    ...nonces.flatMap((n) => [n, ...bytes(BigInt(n).toString(16).padStart(64, "0"))]),
    ...text(passphrase),
    ...text(wif),
    ...bytes(hex.encode(privateKey)),
    // The encrypted backups are never uploaded either.
    ...backups.map((backup) => JSON.parse(backup).ciphertext as string),
  ];
  return { never, revealed: [...revealed].flatMap(bytes) };
}
function assertNothingLeaks(requests: Recorded[], values: { never: string[]; revealed: string[] }) {
  expect(requests.length).toBeGreaterThan(10);
  for (const request of requests) {
    const sent = `${request.method} ${request.url}\n${decodeURIComponent(request.url)}\n${JSON.stringify(request.headers)}\n${request.body}`;
    const withdrawal = request.method === "POST" && /\/api\/jobs\/[0-9a-f-]{36}\/submit$/.test(new URL(request.url).pathname);
    for (const value of [...values.never, ...(withdrawal ? [] : values.revealed)])
      expect(sent.includes(value), `${request.method} ${request.url}`).toBe(false);
  }
}

it("drives vault creation, deposit, withdrawal, local assembly and approved submit through the CLI without sending a secret", async () => {
  expect(release.mainnetEnabled).toBe(false);
  expect(capability.broadcastAuthorized).toBe(false);
  const w = world();
  const owner = wallet(w.chain);
  const destination = btc.p2wpkh(secp256k1.getPublicKey(randomBytes(32), true)).address!;
  const { qsb, assembled } = localQsb();
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
  const home = path.join(cwd, "home");
  const printed: string[] = [];
  async function qsbCli(...argv: string[]) {
    const stdout = new PassThrough(), stderr = new PassThrough();
    let out = "", err = "";
    stdout.on("data", (chunk) => (out += chunk));
    stderr.on("data", (chunk) => (err += chunk));
    const code = await runCli(
      argv,
      {
        env: { QSB_API_URL: API, QSB_HOME: home, QSB_PASSPHRASE: passphrase, QSB_TEST_SIGNER_KEY: owner.wif },
        stdin: Readable.from([]),
        stdout,
        stderr,
        interactive: false,
        cwd,
        fetch: w.fetch,
      },
      qsb,
    );
    printed.push(out, err);
    return { code, out, err, json: () => JSON.parse(out) };
  }
  const ok = async (...argv: string[]) => {
    const result = await qsbCli("--signer", "test-key", ...argv);
    expect(result.code, result.err).toBe(0);
    return result.json();
  };

  // Sign-in caches only the bearer token, owner-only.
  expect((await qsbCli("--signer", "test-key", "login")).code).toBe(0);
  const session = path.join(home, "session.json");
  expect(Object.keys(JSON.parse(readOwnerOnly(session))).sort()).toEqual([
    "address", "api", "expiresAt", "format", "network", "token",
  ]);

  // Vault creation: generated locally, the backup written owner-only, only public state registered.
  const { vault } = (await ok("vault", "create", "--name", "cli e2e", "--backup", "vault.json")) as { vault: PublicVault };
  readOwnerOnly(path.join(cwd, "vault.json"));
  expect((await ok("vault", "list")).vaults.map((v: PublicVault) => v.id)).toEqual([vault.id]);
  // A backup is never overwritten.
  expect((await qsbCli("--signer", "test-key", "vault", "create", "--name", "again", "--backup", "vault.json")).code).toBe(2);

  // Deposit: an unsigned PSBT, signed outside the CLI (here by the test key), relayed by the server.
  const prepared = await ok(
    "deposit", "prepare", vault.id, "--backup", "vault.json", "--amount", "0.002", "--fee-rate", "2",
    "--utxo", `${owner.fundingTxid}:0`, "--out", "deposit.json",
  );
  expect(prepared.amount).toBe("200000");
  const external = loopbackTestSigner(owner.wif, API);
  const unsigned = readFileSync(path.join(cwd, "deposit.psbt"), "utf8").trim();
  writeFileSync(path.join(cwd, "deposit-signed.psbt"), await external.signPsbt(owner.address, unsigned, prepared.signInputs));
  const deposit = await ok("deposit", "submit", "--prepared", "deposit.json", "--signed", "deposit-signed.psbt", "--accept-costs");
  expect(deposit.submission).toBe("submitted");
  expect(w.minerSubmissions).toHaveLength(1);
  expect(existsSync(path.join(home, "pending-deposits", `${vault.id}.json`))).toBe(false);
  // One deposit per vault.
  expect((await qsbCli("--signer", "test-key", "deposit", "prepare", vault.id, "--backup", "vault.json",
    "--amount", "0.001", "--fee-rate", "2", "--utxo", `${owner.fundingTxid}:1`, "--out", "again.json")).code).toBe(1);
  w.chain.mine(deposit.txid);
  expect((await ok("deposit", "status", vault.id)).vault.status).toBe("confirmed");

  // Withdrawal creation: the payout is bound into a new backup before the search is created.
  const created = await ok(
    "withdraw", "create", vault.id, "--backup", "vault.json", "--out-backup", "withdrawal.json",
    "--helper", `${owner.fundingTxid}:1`, "--destination", destination, "--fee-rate", "3", "--accept-costs",
  );
  const job = created.job as Job;
  expect(job).toMatchObject({ status: "queued", vaultId: vault.id });
  expect(job.manifest.destination).toBe(destination);
  expect(BigInt(job.manifest.outputValue) + BigInt(job.manifest.fee)).toBe(250000n);
  readOwnerOnly(path.join(cwd, "withdrawal.json"));
  // Creating it again from the same backup resumes the same intent.
  expect((await ok("withdraw", "create", vault.id, "--backup", "withdrawal.json", "--accept-costs")).job.id).toBe(job.id);

  // Hours later, in another process: the coordinator publishes the solution; assemble from backup + job id.
  const solution = await solve(w.store, owner.address, job.id);
  expect((await qsbCli("--signer", "test-key", "withdraw", "assemble", job.id, "--backup", "withdrawal.json", "--out", "signed.json")).code).toBe(2);
  const signedOut = await ok(
    "withdraw", "assemble", job.id, "--backup", "withdrawal.json", "--out-backup", "signing.json", "--out", "signed.json",
  );
  const signed = JSON.parse(readFileSync(path.join(cwd, "signed.json"), "utf8"));
  expect(signed).toMatchObject({ format: "qsb-coordinator-public-signed-result-v1", jobId: job.id, txid: signedOut.txid, helperSighash: "SIGHASH_ALL" });
  const recovery = await decryptRecovery(readFileSync(path.join(cwd, "vault.json"), "utf8"), passphrase);
  expect(assembled.at(-1)).toEqual({ state: recovery.stateJson, manifest: job.manifest, solution });
  // The signing backup binds the exact transaction; reusing it assembles the same bytes.
  expect((await ok("withdraw", "assemble", job.id, "--backup", "signing.json", "--out", "signed-again.json")).txid).toBe(signed.txid);

  // Submit needs an explicit approval bound to the txid.
  const submitsBefore = w.requests.filter((r) => r.url.endsWith("/submit")).length;
  const unapproved = await qsbCli("--signer", "test-key", "withdraw", "submit", "--signed", "signed.json");
  expect(unapproved.code).toBe(2);
  expect(unapproved.err).toContain(`Transaction ID: ${signed.txid}`);
  expect(unapproved.err).toContain(`Destination:    ${destination}`);
  expect((await qsbCli("--signer", "test-key", "withdraw", "submit", "--signed", "signed.json", "--approve-txid", "ab".repeat(32))).code).toBe(1);
  expect(w.requests.filter((r) => r.url.endsWith("/submit")).length).toBe(submitsBefore);
  const submitted = await ok("withdraw", "submit", "--signed", "signed.json", "--approve-txid", signed.txid);
  expect(submitted).toEqual({ txid: signed.txid, status: "submitted" });
  expect(w.consensus.verified).toEqual([signed.rawTxHex]);
  expect(w.minerSubmissions.at(-1)).toBe(signed.rawTxHex);
  w.chain.mine(signed.txid);
  expect((await ok("withdraw", "status", job.id)).job.status).toBe("confirmed");

  const backups = ["vault.json", "withdrawal.json", "signing.json"].map((f) => readOwnerOnly(path.join(cwd, f)));
  const values = await secrets(backups, owner.wif, owner.privateKey, solution);
  assertNothingLeaks(w.requests, values);
  // The deposit, then the withdrawal: only the withdrawal may carry the revealed preimages.
  expect(w.minerSubmissions).toHaveLength(2);
  expect(btc.Transaction.fromRaw(hex.decode(w.minerSubmissions[0]), { allowUnknownInputs: true, allowUnknownOutputs: true }).id).toBe(deposit.txid);
  expect(w.minerSubmissions[1]).toBe(signed.rawTxHex);
  for (const [i, raw] of w.minerSubmissions.entries())
    for (const value of [...values.never, ...(i === 0 ? values.revealed : [])]) expect(raw.includes(value)).toBe(false);
  // Nor in the session cache or anything the CLI printed.
  for (const local of [readOwnerOnly(session), ...printed])
    for (const value of [...values.never, ...values.revealed]) expect(local.includes(value)).toBe(false);
  expect(stray).toEqual([]);
  for (const route of ["POST /api/vaults", "POST /api/vaults/*/fund/submit", "POST /api/jobs", "POST /api/jobs/*/submit"])
    expect(
      w.requests.some((r) => `${r.method} ${new URL(r.url).pathname.replace(/[0-9a-f-]{36}/g, "*")}` === route),
      route,
    ).toBe(true);
}, 120000);
