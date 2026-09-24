import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { release } from "../src/lib/model";
import contract from "../server/mainnet-capability.json";
import { MemoryStore, type Row, type Store } from "../server/store";
import { AUTHORITY_PK, AUTHORITY_SK } from "../server/runtime/reservation-guard";
import { inventorySnapshot } from "../scripts/storage-inventory";
import {
  authorityDeleteAllowed,
  dynamoAuthorityDeleteCondition,
  dynamoReservationTransaction,
} from "../server/runtime/reservation-guard";
import {
  assessMigrationBackend,
  assertPermissionSeparation,
  canonicalReservationWrites,
  enableInProcessWriterExclusion,
  exportSnapshot,
  importSnapshot,
  inferDrainFromAggregate,
  inventoryRows,
  legacyReservationWrite,
  localRollbackCoverage,
  memoryRows,
  permissionModel,
  preservationFailures,
  rollbackCanonicalAcceptance,
} from "../server/runtime/storage-authority";

const txid = (byte: string) => byte.repeat(32);

function durableRows(): Row[] {
  return [
    {
      pk: "COMMITMENT#one",
      sk: "COMMITMENT#once",
      version: 0,
      consumed: true,
      requestHash: "ab".repeat(32),
    },
    {
      pk: "REQUEST#one",
      sk: "REQUEST#original",
      version: 0,
      requestHash: "cd".repeat(32),
      request: { id: "original-request" },
    },
    {
      pk: "COVERAGE#one",
      sk: "COVERAGE#pin",
      version: 0,
      completed: true,
      wholeRangeCovered: false,
      pin: "pin-a",
    },
    {
      pk: "CLEANUP#one",
      sk: "CLEANUP#history",
      version: 0,
      entries: ["cancelled-local-process", "retained-provider"],
    },
    {
      pk: `OUTPOINT#${txid("11")}:0`,
      sk: "RESERVATION",
      version: 0,
      owner: "owner",
      jobId: "job-1",
    },
    {
      pk: "OWNER#owner",
      sk: "JOB#job-1",
      version: 2,
      job: {
        id: "job-1",
        manifestHash: "ef".repeat(32),
        mainnetRequestHash: "cd".repeat(32),
        coverage: "verified-hit-not-whole-range",
        runpodId: "provider-1",
        error: "Submission outcome unknown. Reconcile before resuming.",
        execution: { profile: { id: "qsb-supervised-pin-v4-subset-v5" } },
        solver: { descriptor: { id: "qsb-config-a-ranked-v2-2791ed0" } },
      },
    },
    {
      pk: "OWNER#owner",
      sk: "LAUNCH#job-1#0",
      version: 3,
      launch: {
        providerId: "provider-1",
        providerOutcome: "uncertain",
        providerSubmissions: 1,
        evidence: { wholeRangeCovered: false, freshSearch: false },
      },
    },
    {
      pk: "RELEASE#historical",
      sk: "RELEASE#descriptor",
      version: 0,
      releaseId: "qsb-config-a-ranked-v2-2791ed0",
    },
    {
      pk: "CUSTOM#unknown",
      sk: "NOTE",
      version: 0,
      note: "keep-unclassified",
    },
    {
      pk: AUTHORITY_PK,
      sk: AUTHORITY_SK,
      version: 0,
      format: "qsb-reservation-authority-v1",
      generation: 1,
      legacyExcluded: true,
      canonicalAccepting: true,
      productionEnforcement: false,
      control: "store-transaction-condition",
      mainnetEnabled: false,
      broadcastAuthorized: false,
    },
  ];
}

