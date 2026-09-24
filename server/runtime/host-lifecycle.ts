import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import contract from "../mainnet-capability.json";
import { release } from "../../src/lib/model";
import { MemoryStore } from "../store";
import {
  acknowledgementExpired,
  acknowledgementLine,
  bindEvidenceDirectory,
  launchOwnedProcess,
  localAckStarter,
  recordLocalLoss,
  submitProviderOnce,
} from "./host-bridge";
import { sha256Hex } from "./identity";
import { compareDirectoryIdentity, directoryIdentity } from "./host-requirements";
import { remoteWorkStopProven, type LaunchRecord } from "./types";

export type LocalLifecycleReport = {
  format: "qsb-local-lifecycle-rehearsal-v1";
  scope: "local-rehearsal";
  selectedHost: false;
  certifiesProductionHost: false;
  interrupted: true;
  processExited: boolean;
  processAliveAfterInterrupt: boolean;
  remoteStopProven: false;
  providerIdPreserved: boolean;
  providerSubmissionsPreserved: boolean;
  evidenceReadableAfterShutdown: boolean;
  directoryReplacementDetected: boolean;
  missingDirectoryDetected: boolean;
  deadlineExpired: boolean;
  searchSuccess: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  operatorStep: string;
};

const rehearsalOwner = "local-rehearsal";
const evidenceText = "local-lifecycle-evidence\n";

