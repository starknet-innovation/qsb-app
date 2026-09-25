/** Bounded public migration fixture; never reads wallets or retries a paid submit. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { AwsBatch } from "../../server/aws-batch";
const [mode, stage, dirArg] = process.argv.slice(2);
if (
  !["submit", "poll"].includes(mode) ||
  !["pinning", "round1", "round2"].includes(stage) ||
  !dirArg
)
  throw Error("Use submit|poll pinning|round1|round2 EVIDENCE_DIRECTORY");
const dir = path.resolve(dirArg),
  root = process.cwd();
if (dir.startsWith(root + "/"))
  throw Error("Evidence must stay outside the source checkout");
const bindings = JSON.parse(
  readFileSync(path.join(dir, "outputs.json"), "utf8"),
);
const provider = new AwsBatch(
  bindings.queue.value,
  bindings.definition.value,
  bindings.bucket.value,
);
const statePath = path.join(dir, `smoke-${stage}.json`);
function persist(value: unknown) {
  const tmp = statePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, statePath);
}
if (mode === "submit") {
  if (
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw Error("Commit and push before cloud work");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
  if (
    execFileSync("git", ["ls-remote", "origin", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).split(/\s/)[0] !== commit
  )
    throw Error("Source must be pushed");
  const event = JSON.parse(
    readFileSync(path.join(dir, "fixture", "event.json"), "utf8"),
  );
  if (
    event.manifest.funding.txid !== "11".repeat(32) ||
    event.manifest.helper.txid !== "22".repeat(32)
  )
    throw Error("Only the synthetic unfunded fixture is allowed");
  const exported = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import sys,json;sys.path.insert(0,'worker/cpu');from handler import handler;print(json.dumps(handler(json.load(sys.stdin))))`,
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ ...event, stage, action: "export" }),
      },
    ),
  );
  const input = {
    protocol: "qsb-config-a-v1",
    stage,
    ...exported,
    sequence: event.sequence,
    locktime: event.locktime,
    attempt: 0,
    manifestHash: createHash("sha256")
      .update(JSON.stringify(event.manifest))
      .digest("hex"),
    kernelCommit: "2791ed0588f5014ccd688d48ba5502df2879f2f1",
    searchVersion: "ranked-v2",
  };
  const vars = JSON.parse(
    readFileSync(path.join(dir, "gpu.tfvars.json"), "utf8"),
  );
  const submit = await provider.prepareRun(vars.image);
  const intent = {
    commit,
    image: vars.image,
    stage,
    createdAt: new Date().toISOString(),
    inputSha256: createHash("sha256")
      .update(JSON.stringify({ input }))
      .digest("hex"),
    status: "submission-intent",
    input,
  };
  // Atomic create prevents a second submit even if a response or this process is lost.
  const fd = openSync(statePath, "wx", 0o600);
  writeSync(fd, JSON.stringify(intent, null, 2) + "\n");
  fsyncSync(fd);
  closeSync(fd);
  const result = await submit(input);
  persist({ ...intent, jobId: result.id, status: "submitted" });
  console.log(JSON.stringify({ stage, jobId: result.id, status: "submitted" }));
} else {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!state.jobId)
    throw Error(
      "Uncertain submit: reconcile the original input SHA256 via CloudTrail/Batch; NEVER submit again",
    );
  const result = await provider.status(state.jobId);
  persist({ ...state, lastCheckedAt: new Date().toISOString(), result });
  if (result.status === "COMPLETED") {
    const output = result.output as any;
    if (
      output.stage !== stage ||
      output.manifestHash !== state.input.manifestHash ||
      output.kernelCommit !== state.input.kernelCommit ||
      output.attempt !== 0
    )
      throw Error("Output identity mismatch");
    const event = JSON.parse(
      readFileSync(path.join(dir, "fixture", "event.json"), "utf8"),
    );
    const records: string[] = output.candidates.flatMap((text: string) =>
      text.split(/(?=^(?:indices|sequence)=)/m).filter((x) => x.trim()),
    );
    const verified = records.map((candidate) =>
      JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            `import sys,json;sys.path.insert(0,'worker/cpu');from handler import handler;print(json.dumps(handler(json.load(sys.stdin))))`,
          ],
          {
            encoding: "utf8",
            input: JSON.stringify({
              ...event,
              stage,
              action: "verify",
              candidates: [candidate],
            }),
          },
        ),
      ),
    );
    persist({
      ...state,
      result,
      cpuVerification: verified,
      candidates: output.candidates.length,
      checkedAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        stage,
        jobId: state.jobId,
        status: result.status,
        workerStatus: output.status,
        elapsedSeconds: output.elapsedSeconds,
        candidates: output.candidates.length,
        cpuVerification: verified,
      }),
    );
    if (output.status !== "completed" || output.checkpoint !== "range-complete")
      throw Error("Failed or incomplete smoke probe");
    if (verified.some((v: { valid: boolean }) => !v.valid))
      throw Error("CPU candidate verification failed");
  } else
    console.log(
      JSON.stringify({ stage, jobId: state.jobId, status: result.status }),
    );
}
