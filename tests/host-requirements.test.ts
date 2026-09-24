import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { release } from "../src/lib/model";
import contract from "../server/mainnet-capability.json";
import { MemoryStore } from "../server/store";
import { rehearseLocalLifecycle } from "../server/runtime/host-lifecycle";
import {
  acceptCredentialReference,
  acceptHostPermissionClaim,
  assertLogOmitsSecret,
  assertNoCredentialMaterial,
  compareDirectoryIdentity,
  credentialProvisioningGap,
  directoryIdentity,
  directoryExposesWrite,
  probeLocalHost,
  validateDeclaredPrivilegeBoundary,
} from "../server/runtime/host-requirements";
import {
  applyLocalLoss,
  bindEvidenceDirectory,
  recordLocalLoss,
  submitProviderOnce,
} from "../server/runtime/host-bridge";
import {
  launchRecordSchema,
  remoteWorkStopProven,
  type LaunchRecord,
} from "../server/runtime/types";

const inputHash = "cd".repeat(32);

function runningLaunch(processId: string, requestId: string): LaunchRecord {
  return launchRecordSchema.parse({
    bindings: {
      owner: "owner",
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
        nativeBinariesEnrolled: false,
        broadcastAuthorized: false,
      },
      inputHash,
    },
    state: "running",
    processId,
    previousProcessIds: ["previous-local-pid"],
    providerId: "provider-1",
    providerOutcome: "submitted",
    providerSubmissions: 1,
    processStarts: 1,
    acknowledgement: {
      kind: "process-started",
      processId,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      inputHash,
      searchSuccess: false,
      wholeRangeCovered: false,
    },
    evidenceDirectory: {
      device: 1,
      inode: 2,
      mode: 0o700,
      uid: 3,
      gid: 4,
    },
  });
}

