import { createHash } from "node:crypto";
import { fingerprint } from "../../src/lib/provenance";
import type { Store, Row } from "../../server/store";
import { admitInvocation } from "../archive/work/yukon-mainnet-service-enrollment-20260923/admission";
import { enrolledMainnet } from "../archive/work/yukon-mainnet-service-enrollment-20260923/capability";
import { signingReservations } from "../archive/work/yukon-service-solved-completion-20260923/reservations";
import type { LaunchRequest } from "../archive/work/yukon-mainnet-service-enrollment-20260923/dispatch";
export const DISTRIBUTION =
  "0efcca43ef7bd2599e2432c80724f1a1454e14a8c3ff2cd1ae2d4d66e346114d";
export const HOST = { pk: "SYSTEM#QSB_MAINNET_HOST", sk: "REGISTRY" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function hostRegistry(r: Row | null | undefined) {
  if (
    !r ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    r.enabled !== true ||
    r.format !== "qsb-fixed-linux-host-v1" ||
    r.distributionHash !== DISTRIBUTION ||
    r.region !== "eu-west-1" ||
    typeof r.table !== "string" ||
    !/^QsbYukonIsolated[A-Za-z0-9-]+$/.test(r.table) ||
    !Number.isSafeInteger(r.maxLifetimeMs) ||
    Number(r.maxLifetimeMs) < 1000 ||
    Number(r.maxLifetimeMs) > 1800000 ||
    !Number.isSafeInteger(r.maxActions) ||
    Number(r.maxActions) < 1 ||
    Number(r.maxActions) > 10000 ||
    !Number.isSafeInteger(r.pollIntervalMs) ||
    Number(r.pollIntervalMs) < 100 ||
    Number(r.pollIntervalMs) > 60000
  )
    throw Error("Fixed host registry disabled or invalid");
  return structuredClone(r);
}
/** Trusted local service only: reads and fences authority; no browser-supplied path/config/actuator. */
export async function claimHost(store: Store, input: LaunchRequest) {
  const request = structuredClone(input),
    pk = "OWNER#" + request.owner,
    sk = "V5_HOST_LAUNCH#" + request.jobId;
  const before = hostRegistry(await store.get(HOST.pk, HOST.sk));
  await admitInvocation(store, request.owner, request);
  const [job, inv, admission, registry] = await Promise.all([
    store.get(pk, "JOB#" + request.jobId),
    store.get(pk, "V5_INVOCATION#" + request.jobId),
    store.get(pk, "V5_ADMISSION#" + request.jobId),
    store.get(HOST.pk, HOST.sk),
  ]);
  if (
    !job ||
    !inv ||
    !admission ||
    !registry ||
    fingerprint(before) !== fingerprint(hostRegistry(registry)) ||
    fingerprint(JSON.parse(String(inv.request))) !== fingerprint(request) ||
    admission.requestHash !== fingerprint(request) ||
    (job.job as any).status !== "starting"
  )
    throw Error("Host invocation/admission changed");
  const vault = await store.get(pk, "VAULT#" + (job.job as any).vaultId);
  if (!vault) throw Error("Missing vault");
  const enrolled = await enrolledMainnet(
      store,
      request.owner,
      job.job,
      inv,
      vault.vault,
    ),
    reserved = await signingReservations(store, request.owner, job.job);
  const old = await store.get(pk, sk);
  if (old) throw Error("Host launch already claimed; reconcile, never respawn");
  const now = Date.now(),
    transport = enrolled.config,
    deadline = Math.min(
      now + Number(registry.maxLifetimeMs),
      transport.blueprint.pin.deadlineMs,
      transport.blueprint.subset.deadlineMs,
    );
  if (deadline <= now + 1000) throw Error("Insufficient bounded host lifetime");
  const config = {
    format: "qsb-common-operational-entry-v1",
    table: registry.table,
    region: registry.region,
    service: { owner: request.owner, request, session: 0 },
    transport,
    operations: [],
    driver: {
      mode: "adaptive",
      deadlineMs: deadline,
      maxActions: registry.maxActions,
      pollIntervalMs: registry.pollIntervalMs,
      pinSubmissionCutoffMs: transport.blueprint.pin.submissionCutoffMs,
      subsetSubmissionCutoffMs: transport.blueprint.subset.submissionCutoffMs,
    },
  };
  const bytes = JSON.stringify(config),
    row = {
      pk,
      sk,
      version: 1,
      format: "qsb-host-launch-claim-v1",
      status: "claimed",
      requestHash: fingerprint(request),
      registryHash: fingerprint(registry),
      invocationHash: fingerprint(inv),
      admissionHash: fingerprint(admission),
      configJson: bytes,
      configHash: hash(bytes),
      distributionHash: DISTRIBUTION,
      invocationId: request.invocationId,
      evidenceDirectory: "/evidence/host-" + request.invocationId,
      deadlineMs: deadline,
      claimedAtMs: now,
      searchRunning: false,
    };
  await store.atomicPut([
    { row },
    ...[job, inv, admission, vault, registry, enrolled.capability].map((row) => ({
      row,
      expected: row.version,
      conditionOnly: true,
    })),
    {
      row: reserved.authority,
      expected: reserved.authority.version,
      conditionOnly: true,
    },
    ...reserved.reservations.map((reservation) => ({
      row: reservation,
      expected: reservation.version,
      conditionOnly: true,
    })),
  ]);
  return structuredClone(row);
}
export async function preserveHostEvidence(
  store: Store,
  claim: Awaited<ReturnType<typeof claimHost>>,
  kind: "identity" | "terminal" | "unknown",
  evidence: unknown,
) {
  const current = await store.get(claim.pk, claim.sk);
  if (!current || fingerprint(current) !== fingerprint(claim))
    throw Error("Host claim changed");
  const sk = claim.sk + "#" + kind,
    record = {
      pk: claim.pk,
      sk,
      version: 1,
      claimHash: fingerprint(claim),
      evidence: structuredClone(evidence),
    },
    old = await store.get(claim.pk, sk);
  if (old) {
    if (fingerprint(old) !== fingerprint(record))
      throw Error("Host evidence differs");
    return old;
  }
  await store.atomicPut([
    { row: record },
    { row: current, expected: current.version, conditionOnly: true },
  ]);
  return record;
}