function claimedLaunch(requestId: string, inputHash: string): LaunchRecord {
  return {
    bindings: {
      owner: rehearsalOwner,
      requestId,
      revision: 0,
      phase: "pinning",
      slot: 0,
      reservations: [{ txid: "11".repeat(32), vout: 0 }],
      capability: "search-only",
      configurationHash: "ab".repeat(32),
      release: {
        profileId: "qsb-supervised-pin-v4-subset-v5",
        sourceManifestFormat: "qsb-source-release-manifest-v1",
        coreSourceManifest: contract.coreSourceManifest,
        nativeBinariesEnrolled: false,
        broadcastAuthorized: false,
      },
      inputHash,
    },
    state: "claimed",
    previousProcessIds: [],
    providerOutcome: "not-submitted",
    providerSubmissions: 0,
    processStarts: 0,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function rehearseLocalLifecycle(
  directory: string,
): Promise<LocalLifecycleReport> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const callerIdentity = directoryIdentity(statSync(directory));
  const scratch = mkdtempSync(path.join(directory, "rehearsal-"));
  const marker = path.join(scratch, "evidence.txt");
  const inputHash = "cd".repeat(32);
  const requestId = crypto.randomUUID();
  const store = new MemoryStore();
  const launch = claimedLaunch(requestId, inputHash);
  await store.put({
    pk: `OWNER#${rehearsalOwner}`,
    sk: `LAUNCH#${requestId}#0`,
    version: 0,
    launch,
  });
  await store.put({
    pk: `OWNER#${rehearsalOwner}`,
    sk: `JOB#${requestId}`,
    version: 0,
    job: {
      id: requestId,
      owner: rehearsalOwner,
      mainnetRequestHash: inputHash,
      stage: "pinning",
      status: "queued",
    },
  });
  const starter = localAckStarter(
    process.execPath,
    [
      "-e",
      `require("node:fs").writeFileSync(process.argv[1], ${JSON.stringify(evidenceText)}, {mode:0o600}); process.stdout.write(${JSON.stringify(acknowledgementLine(inputHash))}); setInterval(() => {}, 1000);`,
      marker,
    ],
    5000,
    inputHash,
  );
  let pid: number | undefined;
  let parked: string | undefined;
  let processExited = false;
  try {
    const now = new Date();
    const boundMs = 5000;
    const acknowledged = await launchOwnedProcess(
      store,
      rehearsalOwner,
      requestId,
      0,
      inputHash,
      starter.start,
      now,
      boundMs,
    );
    const deadline = acknowledged.acknowledgement?.deadline;
    const recordedDeadline = deadline === undefined ? Number.NaN : Date.parse(deadline);
    if (
      !Number.isFinite(recordedDeadline) ||
      acknowledgementExpired(acknowledged, new Date(recordedDeadline - 1))
    )
      throw new Error("DeadlineNotRecorded");
    const deadlineExpired = acknowledgementExpired(
      acknowledged,
      new Date(recordedDeadline + 1),
    );
    const submitted = await submitProviderOnce(
      store,
      rehearsalOwner,
      requestId,
      0,
      inputHash,
      async () => ({ providerId: "local-rehearsal-provider" }),
    );
    if (submitted.providerId !== "local-rehearsal-provider" || submitted.providerSubmissions !== 1)
      throw new Error("ProviderSubmissionNotRecorded");
    pid = Number(acknowledged.processId);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("ProcessIdentityMissing");
    process.kill(pid, "SIGKILL");
    await starter.exits[0];
    processExited = true;
    const alive = processAlive(pid);
    const evidenceReadableAfterShutdown =
      sha256Hex(readFileSync(marker)) === sha256Hex(evidenceText);
    const bound = await bindEvidenceDirectory(
      store,
      rehearsalOwner,
      requestId,
      0,
      inputHash,
      directoryIdentity(statSync(scratch)),
    );
    if (bound.evidenceDirectory?.inode !== directoryIdentity(statSync(scratch)).inode)
      throw new Error("EvidenceDirectoryNotBound");
    parked = `${scratch}-replaced`;
    renameSync(scratch, parked);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const replaced = await bindEvidenceDirectory(
      store,
      rehearsalOwner,
      requestId,
      0,
      inputHash,
      directoryIdentity(statSync(scratch)),
    );
    const directoryReplacementDetected =
      replaced.localLoss?.kind === "evidence-directory-replaced";
    if (
      !directoryReplacementDetected ||
      replaced.providerId !== "local-rehearsal-provider" ||
      replaced.providerSubmissions !== 1
    )
      throw new Error("DirectoryReplacementNotObserved");
    const remoteStopProven = remoteWorkStopProven(replaced);
    if (
      remoteStopProven !== false ||
      release.mainnetEnabled !== false ||
      contract.broadcastAuthorized !== false
    )
      throw new Error("LocalLossMustNotProveRemoteStop");
    rmSync(scratch, { recursive: true, force: true });
    let removed = false;
    try {
      statSync(scratch);
    } catch (error) {
      removed = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    const missing = removed
      ? await recordLocalLoss(
          store,
          rehearsalOwner,
          requestId,
          0,
          inputHash,
          "evidence-directory-missing",
        )
      : undefined;
    const missingDirectoryDetected =
      removed && missing?.localLoss?.kind === "evidence-directory-missing";
    if (compareDirectoryIdentity(callerIdentity, directoryIdentity(statSync(directory))) !== "intact")
      throw new Error("CallerDirectoryReplaced");
    return {
      format: "qsb-local-lifecycle-rehearsal-v1",
      scope: "local-rehearsal",
      selectedHost: false,
      certifiesProductionHost: false,
      interrupted: true,
      processExited,
      processAliveAfterInterrupt: alive,
      remoteStopProven,
      providerIdPreserved:
        replaced.providerId === "local-rehearsal-provider" &&
        missing?.providerId === "local-rehearsal-provider",
      providerSubmissionsPreserved:
        replaced.providerSubmissions === 1 && missing?.providerSubmissions === 1,
      evidenceReadableAfterShutdown,
      directoryReplacementDetected,
      missingDirectoryDetected,
      deadlineExpired,
      searchSuccess: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      operatorStep:
        "Repeat forced interruption, recovery, deadline handling, and post-shutdown evidence checks on the selected host and retain that record. This local rehearsal does not.",
    };
  } finally {
    if (parked !== undefined) rmSync(parked, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The rehearsal process has already exited.
      }
    }
  }
}
