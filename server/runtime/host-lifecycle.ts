import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import contract from "../mainnet-capability.json";
import { release } from "../../src/lib/model";
import {
  acknowledgementExpired,
  acknowledgementLine,
  applyLocalLoss,
  localAckStarter,
} from "./host-bridge";
import { sha256Hex } from "./identity";
import {
  compareDirectoryIdentity,
  directoryIdentity,
} from "./host-requirements";
import {
  launchRecordSchema,
  remoteWorkStopProven,
  type LaunchRecord,
} from "./types";

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

function rehearsalLaunch(processId: string, inputHash: string): LaunchRecord {
  return launchRecordSchema.parse({
    bindings: {
      owner: "local-rehearsal",
      requestId: crypto.randomUUID(),
      revision: 0,
      phase: "pinning",
      slot: 0,
      reservations: [{ txid: "11".repeat(32), vout: 0 }],
      capability: "search-only",
      configurationHash: "ab".repeat(32),
      release: {
        profileId: "qsb-supervised-pin-v4-subset-v5",
        sourceManifestFormat: "qsb-source-release-manifest-v1",
        nativeBinariesEnrolled: false,
        broadcastAuthorized: false,
      },
      inputHash,
    },
    state: "running",
    processId,
    previousProcessIds: ["earlier-local-pid"],
    providerId: "local-rehearsal-provider",
    providerOutcome: "submitted",
    providerSubmissions: 1,
    processStarts: 1,
    acknowledgement: {
      kind: "process-started",
      processId,
      deadline: new Date(Date.now() - 1000).toISOString(),
      inputHash,
      searchSuccess: false,
      wholeRangeCovered: false,
    },
  });
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
  const bound = directoryIdentity(statSync(directory));
  const marker = path.join(directory, "evidence.txt");
  writeFileSync(marker, "local-lifecycle-evidence\n", { mode: 0o600 });
  const before = sha256Hex(readFileSync(marker));
  const inputHash = "cd".repeat(32);
  const starter = localAckStarter(
    process.execPath,
    [
      "-e",
      `process.stdout.write(${JSON.stringify(acknowledgementLine(inputHash))}); setInterval(() => {}, 1000);`,
    ],
    5000,
    inputHash,
  );
  let pid: number | undefined;
  let processExited = false;
  let sibling: string | undefined;
  try {
    const started = await starter.start();
    pid = Number(started.processId);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("ProcessIdentityMissing");
    process.kill(pid, "SIGKILL");
    await starter.exits[0];
    processExited = true;
    const alive = processAlive(pid);
    const after = sha256Hex(readFileSync(marker));
    sibling = mkdtempSync(`${directory}-sibling-`);
    const replaced = compareDirectoryIdentity(
      bound,
      directoryIdentity(statSync(sibling)),
    );
    const recovered = applyLocalLoss(
      rehearsalLaunch(started.processId, inputHash),
      "process-not-alive",
      started.processId,
    );
    const remoteStopProven = remoteWorkStopProven(recovered);
    if (
      remoteStopProven !== false ||
      release.mainnetEnabled !== false ||
      contract.broadcastAuthorized !== false
    )
      throw new Error("LocalLossMustNotProveRemoteStop");
    return {
      format: "qsb-local-lifecycle-rehearsal-v1",
      scope: "local-rehearsal",
      selectedHost: false,
      certifiesProductionHost: false,
      interrupted: true,
      processExited,
      processAliveAfterInterrupt: alive,
      remoteStopProven,
      providerIdPreserved: recovered.providerId === "local-rehearsal-provider",
      providerSubmissionsPreserved: recovered.providerSubmissions === 1,
      evidenceReadableAfterShutdown: before === after,
      directoryReplacementDetected: replaced === "replaced",
      missingDirectoryDetected:
        compareDirectoryIdentity(bound, undefined) === "missing",
      deadlineExpired: acknowledgementExpired(recovered, new Date()),
      searchSuccess: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      operatorStep:
        "Repeat forced interruption, recovery, deadline handling, and post-shutdown evidence checks on the selected host and retain that record. This local rehearsal does not.",
    };
  } finally {
    if (sibling !== undefined) rmSync(sibling, { recursive: true, force: true });
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The rehearsal process has already exited.
      }
    }
  }
}
