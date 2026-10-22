import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { decryptRecovery } from "../src/lib/backup";
import { QsbClient, loopbackTestSigner, nodeQsb, type LocalQsb } from "../sdk";
import { runCli } from "../sdk/cli";
import { API, wallet, world } from "./sdk-fixture";

beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "disposable supplied state passphrase";

type Generated = Awaited<ReturnType<LocalQsb["generateQsb"]>>;
/** State made outside the client under test, as a caller's own generator would. */
let generated: Generated;
beforeAll(async () => {
  const qsb = nodeQsb();
  generated = await qsb.generateQsb();
  qsb.lockQsb();
}, 60000);

const replaceOnce = (text: string, from: string, to: string) => {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
};
const hash160 = (bytes: Uint8Array) => hex.encode(ripemd160(sha256(bytes)));
const derived = (field: string) =>
  new RegExp(`^${field.replace(/[[\].]/g, "\\$&")} is not what the pipeline builds from these HORS secrets$`);
/**
 * Mismatched states and what the bridge says about each. The edits are made on the JSON text: the
 * state holds 256-bit integers (pin_r, pin_s, pin_k, each round's r, s and k) that JavaScript numbers round.
 */
function edits(stateJson: string): [string, string, RegExp][] {
  const state = JSON.parse(stateJson) as { hors_secrets: string[][]; hors_commitments: string[][]; full_script_hex: string };
  const secret = hex.encode(randomBytes(20));
  const script = state.full_script_hex;
  // The secret and its commitment agree, but the script still holds the old commitment.
  const swapped = replaceOnce(
    replaceOnce(stateJson, `"${state.hors_secrets[0][5]}"`, `"${secret}"`),
    `"${state.hors_commitments[0][5]}"`,
    `"${hash160(hex.decode(secret))}"`,
  );
  return [
    ["a tampered secret", replaceOnce(stateJson, `"${state.hors_secrets[0][17]}"`, `"${secret}"`), derived("hors_commitments[0][17]")],
    ["a tampered commitment", replaceOnce(stateJson, `"${state.hors_commitments[1][3]}"`, `"${hash160(randomBytes(20))}"`), derived("hors_commitments[1][3]")],
    ["a script the commitments don't build", swapped, derived("full_script_hex")],
    ["an edited script", replaceOnce(stateJson, `"${script}"`, `"${script.slice(0, -2)}${script.endsWith("00") ? "01" : "00"}"`), derived("full_script_hex")],
    ["integers rounded by JavaScript", JSON.stringify(JSON.parse(stateJson)), derived("pin_r")],
    ["a changed type", replaceOnce(stateJson, '"t1b": 1,', '"t1b": true,'), derived("t1b")],
    ["a private field", stateJson.replace(/^\{/, '{"pin_privkey": 1, '), /^pin_privkey is not a field the pipeline produces$/],
    ["a private round field", replaceOnce(stateJson, '"round_sigs": [{', '"round_sigs": [{"seed": "00", '), /^round_sigs\[0\]\.seed is not a field the pipeline produces$/],
    ["a missing field", stateJson.replace(/"dummy_sigs": \[\[[^\]]*\], \[[^\]]*\]\], /, ""), /^dummy_sigs is missing$/],
    ["a repeated secret", replaceOnce(stateJson, `"${state.hors_secrets[1][9]}"`, `"${state.hors_secrets[0][2]}"`), /^A HORS secret repeats$/],
    ["an uppercase secret", replaceOnce(stateJson, `"${state.hors_secrets[0][0]}"`, `"${state.hors_secrets[0][0].toUpperCase()}"`), /^Each HORS secret is 20 bytes of lowercase hex$/],
    ["another configuration", replaceOnce(stateJson, '"n": 150,', '"n": 140,'), /^Unsupported recovery configuration$/],
    ["no secrets", replaceOnce(stateJson, '"hors_secrets"', '"secrets"'), /^Invalid secret count$/],
    ["not an object", "[]", /^The recovery state is not a JSON object$/],
  ];
}

describe("adoptQsb in the SDK's bundled runtime", () => {
  it("returns exactly what generateQsb returned for a state, and names what differs in any other", async () => {
    const qsb = nodeQsb();
    try {
      expect(await qsb.adoptQsb(generated.stateJson)).toEqual(generated);
      // Key order and whitespace aren't part of the state.
      const reordered = replaceOnce(generated.stateJson, '{"config": "A", ', "{\n  ").replace(/\}$/, ', "config": "A"}');
      expect(await qsb.adoptQsb(reordered)).toEqual(generated);
      for (const [label, stateJson, message] of edits(generated.stateJson))
        await expect(qsb.adoptQsb(stateJson), label).rejects.toThrow(message);
    } finally {
      qsb.lockQsb();
    }
  }, 60000);
});

/** A replaced runtime that would wave anything through, or fail if it were asked at all. */
function replacedRuntime() {
  return {
    generateQsb: vi.fn(async () => {
      throw new Error("the replaced runtime generated state");
    }),
    validateRecovery: vi.fn(async () => {
      throw new Error("the replaced runtime validated state");
    }),
    assembleQsb: vi.fn(async () => {
      throw new Error("the replaced runtime assembled");
    }),
    lockQsb: vi.fn(),
  } satisfies LocalQsb;
}
const vaultPosts = (w: ReturnType<typeof world>) =>
  w.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/vaults");

