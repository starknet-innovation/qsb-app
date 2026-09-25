#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
const native = path.resolve(process.argv[2] ?? "terraform/.build/api/native");
if (!existsSync(path.join(native, "qsb-consensus")))
  throw Error("Build the native adapter first");
const docker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
const host =
  process.env.DOCKER_HOST ||
  execFileSync(
    docker,
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { encoding: "utf8" },
  ).trim();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const work = mkdtempSync(path.join(tmpdir(), "qsb-native-test-"));
try {
  const wrapper = path.join(work, "verify");
  // Only this test wrapper uses Docker. Production directly execs packaged binary.
  const args = [
    docker,
    "--host",
    host,
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--platform",
    "linux/arm64",
    "-v",
    native + ":/native:ro",
    "--entrypoint",
    "/native/qsb-consensus",
    "public.ecr.aws/amazonlinux/amazonlinux:2023",
  ];
  writeFileSync(
    wrapper,
    "#!/bin/sh\nexec " + args.map(quote).join(" ") + "\n",
    { mode: 0o700 },
  );
  execFileSync(
    "npm",
    ["test", "--", "tests/consensus.test.ts", "--testTimeout=30000"],
    {
      stdio: "inherit",
      env: { ...process.env, QSB_TEST_CONSENSUS_BINARY: wrapper },
    },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
