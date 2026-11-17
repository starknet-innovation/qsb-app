import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runCli } from "../sdk/cli";
import { API, managedProviders, solve, wallet, world } from "./sdk-fixture";
import { pqbFixture } from "./solver-fixture";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, pqbFixture } = await import("./solver-fixture");
  return { default: [servedFixture, pqbFixture] };
});

vi.mock("../sdk/public-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("../sdk/public-runtime")>();
  const { publicPlannerDouble } = await import("./sdk-planner-double");
  return { publicRuntime: () => publicPlannerDouble(actual.publicRuntime()) };
});
beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id));
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("runs the external-agent CLI with durable authorization and approved submission (uncertain=%s)", async uncertain => {
  // Hermetic chain/miner and public planner double: this is not a real GPU solve or mainnet spend.
  const w = world(), owner = wallet(w.chain), manager = await managedProviders(w, owner);
  const descriptor = await manager.generate("PQB");
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-agent-e2e-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const agent = path.join(cwd, "external-agent.mjs");
  // Keep the shebang argument-free: Linux passes everything after the interpreter as ONE
  // argument, unlike macOS. Register the TS loader before dynamically importing test helpers.
  writeFileSync(agent, `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
register();
const { loopbackTestSigner } = await import(${JSON.stringify(path.join(root, "tests/test-signer.ts"))});
const { localQsb } = await import(${JSON.stringify(path.join(root, "tests/sdk-fixture.ts"))});
const request = JSON.parse(readFileSync(0, 'utf8'));
const { operation, input, context } = request;
const dir = process.env.AGENT_JOURNAL; mkdirSync(dir, { recursive: true });
const file = key => path.join(dir, Buffer.from(key).toString('hex'));
const get = key => { try { return readFileSync(file(key), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
let result;
if(operation === 'credentials.get') result = process.env.AGENT_TOKEN;
else if(operation === 'custody.confirmVault') result = true;
else if(operation === 'authorizations.get') result = get(input.key);
else if(operation === 'authorizations.claim') {
  try { writeFileSync(file(input.key), input.value, { flag: 'wx', mode: 0o600 }); }
  catch(e) { if(e.code !== 'EEXIST' || get(input.key) !== input.value) throw e; }
  result = true;
} else if(operation === 'custody.authorizeWithdrawal') {
  result = await localQsb().qsb.assembleQsb('', input.solved.manifest, input.solved.solution);
} else if(operation === 'wallet.signPsbt') {
  result = await loopbackTestSigner(process.env.AGENT_TEST_WIF, context.baseUrl).signPsbt(input.address, input.psbt, input.inputs);
} else throw Error('Unknown operation');
console.log(JSON.stringify({ result }));
`, { mode: 0o700 });
  writeFileSync(path.join(cwd, "descriptor.json"), JSON.stringify(descriptor));
  const run = async (...argv: string[]) => {
    const stdout = new PassThrough(), stderr = new PassThrough(); let out = "", err = "";
    stdout.on("data", c => out += c); stderr.on("data", c => err += c);
    const code = await runCli(argv, { cwd, interactive: false, stdin: Readable.from([]), stdout, stderr, fetch: w.fetch,
      env: { ...process.env, QSB_API_URL: API, QSB_AGENT: agent, QSB_ADDRESS: owner.address, QSB_PUBLIC_KEY: manager.signer.publicKey,
        QSB_HOME: path.join(cwd, "public-state"), AGENT_JOURNAL: path.join(cwd, "external-journal"),
        AGENT_TOKEN: manager.session.currentToken(), AGENT_TEST_WIF: owner.wif } });
    return { code, out, err };
  };
  const created = await run("vault", "create", "--name", "external", "--descriptor", "descriptor.json");
  expect(created.code, created.err).toBe(0); const { vault } = JSON.parse(created.out);
  const prepared = await run("deposit", "prepare", vault.id, "--amount", "0.002", "--fee-rate", "2", "--utxo", `${owner.fundingTxid}:0`, "--out", "deposit.json");
  expect(prepared.code, prepared.err).toBe(0);
  const d = JSON.parse(prepared.out);
  writeFileSync(path.join(cwd, "signed.psbt"), await manager.signer.signPsbt(owner.address, d.psbt, d.signInputs));
  const deposited = await run("deposit", "submit", "--prepared", "deposit.json", "--signed", "signed.psbt", "--accept-costs");
  expect(deposited.code, deposited.err).toBe(0); w.chain.mine(JSON.parse(deposited.out).txid);
  const requested = await run("withdraw", "create", vault.id, "--helper", `${owner.fundingTxid}:1`, "--destination", owner.address, "--fee-rate", "3", "--accept-costs");
  expect(requested.code, requested.err).toBe(0); const { job } = JSON.parse(requested.out);
  expect((await run("withdraw", "create", vault.id, "--accept-costs")).code).toBe(0);
  await solve(w.store, owner.address, job.id);
  const row = (await w.store.get(`OWNER#${owner.address}`, `JOB#${job.id}`))!;
  const stored = row.job as import("../src/lib/model").Job;
  await w.store.put({ ...row, version: row.version + 1, job: { ...stored, solution: {
    ...stored.solution!, round1: [0,1,2,3,4,5,6,7], round2: [8,9,10,11,12,13,14,15,16],
    pqb: { pinning: "2147483648 500000000 0 0 0 1", round0: "0,1,2,3,4,5,6,7 0 0 0 1", round1: "0,1,2,3,4,5,6,7,8 0 0 0 1" },
  } } }, row.version);
  expect((await run("withdraw", "prepare", job.id, "--out", "request.json")).code).toBe(0);
  const assembled = await run("withdraw", "assemble", job.id, "--out", "signed.json");
  expect(assembled.code, assembled.err).toBe(0);
  const before = w.requests.length;
  expect((await run("withdraw", "assemble", job.id, "--out", "signed.json")).code).toBe(2);
  expect(w.requests.length).toBe(before);
  const signed = JSON.parse(assembled.out);
  expect((await run("withdraw", "submit", "--signed", "signed.json", "--approve-txid", "00".repeat(32))).code).toBe(1);
  w.lost.withdrawal = uncertain;
  const submitted = await run("withdraw", "submit", "--signed", "signed.json", "--approve-txid", signed.txid);
  expect(submitted.code, submitted.err).toBe(uncertain ? 1 : 0);
  expect(JSON.parse(submitted.out).status).toBe(uncertain ? "uncertain" : "submitted");
  expect(submitted.err).toContain("Payout:"); expect(submitted.err).toContain("Fee:");
  expect(existsSync(path.join(cwd, "public-state/session.json"))).toBe(false);
  const state = manager.state.get(descriptor.scriptHash)!;
  for (const r of w.requests) {
    expect(r.body).not.toContain(state); expect(r.body).not.toContain(owner.wif);
    expect(r.body).not.toContain('"hors_secrets"');
  }
  expect(readFileSync(path.join(cwd, "descriptor.json"), "utf8")).not.toContain(state);
}, 120000);

it("rejects retired secret options without printing their values", async () => {
  const stderr = new PassThrough(); let err = ""; stderr.on("data", c => err += c);
  const io = { cwd: tmpdir(), interactive: false, env: {}, stdin: Readable.from([]), stdout: new PassThrough(), stderr };
  for (const option of ["--passphrase", "--passphrase-fd", "--state", "--backup", "--api-key", "--signer"])
    expect(await runCli(["vault", "create", option, "do-not-echo"], io)).toBe(2);
  expect(err).not.toContain("do-not-echo");
});
