/** Public synthetic fixture only. No wallet input, signing, chain submission or network writes. */
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import fixture from "../../tests/fixtures/pqb-reference.json";
import descriptor from "../../src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json";
import { adoptPqb } from "../../src/lib/pqb";
import { publicVaultSchema, canonicalManifest, type Job } from "../../src/lib/model";
import { withVaultConfiguration, pinSolver, solverRelease, canonical } from "../../src/lib/provenance";
import { checkedOutput } from "../../server/search-protocol";
import { applyVerifiedHit } from "../../server/candidate-output";
import { pqbPacket } from "../../src/lib/pqb";
import { pqbReference } from "../../server/pqb-reference";
import { coordinatorPublicSolvedResult } from "../../src/mainnet/coordinatorResult";

const [mode, directory, indexName] = process.argv.slice(2);
if (!["prepare", "validate", "verify", "audit"].includes(mode) || !directory) throw Error("Use prepare|validate|audit|verify EXTERNAL_DIRECTORY");
const dir = path.resolve(directory);
if (dir === process.cwd() || dir.startsWith(process.cwd() + path.sep)) throw Error("Keep evidence outside Git");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function save(name: string, value: unknown) {
  const fd = openSync(path.join(dir, name), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dir, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
}
if (fixture.manifest.funding.txid !== "11".repeat(32) || fixture.manifest.helper.txid !== "22".repeat(32))
  throw Error("Fixture must be the committed unfunded synthetic intent");
if (mode === "prepare") {
  const generated = adoptPqb(JSON.stringify({ config: "PQB", seed: fixture.seed }));
  const manifest = canonicalManifest({ ...fixture.manifest, vaultId: randomUUID(), idempotencyKey: randomUUID(),
    solverReleaseId: descriptor.id });
  const owner = manifest.destination, now = new Date().toISOString();
  const vault = publicVaultSchema.parse(withVaultConfiguration({ id: manifest.vaultId,
    name: "Public synthetic PQB serving validation", network: "mainnet", config: "PQB", createdAt: now,
    paymentAddress: owner, scriptHex: generated.scriptHex, scriptHash: generated.scriptHash,
    publicStateJson: generated.publicStateJson, status: "confirmed", funding: manifest.funding }));
  const job: Job = { id: manifest.idempotencyKey, owner, vaultId: vault.id, createdAt: now, updatedAt: now,
    status: "queued", stage: "pinning", manifest, manifestHash: sha(JSON.stringify(manifest)), attempt: 0,
    revision: 0, computeSeconds: 0, gpuBudgetReservedSeconds: 0, gpuSubmissions: 0,
    solver: pinSolver(vault, descriptor.id) };
  save("public-fixture.json", { format: "pqb-serving-public-fixture-v1", descriptor,
    event: { owner, jobId: job.id, revision: 0 }, rows: [
      { pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault },
      { pk: `OWNER#${owner}`, sk: `JOB#${job.id}`, version: 0, job } ] });
  console.log(JSON.stringify({ prepared: true, release: descriptor.id, manifestHash: job.manifestHash }));
} else if (mode === "validate") {
  const prepared = JSON.parse(readFileSync(path.join(dir, "public-fixture.json"), "utf8"));
  if (canonical(Object.keys(prepared).sort()) !== canonical(["descriptor", "event", "format", "rows"]) ||
    canonical(prepared.descriptor) !== canonical(descriptor) || prepared.rows.length !== 2)
    throw Error("Only the generated public fixture is accepted");
  const [v, j] = prepared.rows, vault = publicVaultSchema.parse(v.vault), job = j.job as Job;
  const expected = canonicalManifest({ ...fixture.manifest, vaultId: vault.id,
    idempotencyKey: job.id, solverReleaseId: descriptor.id });
  const generated = adoptPqb(JSON.stringify({ config: "PQB", seed: fixture.seed }));
  if (canonical(vault.publicStateJson) !== canonical(generated.publicStateJson) || vault.scriptHex !== generated.scriptHex
    || canonical(job.manifest) !== canonical(expected) || job.manifestHash !== sha(JSON.stringify(expected))
    || canonical(job.solver) !== canonical(pinSolver(vault, descriptor.id))
    || canonical(Object.keys(job).sort()) !== canonical(["attempt", "computeSeconds", "createdAt", "gpuBudgetReservedSeconds", "gpuSubmissions", "id", "manifest", "manifestHash", "owner", "revision", "solver", "stage", "status", "updatedAt", "vaultId"].sort())
    || job.stage !== "pinning" || job.status !== "queued" || job.attempt !== 0 || job.gpuSubmissions !== 0
    || job.gpuBudgetReservedSeconds !== 0 || job.computeSeconds !== 0 || job.revision !== 0
    || canonical(prepared.event) !== canonical({ owner: expected.destination, jobId: job.id, revision: 0 })
    || canonical(Object.keys(v).sort()) !== canonical(["pk", "sk", "vault", "version"])
    || canonical(Object.keys(j).sort()) !== canonical(["job", "pk", "sk", "version"])
    || v.pk !== `OWNER#${expected.destination}` || j.pk !== v.pk || v.sk !== `VAULT#${vault.id}`
    || j.sk !== `JOB#${job.id}` || v.version !== 0 || j.version !== 0)
    throw Error("Fixture differs from the committed unfunded public input");
  console.log(JSON.stringify({ publicFixtureValidated: true, manifestHash: job.manifestHash }));
} else if (mode === "audit") {
  if (!indexName || !/^native-index-[0-9]+\.json$/.test(indexName)) throw Error("Require a collected native job index");
  const prepared = JSON.parse(readFileSync(path.join(dir, "public-fixture.json"), "utf8"));
  const index = JSON.parse(readFileSync(path.join(dir, indexName), "utf8"));
  const jobs: any[] = index.jobs, successful = jobs.filter(j => j.status === "SUCCEEDED");
  if (!successful.length || index.image.split("@")[1] !== descriptor.image.split("@")[1])
    throw Error("Native success receipts or image binding missing");
  for (const job of jobs) {
    if (job.status !== "SUCCEEDED" && !(job.status === "FAILED"
      && job.statusReason === "QSB operator/coordinator cancellation"))
      throw Error("Unexpected native failure or unfinished job");
  }
  const objects = path.join(dir, "objects"), names = readdirSync(objects);
  const inputs = new Map(names.filter(n => /^inputs__[a-f0-9-]+\.json$/.test(n)).map(n => {
    const bytes = readFileSync(path.join(objects, n));
    return [createHash("sha256").update(bytes).digest("hex"), JSON.parse(bytes.toString()).input];
  }));
  const startup: unknown[] = [];
  for (const job of successful) {
    if (job.jobDefinition !== index.definition || job.container?.image !== index.image)
      throw Error("Native Batch image/revision mismatch");
    const env = Object.fromEntries(job.container.environment.map((v: any) => [v.name, v.value]));
    const input = inputs.get(env.QSB_INPUT_SHA256);
    if (!input || !names.includes(`outputs__${job.jobId}.json`)) throw Error("Successful native job receipt missing");
    const logPath = index.startupLogs[job.jobId];
    if (typeof logPath !== "string" || !/^logs\/[a-f0-9-]+-[0-9]+\.json$/.test(logPath))
      throw Error("Native startup receipt missing");
    const pages = JSON.parse(readFileSync(path.join(dir, logPath), "utf8"));
    const messages: string[] = pages.flatMap((p: any) => p.events.map((e: any) => e.message));
    const driver = messages.flatMap(m => m.split("\n")).map(m => /^(?:NVIDIA )?A10G,\s*(GPU-[a-f0-9-]+),\s*([0-9]+(?:\.[0-9]+)+)\s*$/.exec(m)).find(Boolean);
    if (!driver || !messages.some(m => /^NoNewPrivs:\s+1\s*$/m.test(m))
      || !messages.some(m => /^CapBnd:\s+0+\s*$/m.test(m)))
      throw Error("A10G driver or process-isolation receipt missing");
    startup.push({ jobId: job.jobId, gpuUuid: driver[1], driver: driver[2] });
  }
  const envelopes = names.filter(n => /^outputs__[a-f0-9-]+\.json$/.test(n)).map(n => {
    const envelope = JSON.parse(readFileSync(path.join(objects, n), "utf8")), input = inputs.get(envelope.inputSha256);
    const native = jobs.find(j => j.jobId === envelope.jobId);
    const env = Object.fromEntries((native?.container?.environment ?? []).map((v: any) => [v.name, v.value]));
    if (!native || !input || envelope.jobId !== n.slice(9, -5) || env.QSB_INPUT_SHA256 !== envelope.inputSha256
      || !["pinning", "round0", "round1"].includes(input.stage) || input.protocol !== "pqb-v1"
      || input.kernelCommit !== descriptor.kernelCommit || input.manifestHash !== prepared.rows[1].job.manifestHash)
      throw Error("Native envelope/input identity mismatch");
    const stage = input.stage === "round0" ? "round1" : input.stage === "round1" ? "round2" : "pinning";
    const { output, range } = checkedOutput(envelope.output, solverRelease(descriptor.id),
      { ...prepared.rows[1].job, stage }, input.attempt);
    if (native.status === "SUCCEEDED" && output.status !== "completed") throw Error("Native unit did not complete");
    if (output.status !== "completed") throw Error("Unexpected incomplete native result");
    return { native, envelope, input, stage, output, range };
  });
  // Derive every packet from the public intent and CPU-validated predecessor hits.
  // This also checks hits in superseded units, independently of coordinator selection.
  const solutions = new Map<string, Job["solution"]>();
  const source = prepared.rows[1].job as Job, vault = prepared.rows[0].vault;
  const root = pqbReference({ action: "export", stage: "pinning", publicStateJson: vault.publicStateJson, manifest: source.manifest });
  if (!("problemSha256" in root)) throw Error("Public root export failed");
  solutions.set(`pinning:${root.problemSha256}`, undefined);
  const checked: unknown[] = [], packets = new Map<string, unknown>();
  const winningCompletions = new Map<string, number[]>();
  for (const stage of ["pinning", "round1", "round2"] as const) {
    for (const row of envelopes.filter(r => r.stage === stage)) {
      const key = `${stage}:${row.input.problemSha256}`;
      if (!solutions.has(key)) throw Error("Native packet lacks a CPU-validated predecessor");
      const solution = solutions.get(key);
      const expected = pqbReference({ action: "export", stage, publicStateJson: vault.publicStateJson,
        manifest: source.manifest, solution });
      if (!("problemBase64" in expected) || expected.problemBase64 !== row.input.problemBase64)
        throw Error("Native problem differs from independent public export");
      const packet = pqbPacket(vault.publicStateJson, source.manifest, stage === "pinning" ? 0 : stage === "round1" ? 1 : 2, solution);
      packets.set(key, JSON.parse(JSON.stringify(packet, (_, v) => typeof v === "bigint" ? v.toString() : v)));
      const cpu = row.output.candidates.map(candidate => {
        const verdict = pqbReference({ action: "verify", stage, publicStateJson: vault.publicStateJson,
          manifest: source.manifest, solution, candidates: [candidate] });
        if (verdict.valid && stage !== "round2") {
          const advanced = { ...structuredClone(source), stage, solution: structuredClone(solution) };
          applyVerifiedHit(advanced, verdict, row.range, row.input.attempt);
          const nextStage = stage === "pinning" ? "round1" : "round2";
          const next = pqbReference({ action: "export", stage: nextStage, publicStateJson: vault.publicStateJson,
            manifest: source.manifest, solution: advanced.solution });
          if (!("problemSha256" in next)) throw Error("Public successor export failed");
          solutions.set(`${nextStage}:${next.problemSha256}`, advanced.solution);
        }
        if (verdict.valid && row.native.status === "SUCCEEDED") {
          if (!Number.isSafeInteger(row.native.stoppedAt) || row.native.stoppedAt <= 0)
            throw Error("Missing successful native completion timestamp");
          winningCompletions.set(key, [...(winningCompletions.get(key) ?? []), row.native.stoppedAt]);
        }
        return { candidate, verdict };
      });
      checked.push({ jobId: row.envelope.jobId, stage, attempt: row.input.attempt, status: row.output.status,
        providerStatus: row.native.status, executionTime: row.envelope.executionTime, packetKey: key, cpu });
    }
  }
  const cancellations = jobs.filter(j => j.status === "FAILED").map(job => {
    const env = Object.fromEntries((job.container?.environment ?? []).map((v: any) => [v.name, v.value]));
    const input = inputs.get(env.QSB_INPUT_SHA256);
    if (!input) throw Error("Cancelled native input missing");
    const stage = input.stage === "round0" ? "round1" : input.stage === "round1" ? "round2" : "pinning";
    const winners = winningCompletions.get(`${stage}:${input.problemSha256}`) ?? [];
    if (!Number.isSafeInteger(job.stoppedAt) || !winners.some(t => t <= job.stoppedAt))
      throw Error("Cancellation lacks an earlier CPU-validated winning unit for the same packet");
    return { jobId: job.jobId, reason: job.statusReason, stoppedAt: job.stoppedAt, superseded: true };
  });
  if (checked.length < successful.length) throw Error("Native receipt inventory incomplete");
  save(`native-accounting-audit-${Date.now()}.json`, { passed: true, checked, startup, cancellations, packets: Object.fromEntries(packets) });
  console.log(JSON.stringify({ passed: true, checked: checked.length, successfulJobs: successful.length }));

} else {
  const prepared = JSON.parse(readFileSync(path.join(dir, "public-fixture.json"), "utf8"));
  const row = JSON.parse(readFileSync(path.join(dir, "final-job.json"), "utf8"));
  const job = row.job as Job, initial = prepared.rows[1].job as Job;
  if (job.manifestHash !== initial.manifestHash || JSON.stringify(job.solver) !== JSON.stringify(initial.solver))
    throw Error("Final job changed its public intent or solver binding");
  const solved = coordinatorPublicSolvedResult(job), vault = prepared.rows[0].vault;
  const solution = job.solution!, lines = solution.pqb!;
  const checked: unknown[] = [];
  for (const [stage, candidate] of [["pinning", lines.pinning], ["round1", lines.round0], ["round2", lines.round1]]) {
    const verdict = await pqbReference({ action: "verify", stage, publicStateJson: vault.publicStateJson,
      manifest: job.manifest, solution, candidates: [candidate] });
    if (!verdict.valid) throw Error(`Independent CPU check failed: ${stage}`);
    checked.push({ stage, candidate, verdict });
  }
  save("solved-public.json", solved);
  save("final-cpu-verification.json", { passed: true, checked, simulatedGrinder: false,
    broadcast: false, fundedOutputs: false });
  console.log(JSON.stringify({ passed: true, stage: job.stage, status: job.status,
    submissions: job.gpuSubmissions, reservedGpuSeconds: job.gpuBudgetReservedSeconds }));
}