describe("vaults.create with a supplied state", () => {
  async function signedIn(qsb: LocalQsb = replacedRuntime()) {
    const w = world();
    const owner = wallet(w.chain);
    const signer = loopbackTestSigner(owner.wif, API);
    const client = new QsbClient({ baseUrl: API, signer, fetch: w.fetch, qsb });
    await client.login();
    return { w, owner, signer, client };
  }

  it("registers the state's vault, checked and re-opened by the bundled runtime, not the qsb option", async () => {
    const qsb = replacedRuntime();
    const { w, owner, signer, client } = await signedIn(qsb);
    const saveBackup = vi.fn(async (_: string) => {});
    const { vault, backup } = await client.vaults.create({ name: "own state", passphrase, saveBackup, stateJson: generated.stateJson });
    expect(saveBackup).toHaveBeenCalledExactlyOnceWith(backup);
    expect([vault.scriptHex, vault.scriptHash, vault.publicStateJson]).toEqual([generated.scriptHex, generated.scriptHash, generated.publicStateJson]);
    expect((await decryptRecovery(backup, passphrase)).stateJson).toBe(generated.stateJson);
    for (const call of [qsb.generateQsb, qsb.validateRecovery, qsb.assembleQsb, qsb.lockQsb]) expect(call).not.toHaveBeenCalled();
    // Only the public record went to the server.
    const [posted] = vaultPosts(w);
    for (const value of ["hors_secrets", "pin_k", '"k"', generated.stateJson, passphrase, ...JSON.parse(generated.stateJson).hors_secrets.flat()])
      expect(posted.body.includes(value), value).toBe(false);
    // The backup works like a generated vault's from here on.
    const usual = new QsbClient({ baseUrl: API, signer, fetch: w.fetch, token: client.token });
    const prepared = await usual.deposits.prepare(vault.id, {
      backup,
      passphrase,
      amount: 200000n,
      feeRate: "2",
      utxos: [{ txid: owner.fundingTxid, vout: 0 }],
    });
    expect(prepared.scriptHash).toBe(generated.scriptHash);
  }, 120000);

  it("refuses a state that isn't what the pipeline builds from its secrets, before saving or sending it", async () => {
    const { w, client } = await signedIn();
    const saveBackup = vi.fn(async () => {});
    const requests = w.requests.length;
    for (const [label, stateJson, message] of edits(generated.stateJson)) {
      const error = await client.vaults.create({ name: "bad state", passphrase, saveBackup, stateJson }).then(
        () => new Error(`${label} was accepted`),
        (e: Error) => e,
      );
      const reason = /^The supplied recovery state was refused: (.+)\. Nothing was saved or registered\.$/.exec(error.message);
      expect(reason?.[1], `${label}: ${error.message}`).toMatch(message);
    }
    expect(saveBackup).not.toHaveBeenCalled();
    // Each attempt read only the deployment's configuration.
    expect(w.requests.slice(requests).every((r) => r.method === "GET" && r.url.endsWith("/v1/config"))).toBe(true);
    expect(vaultPosts(w)).toHaveLength(0);
  }, 120000);

  it("refuses a state whose script already locks a vault of this address", async () => {
    const { w, client } = await signedIn();
    const saveBackup = vi.fn(async () => {});
    const { vault } = await client.vaults.create({ name: "first", passphrase, saveBackup, stateJson: generated.stateJson });
    await expect(client.vaults.create({ name: "second", passphrase, saveBackup, stateJson: generated.stateJson })).rejects.toThrow(
      `This recovery state already locks vault ${vault.id}. A state locks one vault, which takes one deposit; nothing was saved or registered.`,
    );
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(vaultPosts(w)).toHaveLength(1);
  }, 120000);
});

describe("qsb vault create --state", () => {
  it("creates the vault from a state file, and refuses one that doesn't match or is also the backup", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
    writeFileSync(path.join(cwd, "state.json"), generated.stateJson);
    const [, tampered] = edits(generated.stateJson)[0];
    writeFileSync(path.join(cwd, "tampered.json"), tampered);
    async function qsb(...argv: string[]) {
      const stdout = new PassThrough(), stderr = new PassThrough();
      let out = "", err = "";
      stdout.on("data", (chunk) => (out += chunk));
      stderr.on("data", (chunk) => (err += chunk));
      const env = { QSB_API_URL: API, QSB_HOME: path.join(cwd, "home"), QSB_PASSPHRASE: passphrase, QSB_TEST_SIGNER_KEY: owner.wif };
      const code = await runCli(["--signer", "test-key", ...argv], { env, stdin: Readable.from([]), stdout, stderr, interactive: false, cwd, fetch: w.fetch });
      return { code, out, err };
    }
    const reused = await qsb("vault", "create", "--name", "cli", "--backup", "state.json", "--state", "state.json");
    expect(reused.code).toBe(2);
    expect(reused.err).toContain("state.json is used twice");
    const refused = await qsb("vault", "create", "--name", "cli", "--backup", "refused.json", "--state", "tampered.json");
    expect(refused.code, refused.err).toBe(1);
    expect(refused.err).toContain("The supplied recovery state was refused: hors_commitments[0][17] is not what the pipeline builds");
    expect(existsSync(path.join(cwd, "refused.json"))).toBe(false);
    expect(vaultPosts(w)).toHaveLength(0);

    const created = await qsb("vault", "create", "--name", "cli", "--backup", "vault.json", "--state", "state.json");
    expect(created.code, created.err).toBe(0);
    expect(created.err).toContain("state.json still holds the recovery state unencrypted");
    const { vault } = JSON.parse(created.out);
    expect(vault.scriptHash).toBe(generated.scriptHash);
    expect((await decryptRecovery(readFileSync(path.join(cwd, "vault.json"), "utf8"), passphrase)).stateJson).toBe(generated.stateJson);
  }, 120000);
});