describe("durable storage authority rehearsal", () => {
  it("keeps the permission model separate and refuses live IAM claims", () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(contract.broadcastAuthorized).toBe(false);
    expect(() => assertPermissionSeparation()).not.toThrow();
    expect(permissionModel.productionIamReviewed).toBe(false);
    expect(permissionModel.livePermissionsVerified).toBe(false);
    expect(permissionModel.roles.api.secrets).toEqual([]);
    expect(permissionModel.roles.runtime.secrets).toEqual(["GetSecretValue"]);
    expect(permissionModel.roles.operator.maySetMainnetEnabled).toBe(false);
    expect(() =>
      assertPermissionSeparation({
        ...permissionModel,
        roles: {
          ...permissionModel.roles,
          api: { ...permissionModel.roles.api, secrets: ["GetSecretValue"] },
        },
      }),
    ).toThrow(/ApiRoleMustNotReadRuntimeSecrets/);
    expect(() =>
      assertPermissionSeparation({
        ...permissionModel,
        productionIamReviewed: true,
      }),
    ).toThrow(/LiveIamNotReviewed/);
    expect(permissionModel.roles.operator.data).toContain("TransactWriteItems");
    expect(permissionModel.roles.operator.data).toContain("Scan");
    expect(permissionModel.roles.operator.data).not.toContain("PutItem");
    expect(permissionModel.roles.operator.data).not.toContain("DeleteItem");
    expect(permissionModel.roles.api.data).not.toContain("Scan");
    expect(permissionModel.roles.runtime.data).not.toContain("Scan");
    expect(() =>
      assertPermissionSeparation({
        ...permissionModel,
        roles: {
          ...permissionModel.roles,
          operator: {
            ...permissionModel.roles.operator,
            data: ["GetItem", "Query", "Scan"],
          },
        },
      }),
    ).toThrow(/OperatorAuthorityMutationRequiresTransaction/);
    expect(() =>
      assertPermissionSeparation({
        ...permissionModel,
        roles: {
          ...permissionModel.roles,
          operator: {
            ...permissionModel.roles.operator,
            data: ["GetItem", "Query", "Scan", "PutItem", "TransactWriteItems"],
          },
        },
      }),
    ).toThrow(/OperatorPutItemIsNotAuthorityScoped/);
  });

  it("inventories supplied rows without treating them as global freshness", () => {
    const report = inventoryRows(durableRows(), {
      callerClaimsCompleteExport: true,
    });
    expect(report.globalFreshness).toBe(false);
    expect(report.partialPublicExclusionListIsFreshness).toBe(false);
    expect(report.callerClaimIgnored).toBe(true);
    expect(report.accountedRowCount).toBe(report.suppliedRowCount);
    expect(report.counts["one-time-commitment"]).toBe(1);
    expect(report.counts.reservation).toBe(1);
    expect(report.counts.job).toBe(1);
    expect(report.counts.launch).toBe(1);
    expect(report.counts["provider-identity"]).toBe(2);
    expect(report.counts["unknown-submission"]).toBe(2);
    expect(report.counts.release).toBe(2);
    expect(report.counts["completed-coverage"]).toBe(2);
    expect(report.counts["original-request"]).toBe(2);
    expect(report.counts["cleanup-history"]).toBe(1);
    expect(report.counts.unclassified).toBe(1);
    expect(report.omissions.join(" ")).toContain("not global freshness");
    expect(() => inventoryRows([{ pk: "A", sk: "B", version: 0, apiKey: "no" }])).toThrow(
      /CredentialMaterialRejected/,
    );
  });

  it("excludes the old reservation shape inside this process and stops it on rollback", async () => {
    const store = new MemoryStore();
    await store.put(durableRows()[0]!);
    await store.put(durableRows()[4]!);
    await store.put(durableRows()[6]!);
    await expect(
      enableInProcessWriterExclusion(store, "frontend-flag"),
    ).rejects.toThrow(/InsufficientWriterExclusion/);
    await expect(
      enableInProcessWriterExclusion(store, "capability-marker"),
    ).rejects.toThrow(/InsufficientWriterExclusion/);
    await expect(
      enableInProcessWriterExclusion(store, "paused-workflow"),
    ).rejects.toThrow(/InsufficientWriterExclusion/);
    expect(await store.get(AUTHORITY_PK, AUTHORITY_SK)).toBeUndefined();
    await expect(
      store.put({
        pk: AUTHORITY_PK,
        sk: AUTHORITY_SK,
        version: 0,
        legacyExcluded: true,
        canonicalAccepting: true,
        productionEnforcement: true,
        control: "store-transaction-condition",
        generation: 1,
        mainnetEnabled: false,
        broadcastAuthorized: false,
      }),
    ).rejects.toThrow(/ProductionEnforcementRefused/);
    await enableInProcessWriterExclusion(store, "store-transaction-condition");
    await expect(
      legacyReservationWrite(store, {
        owner: "owner",
        jobId: "job-2",
        txid: txid("33"),
        vout: 0,
      }),
    ).rejects.toThrow(/LegacyWriterExcluded/);
    const admitted = await canonicalReservationWrites(store, [
      { owner: "owner", jobId: "job-2", txid: txid("33"), vout: 0 },
    ]);
    await store.atomicPut(admitted);
    const reserved = await store.get(`OUTPOINT#${txid("33")}:0`, "RESERVATION");
    expect(reserved?.authorityGeneration).toBe(1);
    const stopped = await rollbackCanonicalAcceptance(store);
    expect(stopped.legacyExcluded).toBe(true);
    expect(stopped.canonicalAccepting).toBe(false);
    expect(stopped.productionEnforcement).toBe(false);
    expect(stopped.awsLegacyWriterDenied).toBe(false);
    expect(stopped.rollbackScope).toBe("local-dry-run");
    expect(localRollbackCoverage()).toEqual({
      scope: "local-dry-run",
      deniesLegacyWriterInAws: false,
      reason: expect.stringContaining("does not deny dynamodb:PutItem"),
    });
    await expect(
      legacyReservationWrite(store, {
        owner: "owner",
        jobId: "job-3",
        txid: txid("44"),
        vout: 0,
      }),
    ).rejects.toThrow(/ReservationAuthorityStopped/);
    await expect(
      canonicalReservationWrites(store, [
        { owner: "owner", jobId: "job-3", txid: txid("44"), vout: 1 },
      ]),
    ).rejects.toThrow(/ReservationAuthorityStopped/);
    await expect(store.delete(AUTHORITY_PK, AUTHORITY_SK, stopped.version)).rejects.toThrow(
      /RollbackWouldReviveWriters/,
    );
    await expect(
      store.put(
        { ...stopped, version: stopped.version + 1, legacyExcluded: false },
        stopped.version,
      ),
    ).rejects.toThrow(/RollbackWouldReviveWriters/);
    await expect(
      store.put(
        { ...stopped, version: stopped.version + 1, canonicalAccepting: true },
        stopped.version,
      ),
    ).rejects.toThrow(/RollbackWouldReviveWriters/);
    expect((await store.get("COMMITMENT#one", "COMMITMENT#once"))?.consumed).toBe(true);
    expect(
      (await store.get("OWNER#owner", "LAUNCH#job-1#0"))?.launch,
    ).toMatchObject({
      providerId: "provider-1",
      providerOutcome: "uncertain",
      providerSubmissions: 1,
    });
    expect(await store.get(`OUTPOINT#${txid("11")}:0`, "RESERVATION")).toMatchObject({
      owner: "owner",
      jobId: "job-1",
    });
    const mixed = txid("ab").toUpperCase();
    const inner = new MemoryStore();
    const events: string[] = [];
    const aliasStore: Store = {
      get: (pk, sk) => inner.get(pk, sk),
      put: (row, expected) => inner.put(row, expected),
      delete: async (pk, sk, expected) => {
        events.push("delete-item");
        await inner.delete(pk, sk, expected);
      },
      list: (pk, prefix) => inner.list(pk, prefix),
      reservationRows: async () => {
        const authority = await inner.get(AUTHORITY_PK, AUTHORITY_SK);
        events.push(
          authority?.legacyExcluded === true && authority.canonicalAccepting === false
            ? "scan-under-fence"
            : "scan-open",
        );
        return inner.reservationRows();
      },
      atomicPut: async (writes) => {
        if (
          writes.some(
            (write) =>
              write.row.pk === AUTHORITY_PK &&
              write.row.canonicalAccepting === false &&
              write.conditionOnly !== true,
          )
        )
          events.push("fence");
        if (writes.some((write) => write.remove === true)) events.push("transact-delete");
        if (
          writes.some(
            (write) =>
              write.row.pk === AUTHORITY_PK &&
              write.row.canonicalAccepting === true &&
              write.conditionOnly !== true,
          )
        )
          events.push("accept");
        await inner.atomicPut(writes);
      },
    };
    await aliasStore.put({
      pk: `OUTPOINT#${mixed}:0`,
      sk: "RESERVATION",
      version: 0,
      owner: "owner",
      jobId: "job-legacy",
    });
    const pendingAdmission = await canonicalReservationWrites(aliasStore, [
      { owner: "other", jobId: "job-new", txid: mixed.toLowerCase(), vout: 0 },
    ]);
    expect(events).toEqual([]);
    expect(pendingAdmission.some((write) => write.row.pk === `OUTPOINT#${mixed.toLowerCase()}:0`)).toBe(
      true,
    );
    await enableInProcessWriterExclusion(aliasStore, "store-transaction-condition");
    expect(events).toEqual(["fence", "scan-under-fence", "transact-delete", "accept"]);
    expect(events).not.toContain("delete-item");
    expect(await inner.get(`OUTPOINT#${mixed}:0`, "RESERVATION")).toBeUndefined();
    expect(
      await inner.get(`OUTPOINT#${mixed.toLowerCase()}:0`, "RESERVATION"),
    ).toMatchObject({ owner: "owner", jobId: "job-legacy" });
    expect((await inner.get(AUTHORITY_PK, AUTHORITY_SK))?.canonicalAccepting).toBe(true);
    const conflictStore = new MemoryStore();
    await conflictStore.put({
      pk: `OUTPOINT#${mixed}:1`,
      sk: "RESERVATION",
      version: 0,
      owner: "owner",
      jobId: "job-a",
    });
    await conflictStore.put({
      pk: `OUTPOINT#${mixed.toLowerCase()}:1`,
      sk: "RESERVATION",
      version: 0,
      owner: "owner",
      jobId: "job-b",
    });
    await expect(
      enableInProcessWriterExclusion(conflictStore, "store-transaction-condition"),
    ).rejects.toThrow(/ReservationAliasConflict/);
    expect(await conflictStore.get(AUTHORITY_PK, AUTHORITY_SK)).toMatchObject({
      legacyExcluded: true,
      canonicalAccepting: false,
    });
    await expect(
      legacyReservationWrite(conflictStore, {
        owner: "owner",
        jobId: "job-c",
        txid: txid("77"),
        vout: 0,
      }),
    ).rejects.toThrow(/ReservationAuthorityStopped/);
    await expect(
      canonicalReservationWrites(conflictStore, [
        { owner: "owner", jobId: "job-c", txid: txid("77"), vout: 1 },
      ]),
    ).rejects.toThrow(/ReservationAuthorityStopped/);
    expect(inferDrainFromAggregate({ running: 0, queued: 0 })).toEqual({
      drainProven: false,
      completionProven: false,
      reason: expect.stringContaining("Aggregate provider counters"),
    });
  });

  it("admits distinct outpoints without rewriting the authority version", async () => {
    const store = new MemoryStore();
    await enableInProcessWriterExclusion(store, "store-transaction-condition");
    const before = await store.get(AUTHORITY_PK, AUTHORITY_SK);
    const first = await canonicalReservationWrites(store, [
      { owner: "a", jobId: "j1", txid: txid("55"), vout: 0 },
    ]);
    const second = await canonicalReservationWrites(store, [
      { owner: "b", jobId: "j2", txid: txid("66"), vout: 1 },
    ]);
    expect(first.some((write) => write.conditionOnly)).toBe(true);
    expect(first.some((write) => write.row.version !== before?.version && write.row.pk === AUTHORITY_PK)).toBe(
      false,
    );
    await Promise.all([store.atomicPut(first), store.atomicPut(second)]);
    expect((await store.get(AUTHORITY_PK, AUTHORITY_SK))?.version).toBe(before?.version);
    expect(await store.get(`OUTPOINT#${txid("55")}:0`, "RESERVATION")).toBeTruthy();
    expect(await store.get(`OUTPOINT#${txid("66")}:1`, "RESERVATION")).toBeTruthy();
    const duplicate = await canonicalReservationWrites(store, [
      { owner: "c", jobId: "j3", txid: txid("55"), vout: 0 },
    ]);
    await expect(store.atomicPut(duplicate)).rejects.toThrow(/reserved|Concurrent/);
  });

  it("preserves commitments, coverage, unknown submissions, and cleanup across a memory restart", async () => {
    const source = new MemoryStore();
    for (const row of durableRows().filter((row) => row.pk !== AUTHORITY_PK))
      await source.put(row);
    await enableInProcessWriterExclusion(source, "store-transaction-condition");
    const snapshot = exportSnapshot(memoryRows(source));
    const poisoned = structuredClone(snapshot);
    (poisoned.rows[0] as Row).apiKey = "synthetic";
    const rejected = new MemoryStore();
    await expect(importSnapshot(rejected, poisoned)).rejects.toThrow(
      /CredentialMaterialRejected/,
    );
    expect(rejected.rows.size).toBe(0);
    const duplicated = structuredClone(snapshot);
    duplicated.rows.push(structuredClone(duplicated.rows[0]!));
    const duplicateTarget = new MemoryStore();
    await expect(importSnapshot(duplicateTarget, duplicated)).rejects.toThrow(
      /SnapshotDuplicateKey/,
    );
    expect(duplicateTarget.rows.size).toBe(0);
    const invalidAuthority = structuredClone(snapshot);
    const authorityRow = invalidAuthority.rows.find((row) => row.pk === AUTHORITY_PK);
    authorityRow!.productionEnforcement = true;
    const authorityTarget = new MemoryStore();
    await expect(importSnapshot(authorityTarget, invalidAuthority)).rejects.toThrow(
      /ProductionEnforcementRefused/,
    );
    expect(authorityTarget.rows.size).toBe(0);
    expect(snapshot.globalFreshness).toBe(false);
    expect(snapshot.productionCutover).toBe(false);
    expect(snapshot.dynamodbLocalCertifiesIam).toBe(false);
    const restarted = new MemoryStore();
    const report = await importSnapshot(restarted, snapshot);
    expect(report).toMatchObject({
      backend: "memory-store",
      rehearsal: true,
      productionCutoverCertified: false,
      iamCertified: false,
      globalFreshness: false,
      preserved: true,
    });
    const again = exportSnapshot(memoryRows(restarted));
    const third = new MemoryStore();
    await importSnapshot(third, again);
    expect(preservationFailures(memoryRows(source), memoryRows(third))).toEqual([]);
    await expect(
      legacyReservationWrite(third, {
        owner: "owner",
        jobId: "job-9",
        txid: txid("77"),
        vout: 0,
      }),
    ).rejects.toThrow(/LegacyWriterExcluded/);
    const local = assessMigrationBackend("dynamodb-local");
    expect(local.iamCertified).toBe(false);
    expect(local.productionCutoverCertified).toBe(false);
    expect(local.reason).toContain("DynamoDB Local");
    await expect(
      importSnapshot(new MemoryStore(), { ...snapshot, backend: "dynamodb-local" }),
    ).rejects.toThrow(/DynamoDB Local/);
    expect(assessMigrationBackend("regional-dynamodb").rehearsal).toBe(false);

    const released = structuredClone(memoryRows(third));
    const commitment = released.find((row) => row.sk.startsWith("COMMITMENT#"));
    commitment!.consumed = false;
    expect(preservationFailures(memoryRows(third), released)).toContain(
      "RollbackWouldReleaseCommitment",
    );
    const widened = structuredClone(memoryRows(third));
    const coverage = widened.find((row) => row.sk.startsWith("COVERAGE#"));
    coverage!.wholeRangeCovered = true;
    expect(preservationFailures(memoryRows(third), widened)).toContain(
      "CoverageWidened",
    );
    const reset = structuredClone(memoryRows(third));
    const launch = reset.find((row) => row.sk.startsWith("LAUNCH#"));
    (launch!.launch as { providerOutcome: string }).providerOutcome = "not-submitted";
    expect(preservationFailures(memoryRows(third), reset)).toContain(
      "RollbackWouldDuplicatePaidWork",
    );
    const shrunk = structuredClone(memoryRows(third));
    const cleanup = shrunk.find((row) => row.sk.startsWith("CLEANUP#"));
    cleanup!.entries = ["cancelled-local-process"];
    expect(preservationFailures(memoryRows(third), shrunk)).toContain(
      "CleanupHistoryShrunk",
    );
    const revived = structuredClone(memoryRows(third));
    const authority = revived.find((row) => row.pk === AUTHORITY_PK);
    authority!.legacyExcluded = false;
    expect(preservationFailures(memoryRows(third), revived)).toContain(
      "RollbackWouldReviveWriters",
    );
    const droppedCoverage = structuredClone(memoryRows(third));
    const covered = droppedCoverage.find((row) => row.sk.startsWith("JOB#"));
    (covered!.job as { coverage: string }).coverage = "none";
    expect(preservationFailures(memoryRows(third), droppedCoverage)).toContain(
      "CompletedCoverageDropped",
    );
    const droppedJob = structuredClone(memoryRows(third));
    const legacy = droppedJob.find((row) => row.sk === "JOB#job-1");
    delete legacy!.job;
    expect(preservationFailures(memoryRows(third), droppedJob)).toContain(
      "JobPayloadDropped",
    );
    const embedded = inventoryRows([
      {
        pk: "OWNER#owner",
        sk: "JOB#embedded",
        version: 1,
        job: {
          coverage: "verified-hit-not-whole-range",
          mainnetRequestHash: "ab".repeat(32),
          manifestHash: "cd".repeat(32),
        },
      },
    ]);
    expect(embedded.counts.job).toBe(1);
    expect(embedded.counts["completed-coverage"]).toBe(1);
    expect(embedded.counts["original-request"]).toBe(1);
    const legacyWrite = dynamoReservationTransaction([
      {
        row: {
          pk: `OUTPOINT#${txid("aa")}:0`,
          sk: "RESERVATION",
          version: 0,
          owner: "owner",
          jobId: "job-x",
        },
      },
    ]);
    expect(legacyWrite.at(-1)).toEqual({
      kind: "authority-absent",
      pk: AUTHORITY_PK,
      sk: AUTHORITY_SK,
      condition: "attribute_not_exists(pk)",
    });
    const creation = dynamoReservationTransaction([
      {
        row: {
          pk: AUTHORITY_PK,
          sk: AUTHORITY_SK,
          version: 0,
          legacyExcluded: true,
          canonicalAccepting: true,
          productionEnforcement: false,
        },
      },
    ]);
    expect(creation).toEqual([
      {
        kind: "put",
        pk: AUTHORITY_PK,
        sk: AUTHORITY_SK,
        condition: "attribute_not_exists(pk)",
      },
    ]);
    expect(creation[0]?.pk).toBe(legacyWrite.at(-1)?.pk);
    expect(creation[0]?.sk).toBe(legacyWrite.at(-1)?.sk);
    const held = dynamoReservationTransaction([
      {
        row: {
          pk: `OUTPOINT#${txid("bb")}:1`,
          sk: "RESERVATION",
          version: 0,
          authorityGeneration: 1,
        },
      },
      {
        row: {
          pk: AUTHORITY_PK,
          sk: AUTHORITY_SK,
          version: 4,
          generation: 1,
          legacyExcluded: true,
          canonicalAccepting: true,
          productionEnforcement: false,
        },
        expected: 4,
        conditionOnly: true,
      },
    ]);
    expect(held.at(-1)).toMatchObject({
      kind: "authority-generation",
      expectedVersion: 4,
      generation: 1,
      condition: "generation",
    });
    const uncertain = {
      pk: "OWNER#owner",
      sk: "JOB#legacy-unknown",
      version: 1,
      job: {
        status: "paused",
        error: "Submission outcome unknown. Reconcile Runpod before resuming.",
      },
    };
    const cleared = structuredClone(uncertain);
    (cleared.job as { status: string }).status = "queued";
    delete (cleared.job as { error?: string }).error;
    expect(preservationFailures([uncertain], [cleared])).toContain(
      "RollbackWouldDuplicatePaidWork",
    );
    const repinned = {
      pk: "OWNER#owner",
      sk: "JOB#pinned",
      version: 1,
      job: {
        execution: { profile: { id: "profile-a" } },
        solver: {
          descriptor: { id: "solver-a", releaseHash: "aa".repeat(32) },
          releaseHash: "bb".repeat(32),
        },
      },
    };
    const changedPin = structuredClone(repinned);
    (
      (changedPin.job as { solver: { descriptor: { id: string } } }).solver.descriptor
    ).id = "solver-b";
    expect(preservationFailures([repinned], [changedPin])).toContain(
      "ReleaseIdentityChanged",
    );
    const excluded = durableRows().find((row) => row.pk === AUTHORITY_PK)!;
    expect(authorityDeleteAllowed(excluded, 0)).toBe(false);
    expect(authorityDeleteAllowed({ ...excluded, legacyExcluded: false }, 0)).toBe(true);
    const deleteCondition = dynamoAuthorityDeleteCondition(0);
    expect(deleteCondition.ConditionExpression).toContain("#v = :v");
    expect(deleteCondition.ConditionExpression).toContain("#excluded");
    expect(deleteCondition.ExpressionAttributeValues[":v"]).toBe(0);
    expect(deleteCondition.ExpressionAttributeValues[":false"]).toBe(false);
    const searching = {
      pk: "OWNER#owner",
      sk: "JOB#searching-without-provider",
      version: 1,
      job: { status: "searching" },
    };
    expect(inventoryRows([searching]).counts["unknown-submission"]).toBe(1);
    const replayed = structuredClone(searching);
    (replayed.job as { status: string }).status = "queued";
    expect(preservationFailures([searching], [replayed])).toContain(
      "RollbackWouldDuplicatePaidWork",
    );
    const reconciled = structuredClone(searching);
    (reconciled.job as { status: string; error?: string }).status = "paused";
    (reconciled.job as { error?: string }).error =
      "Submission outcome unknown. Reconcile Runpod before resuming.";
    expect(preservationFailures([searching], [reconciled])).toEqual([]);
    const withCleanup = {
      pk: "OWNER#owner",
      sk: "JOB#embedded-cleanup",
      version: 1,
      job: { status: "queued" },
      validation: {
        active: [{ attempt: 1, id: "provider-1" }],
        cancel: ["provider-1"],
        interrupted: [{ attempt: 0 }],
        completed: 3,
      },
    };
    expect(inventoryRows([withCleanup]).counts["cleanup-history"]).toBe(1);
    expect(inventoryRows([withCleanup]).counts["completed-coverage"]).toBe(1);
    const droppedCleanup = structuredClone(withCleanup);
    droppedCleanup.validation.active = [];
    expect(preservationFailures([withCleanup], [droppedCleanup])).toContain(
      "CleanupHistoryShrunk",
    );
    const droppedCompleted = structuredClone(withCleanup);
    droppedCompleted.validation.completed = 1;
    expect(preservationFailures([withCleanup], [droppedCompleted])).toContain(
      "CompletedCoverageDropped",
    );
    const nestedCleanup = {
      pk: "OWNER#owner",
      sk: "JOB#nested-cleanup",
      version: 1,
      job: {
        validation: {
          active: [{ attempt: 1, id: "provider-1" }],
          cancel: ["provider-1"],
          interrupted: [{ attempt: 0 }],
        },
      },
    };
    expect(inventoryRows([nestedCleanup]).counts["cleanup-history"]).toBe(1);
    const hiddenTopLevel: Row = {
      pk: withCleanup.pk,
      sk: withCleanup.sk,
      version: withCleanup.version,
      job: {
        status: "queued",
        validation: structuredClone(withCleanup.validation),
      },
    };
    expect(preservationFailures([withCleanup], [hiddenTopLevel])).toContain(
      "CleanupHistoryShrunk",
    );
  });

  it("runs the inventory command on a snapshot file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qsb-inventory-"));
    try {
      const file = path.join(root, "snapshot.json");
      writeFileSync(file, JSON.stringify({ rows: durableRows(), globalFreshness: false }));
      const report = inventorySnapshot(JSON.parse(readFileSync(file, "utf8")));
      expect(report.globalFreshness).toBe(false);
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/storage-inventory.ts", file],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output).globalFreshness).toBe(false);
      expect(JSON.parse(output).suppliedRowCount).toBe(durableRows().length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
