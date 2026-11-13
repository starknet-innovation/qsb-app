/** Offline script-interpreter component check; nonexistent public outpoints, no RPC or broadcast. */
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, mkdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import fixture from "../../tests/fixtures/pqb-reference.json";
import { adoptPqb, assemblePqb } from "../../src/lib/pqb";
import { coordinatorPublicSolvedResult } from "../../src/mainnet/coordinatorResult";
import type { Job } from "../../src/lib/model";
import { mutateCoSignature } from "./consensus-signature";
import { retainedContext } from "./consensus-retained";

const dir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || dir === process.cwd() || dir.startsWith(process.cwd() + path.sep))
  throw Error("Use an evidence directory outside Git");
const retainedMode = process.argv[3] === "--retained-transaction";
if (process.argv.length !== (retainedMode ? 5 : 3)) throw Error("Use DIRECTORY [--retained-transaction FRESH_OUTPUT_DIRECTORY]");
const output = retainedMode ? path.resolve(process.argv[4]) : dir;
if (retainedMode && (!output.startsWith(dir + path.sep) || output.startsWith(process.cwd() + path.sep)))
  throw Error("Use a fresh follow-up directory within the external campaign directory");
const row = JSON.parse(readFileSync(path.join(dir, "final-job.json"), "utf8")), job = row.job as Job;
const original = JSON.parse(readFileSync(path.join(dir, "public-fixture.json"), "utf8"));
const campaign = JSON.parse(readFileSync(path.join(dir, "campaign.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() || (!retainedMode && commit !== campaign.sourceCommit))
  throw Error("Require the clean campaign source for offline assembly and verification");
const retained = retainedMode ? retainedContext(dir, campaign, job, commit) : undefined;
coordinatorPublicSolvedResult(job);
if (job.manifestHash !== original.rows[1].job.manifestHash || job.manifest.funding.txid !== "11".repeat(32)
  || job.manifest.helper.txid !== "22".repeat(32)) throw Error("Only the unfunded public intent is accepted");
// This seed is committed public test data, never wallet or operator recovery material.
const state = JSON.stringify({ config: "PQB", seed: fixture.seed });
const native = path.resolve("terraform/.build/api/native"), build = path.resolve("terraform/.build");
const manifest = JSON.parse(readFileSync(path.join(build, "manifest.json"), "utf8"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
if (!manifest.clean || manifest.commit !== commit || manifest.network !== "mainnet"
  || manifest.identities.solver.id !== campaign.descriptor.id
  || manifest.files["coordinator.zip"] !== campaign.coordinatorSha256
  || manifest.files["api.zip"] !== campaign.apiArtifactSha256
  || sha(readFileSync(path.join(dir, "build-artifacts/api.zip"))) !== campaign.apiArtifactSha256
  || sha(readFileSync(path.join(build, "api.zip"))) !== manifest.files["api.zip"])
  throw Error("Packaged API artifact hash differs");
if (retained && (!isDeepStrictEqual(manifest.files, retained.retainedManifest.files)
  || !isDeepStrictEqual(manifest.frontend_files, retained.retainedManifest.frontend_files)))
  throw Error("Retained follow-up requires all original packaged artifact hashes");
const generated = adoptPqb(state), raw = assemblePqb(state, job.manifest, job.solution!);
if (retained && raw !== retained.originalRaw) throw Error("Reassembled transaction differs from original positive Core check");
execFileSync("python3", ["-c", `import hashlib,pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(p/'api.zip') as z:
 for n in ['qsb-consensus','libbitcoinconsensus.so.0']:
  assert z.read('native/'+n)==(p/'api/native'/n).read_bytes(), 'Native bytes differ from packaged API'
`, build]);
const runtime = JSON.parse(execFileSync("docker", ["image", "inspect", retained?.intent.runtimeImageId ?? "public.ecr.aws/amazonlinux/amazonlinux:2023"], { encoding: "utf8" }))[0];
const args = ["run", "--rm", "-i", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--pids-limit=128", "--memory=256m", "--cpus=1", "--platform=linux/arm64", "-v", native + ":/native:ro",
  "--entrypoint=/native/qsb-consensus", runtime.Id];
if (retained && (runtime.Id !== retained.intent.runtimeImageId
  || sha(readFileSync(path.join(native, "qsb-consensus"))) !== retained.intent.binarySha256
  || sha(readFileSync(path.join(native, "libbitcoinconsensus.so.0"))) !== retained.intent.librarySha256))
  throw Error("Retained Core binary or runtime differs");
if (retainedMode) mkdirSync(output, { mode: 0o700 });
const provenance = retained?.provenance ?? { nativeConsumerSourceCommit: campaign.sourceCommit, validationSourceCommit: commit,
  postprocessingOnly: false };
const checks: unknown[] = [];
function save(name: string, value: string) {
  const fd = openSync(path.join(output, name), "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(output, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
}
save("solved-synthetic-transaction.hex", raw + "\n");
save("offline-consensus-intent.json", JSON.stringify({ ...provenance, sourceCommit: manifest.commit,
  apiArtifactSha256: manifest.files["api.zip"], runtimeImageId: runtime.Id,
  binarySha256: sha(readFileSync(path.join(native, "qsb-consensus"))),
  librarySha256: sha(readFileSync(path.join(native, "libbitcoinconsensus.so.0"))) }, null, 2) + "\n");
function run(label: string, transaction: string, valid: boolean, vaultScript = generated.scriptHex) {
  const input = [transaction, "2", job.manifest.helper.value, "51", job.manifest.funding.value, vaultScript].join("\n") + "\n";
  save(`offline-core-${label}.stdin`, input);
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30000, maxBuffer: 4096 });
  const accepted = result.status === 0 && result.stdout === "core-27.2-api2-all-inputs-valid\n";
  checks.push({ label, expectedValid: valid, accepted, exitCode: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, transactionSha256: sha(Buffer.from(transaction, "hex")) });
  save(`offline-core-${label}.json`, JSON.stringify(checks.at(-1), null, 2) + "\n");
  if (result.error || result.signal || accepted !== valid || (!valid && result.status !== 1))
    throw Error("Offline Core check failed: " + label);
}
run("solved-pqb-with-public-OP_TRUE-helper", raw, true);
type Raw = ReturnType<typeof btc.RawTx.decode>;
const mutations: Array<[string, (tx: Raw) => void]> = [
  ["destination", t => { t.outputs[0].script[2] ^= 1; }],
  ["output-amount", t => { t.outputs[0].amount += 1n; }],
  ["fee", t => { t.outputs[0].amount -= 1n; }],
  ["extra-output", t => { t.outputs.push({ amount: 0n, script: new Uint8Array([0x51]) }); }],
  ["helper-outpoint", t => { t.inputs[0].txid[0] ^= 1; }],
  ["vault-outpoint", t => { t.inputs[1].txid[0] ^= 1; }],
  ["helper-sequence", t => { t.inputs[0].sequence = (t.inputs[0].sequence ^ 1) >>> 0; }],
  ["vault-sequence", t => { t.inputs[1].sequence = (t.inputs[1].sequence ^ 1) >>> 0; }],
  ["locktime", t => { t.lockTime ^= 1; }],
  ["version", t => { t.version += 1; }],
  ["co-signature", t => {
    t.inputs[1].finalScriptSig = mutateCoSignature(t.inputs[1].finalScriptSig, hex.decode(generated.scriptHex));
  }],
  ["missing-vault-scriptsig", t => { t.inputs[1].finalScriptSig = new Uint8Array(); }],
];
for (const [label, mutate] of mutations) {
  const tx = btc.RawTx.decode(hex.decode(raw)); mutate(tx);
  run(label, hex.encode(btc.RawTx.encode(tx)), false);
}
save("offline-consensus.json", JSON.stringify({ ...provenance, passed: true, sourceCommit: manifest.commit,
  apiArtifactSha256: manifest.files["api.zip"], binarySha256: sha(readFileSync(path.join(native, "qsb-consensus"))),
  librarySha256: sha(readFileSync(path.join(native, "libbitcoinconsensus.so.0"))), runtimeImageId: runtime.Id,
  runtimeRepoDigests: runtime.RepoDigests, checks,
  limits: ["Public OP_TRUE helper: no helper wallet signature", "No chain/UTXO or miner acceptance", "No broadcast",
    "Legacy input scripts do not commit previous-output amounts; chain and exact-spend checks remain required"] }, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, positiveChecks: 1, negativeChecks: mutations.length, broadcast: false }));