describe("local execution host rehearsal", () => {
  it("records local compatibility without selecting a production host", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qsb-host-"));
    try {
      const identity = directoryIdentity(statSync(root));
      const report = probeLocalHost({
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid?.(),
        pid: process.pid,
        directory: identity,
        imagesEnrolled: false,
        childContainerEnrolled: false,
        privileged: false,
        dockerSocketMounted: false,
      });
      expect(report.productionHostSelected).toBe(false);
      expect(report.certifiesDeploymentHost).toBe(false);
      expect(report.productionCompatible).toBe(false);
      expect(report.checks.find((check) => check.id === "linux-process-ownership")?.ok).toBe(
        process.platform === "linux",
      );
      expect(
        report.checks.find((check) => check.id === "immutable-preloaded-image"),
      ).toMatchObject({ ok: false });
      expect(
        report.checks.find((check) => check.id === "owned-cpu-container")?.ok,
      ).toBe(false);
      expect(
        report.checks.find((check) => check.id === "private-credential-channel")?.ok,
      ).toBe(false);
      expect(report.operatorSteps.join(" ")).toContain("000000000000");
      expect(report.operatorSteps.join(" ")).toContain("historical Lambda");
      expect(directoryExposesWrite(0o700)).toBe(false);
      expect(directoryExposesWrite(0o707)).toBe(true);
      expect(directoryExposesWrite(0o770)).toBe(true);
      expect(directoryExposesWrite(0o770, true)).toBe(false);
      expect(directoryExposesWrite(0o777, true)).toBe(true);
      const bound = { device: 1, inode: 2, mode: 0o700, uid: 3, gid: 4 };
      expect(compareDirectoryIdentity(bound, { ...bound, gid: 9 })).toBe("replaced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects public credential material and resolver-only host permission claims", () => {
    const accepted = acceptCredentialReference({
      format: "qsb-private-credential-reference-v1",
      channel: "operator-secret-reference",
      reference: "operator-secret-reference:rehearsal",
    });
    expect(accepted.provisioned).toBe(false);
    expect(accepted.resolvedSecret).toBeNull();
    expect(() =>
      acceptCredentialReference({
        format: "qsb-private-credential-reference-v1",
        channel: "operator-secret-reference",
        reference: "sk-live-opaque-api-secret",
      }),
    ).toThrow();
    expect(credentialProvisioningGap().provisioned).toBe(false);
    expect(() =>
      assertNoCredentialMaterial({ browserRequest: { apiKey: "synthetic" } }),
    ).toThrow(/CredentialMaterialRejected/);
    expect(() => assertLogOmitsSecret("log apiKey=synthetic", "synthetic")).toThrow(
      /CredentialMaterialRejected:log/,
    );
    expect(() => assertLogOmitsSecret("process started", "synthetic")).not.toThrow();
    expect(acceptHostPermissionClaim({ enforcedBy: "resolver-check" })).toEqual({
      accepted: false,
      reason: "Resolver checks do not replace host permissions.",
    });
    expect(acceptHostPermissionClaim({ enforcedBy: "host-mount" }).accepted).toBe(
      false,
    );
    expect(
      validateDeclaredPrivilegeBoundary({
        privileged: true,
        dockerSocketMounted: false,
        hostPidNamespaceShared: false,
        childMayReplaceHostMounts: false,
      }).accepted,
    ).toBe(false);
    expect(
      validateDeclaredPrivilegeBoundary({
        privileged: false,
        dockerSocketMounted: false,
        hostPidNamespaceShared: false,
        childMayReplaceHostMounts: false,
      }).accepted,
    ).toBe(true);
  });

  it("keeps provider identity when the local process or evidence directory is gone", async () => {
    const store = new MemoryStore();
    const requestId = crypto.randomUUID();
    const launch = runningLaunch("4242", requestId);
    await store.put({
      pk: "OWNER#owner",
      sk: `JOB#${requestId}`,
      version: 0,
      job: {
        id: requestId,
        owner: "owner",
        mainnetRequestHash: inputHash,
        stage: "pinning",
        status: "searching",
        runtime: { state: "running", searchRunning: true },
        coverage: "none",
      },
    });
    await store.put({
      pk: "OWNER#owner",
      sk: `LAUNCH#${requestId}#0`,
      version: 0,
      launch,
    });
    expect(() => applyLocalLoss(launch, "process-not-alive", "9999")).toThrow(
      /StaleProcess/,
    );
    const lost = await recordLocalLoss(
      store,
      "owner",
      requestId,
      0,
      inputHash,
      "process-not-alive",
      "4242",
    );
    expect(lost.state).toBe("uncertain");
    expect(lost.providerId).toBe("provider-1");
    expect(lost.providerOutcome).toBe("submitted");
    expect(lost.providerSubmissions).toBe(1);
    expect(lost.previousProcessIds).toEqual(["previous-local-pid"]);
    expect(lost.evidenceDirectory?.inode).toBe(2);
    expect(lost.localLoss).toEqual({
      kind: "process-not-alive",
      remoteStopProven: false,
      providerIdentityPreserved: true,
    });
    expect(remoteWorkStopProven(lost)).toBe(false);
    let submits = 0;
    await expect(
      submitProviderOnce(store, "owner", requestId, 0, inputHash, async () => {
        submits += 1;
        return { providerId: "provider-2" };
      }),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    expect(submits).toBe(0);
    const job = (await store.get("OWNER#owner", `JOB#${requestId}`))?.job as {
      status: string;
      runtime: { searchRunning: boolean };
    };
    expect(job.status).toBe("paused");
    expect(job.runtime.searchRunning).toBe(false);

    const replaced = await recordLocalLoss(
      store,
      "owner",
      requestId,
      0,
      inputHash,
      "evidence-directory-replaced",
    );
    expect(replaced.providerId).toBe("provider-1");
    expect(replaced.providerSubmissions).toBe(1);
    expect(replaced.evidenceDirectory).toEqual(launch.evidenceDirectory);
    expect(remoteWorkStopProven(replaced)).toBe(false);
  });

  it("keeps stored terminal evidence when the directory binding no longer matches", async () => {
    const store = new MemoryStore();
    const requestId = crypto.randomUUID();
    const root = mkdtempSync(path.join(tmpdir(), "qsb-evidence-"));
    try {
      const launch = launchRecordSchema.parse({
        ...runningLaunch("4242", requestId),
        state: "terminal",
        evidence: {
          format: "qsb-terminal-evidence-v1",
          inputHash,
          processId: "4242",
          outcome: "process-exit",
          hitVerified: false,
          wholeRangeCovered: false,
          solverFacts: "not-run",
          chainFacts: "not-run",
          cpuVerification: "not-run",
          binariesProduced: false,
          freshSearch: false,
          bundle: { kept: true },
        },
      });
      delete launch.evidenceDirectory;
      await store.put({
        pk: "OWNER#owner",
        sk: `JOB#${requestId}`,
        version: 0,
        job: {
          id: requestId,
          owner: "owner",
          mainnetRequestHash: inputHash,
          stage: "pinning",
          status: "awaiting_authorization",
          coverage: "verified-hit-not-whole-range",
        },
      });
      await store.put({
        pk: "OWNER#owner",
        sk: `LAUNCH#${requestId}#0`,
        version: 0,
        launch,
      });
      const bound = await bindEvidenceDirectory(
        store,
        "owner",
        requestId,
        0,
        inputHash,
        directoryIdentity(statSync(root)),
      );
      const sibling = mkdtempSync(path.join(tmpdir(), "qsb-evidence-"));
      expect(
        compareDirectoryIdentity(
          bound.evidenceDirectory!,
          directoryIdentity(statSync(sibling)),
        ),
      ).toBe("replaced");
      expect(compareDirectoryIdentity(bound.evidenceDirectory!, undefined)).toBe(
        "missing",
      );
      const missing = await recordLocalLoss(
        store,
        "owner",
        requestId,
        0,
        inputHash,
        "evidence-directory-missing",
      );
      expect(missing.state).toBe("terminal");
      expect(missing.evidence?.bundle).toEqual({ kept: true });
      expect(missing.evidenceDirectory?.inode).toBe(bound.evidenceDirectory?.inode);
      expect(missing.providerId).toBe("provider-1");
      expect(remoteWorkStopProven(missing)).toBe(false);
      rmSync(sibling, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rehearses interruption, deadline, and evidence on this machine only", async () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(contract.broadcastAuthorized).toBe(false);
    const root = mkdtempSync(path.join(tmpdir(), "qsb-lifecycle-"));
    try {
      const report = await rehearseLocalLifecycle(path.join(root, "evidence"));
      expect(report.selectedHost).toBe(false);
      expect(report.certifiesProductionHost).toBe(false);
      expect(report.interrupted).toBe(true);
      expect(report.processExited).toBe(true);
      expect(report.processAliveAfterInterrupt).toBe(false);
      expect(report.remoteStopProven).toBe(false);
      expect(report.providerIdPreserved).toBe(true);
      expect(report.providerSubmissionsPreserved).toBe(true);
      expect(report.evidenceReadableAfterShutdown).toBe(true);
      expect(report.directoryReplacementDetected).toBe(true);
      expect(report.missingDirectoryDetected).toBe(true);
      expect(report.deadlineExpired).toBe(true);
      expect(report.searchSuccess).toBe(false);
      expect(report.mainnetEnabled).toBe(false);
      expect(report.broadcastAuthorized).toBe(false);
      expect(report.operatorStep).toContain("selected host");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${path.join(root, "evidence")}-sibling`, { recursive: true, force: true });
    }
  });
});
