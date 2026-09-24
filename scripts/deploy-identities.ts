import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactCommit = "d28103baaa405dba7261f54db80f13aa279ea78e";
const releaseId = "qsb-config-a-ranked-v2-d28103b";
const publicImageHost =
  "000000000000.dkr.ecr.eu-west-1.amazonaws.com/qsb-vault-worker";
const identitiesPath = path.join(
  workspace,
  "terraform/.build/deploy-identities.json",
);
const descriptorPath = path.join(
  workspace,
  "src/lib/releases",
  `${releaseId}.json`,
);

function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  if (!found) throw new Error(`Missing --${name}`);
  return found.slice(prefix.length);
}

function optionalArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found?.slice(prefix.length);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function assertDisabled(context: string) {
  const model = readFileSync(path.join(context, "src/lib/model.ts"), "utf8");
  const manifest = JSON.parse(
    readFileSync(path.join(context, "release/source-manifest.json"), "utf8"),
  ) as { mainnetEnabled?: boolean; broadcastAuthorized?: boolean };
  if (
    !/mainnetEnabled:\s*false/.test(model) ||
    manifest.mainnetEnabled !== false
  )
    throw new Error("Refusing identities while mainnetEnabled is not false");
  if (manifest.broadcastAuthorized !== false)
    throw new Error(
      "Refusing identities while broadcastAuthorized is not false",
    );
}

function assertPushedCheckout(context: string, commit: string) {
  if (git(context, ["rev-parse", "HEAD"]) !== commit)
    throw new Error("Artifact checkout is not the requested commit");
  if (git(context, ["status", "--porcelain"]))
    throw new Error("Artifact checkout is dirty");
  git(workspace, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  assertDisabled(context);
}

function login(registryHost: string) {
  const token = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
  }).trim();
  if (!token) throw new Error("Registry login token is missing");
  execFileSync(
    "docker",
    ["login", registryHost, "-u", "cursor", "--password-stdin"],
    {
      input: token,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
}

function pushDigest(localTag: string, remote: string): string {
  execFileSync("docker", ["tag", localTag, remote], { stdio: "inherit" });
  const pushed = spawnSync("docker", ["push", remote], { encoding: "utf8" });
  const text = `${pushed.stdout ?? ""}\n${pushed.stderr ?? ""}`;
  if (pushed.status !== 0)
    throw new Error(`Registry push failed for ${remote}\n${text.slice(-2000)}`);
  const digest = text.match(/digest: (sha256:[a-f0-9]{64})/)?.[1];
  if (!digest)
    throw new Error(`Registry push did not return a digest for ${remote}`);
  const name = remote.slice(0, remote.lastIndexOf(":"));
  execFileSync("docker", ["pull", `${name}@${digest}`], { stdio: "inherit" });
  return digest;
}

function packageSha256(context: string): string {
  const stage = mkdtempSync(path.join(tmpdir(), "qsb-reference-"));
  try {
    for (const name of [
      "api",
      "coordinator",
      "reference",
      "watchdog",
      "dispatch",
    ])
      mkdirSync(path.join(stage, name));
    const source = path.join(context, "worker/cpu");
    for (const name of readdirSync(source)) {
      if (!name.endsWith(".py") && name !== "LICENSE") continue;
      writeFileSync(
        path.join(stage, "reference", name),
        readFileSync(path.join(source, name)),
      );
    }
    execFileSync(
      "python3",
      [path.join(workspace, "terraform/scripts/zip.py"), stage],
      {
        stdio: "inherit",
      },
    );
    return createHash("sha256")
      .update(readFileSync(path.join(stage, "reference.zip")))
      .digest("hex");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function writeDescriptor(context: string, workerDigest: string) {
  const archivedPath = path.join(
    context,
    "src/lib/releases/qsb-config-a-ranked-v2.json",
  );
  const workspaceArchived = path.join(
    workspace,
    "src/lib/releases/qsb-config-a-ranked-v2.json",
  );
  if (!readFileSync(archivedPath).equals(readFileSync(workspaceArchived)))
    throw new Error(
      "Archived solver descriptor differs from the artifact commit",
    );
  const archived = JSON.parse(readFileSync(archivedPath, "utf8")) as {
    id: string;
    protocol: string;
    generatorCommit: string;
    image: string;
    sourceHashes: Record<string, string>;
  };
  for (const [relativePath, expected] of Object.entries(
    archived.sourceHashes,
  )) {
    const actual = createHash("sha256")
      .update(readFileSync(path.join(context, relativePath)))
      .digest("hex");
    if (actual !== expected)
      throw new Error(`Source hash mismatch for ${relativePath}`);
  }
  if (workerDigest === archived.image.split("@")[1])
    throw new Error("Rebuilt worker digest matches the historical placeholder");
  const descriptor = {
    ...archived,
    id: releaseId,
    image: `${publicImageHost}@${workerDigest}`,
  };
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
}

function cpuDockerfile(): string {
  const file = path.join(tmpdir(), "qsb-cpu-verifier.Dockerfile");
  writeFileSync(
    file,
    [
      "FROM public.ecr.aws/lambda/python:3.13",
      "COPY worker/cpu/*.py worker/cpu/LICENSE /var/task/",
      'CMD ["handler.handler"]',
      "",
    ].join("\n"),
  );
  return file;
}

const context = path.resolve(arg("context"));
const workerRepository = arg("worker-repository");
const cpuRepository = arg("cpu-repository");
const tag = arg("tag");
for (const repository of [workerRepository, cpuRepository]) {
  if (
    !repository ||
    repository.includes("000000000000") ||
    repository.includes("@")
  )
    throw new Error("Refusing a placeholder or digest-form registry");
}
const loginHost = optionalArg("login-host");
assertPushedCheckout(context, artifactCommit);

execFileSync(
  "docker",
  [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    path.join(context, "worker/Dockerfile"),
    "-t",
    "qsb-historical-worker:artifact",
    context,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "docker",
  [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    cpuDockerfile(),
    "-t",
    "qsb-cpu-verifier:artifact",
    context,
  ],
  { stdio: "inherit" },
);

if (loginHost) login(loginHost);
const workerDigest = pushDigest(
  "qsb-historical-worker:artifact",
  `${workerRepository}:${tag}`,
);
const cpuDigest = pushDigest(
  "qsb-cpu-verifier:artifact",
  `${cpuRepository}:${tag}`,
);
const identities = {
  format: "qsb-deploy-identities-v1",
  artifactCommit,
  mainnetEnabled: false,
  broadcastAuthorized: false,
  worker: {
    digest: workerDigest,
    repository: workerRepository,
    pull: `${workerRepository}@${workerDigest}`,
  },
  cpuVerifier: {
    digest: cpuDigest,
    repository: cpuRepository,
    pull: `${cpuRepository}@${cpuDigest}`,
    packageSha256: packageSha256(context),
    platform: "linux/amd64",
  },
  runpod: { image: `${workerRepository}@${workerDigest}` },
};
mkdirSync(path.dirname(identitiesPath), { recursive: true });
writeFileSync(identitiesPath, `${JSON.stringify(identities, null, 2)}\n`);
writeDescriptor(context, workerDigest);
console.log(
  `Wrote deploy identities for ${artifactCommit} worker ${workerDigest} cpu ${cpuDigest}. No deployment and no broadcast.`,
);
