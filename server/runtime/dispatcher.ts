import { hex } from "@scure/base";
import { z } from "zod";
import { fingerprint, pinSolver, vaultConfiguration } from "../../src/lib/provenance";
import {
  release,
  type PublicVault,
  type Withdrawal,
  withdrawalSchema,
} from "../../src/lib/model";
import { outputScript } from "../../src/lib/transactions";
import { Conflict, type Row, type Store } from "../store";
import { validateRequest } from "../../src/mainnet/solvedContract";
import { MAINNET_SEARCH_PROFILE } from "../../src/mainnet/submission";
import contract from "../mainnet-capability.json";
import { assertSearchCapability, assertServiceChain, GateError } from "./capability";
import {
  claimLaunch,
  type SupervisedJob,
} from "./host-bridge";
import { coreSourceDigest } from "./package-release";
import { canonicalReservationWrites } from "./storage-authority";
import { RELEASE_MANIFEST_FORMAT, type LaunchBindings } from "./types";
import {
  canonicalOutpointKey,
  reservationAuthority,
} from "../../supervised/archive/work/yukon-canonical-reservations-20260923/reservations";

export type FundingLedger = {
  assertNetwork: () => Promise<void>;
  unspent: (
    point: { txid: string; vout: number; value: string },
    script: string,
  ) => Promise<unknown>;
};

const bodySchema = z
  .object({
    manifest: withdrawalSchema,
    execution: z
      .object({ releaseId: z.literal(MAINNET_SEARCH_PROFILE) })
      .strict(),
    request: z.unknown(),
  })
  .strict();

function reservations(job: SupervisedJob): LaunchBindings["reservations"] {
  return [job.manifest.funding, job.manifest.helper].map((point) => ({
    txid: point.txid,
    vout: point.vout,
  }));
}

async function enrolledReservationAuthority(store: Store): Promise<Row> {
  try {
    return await reservationAuthority(store);
  } catch (error) {
    throw new GateError(
      503,
      error instanceof Error
        ? error.message
        : "Canonical reservation authority not enrolled; legacy migration/writer exclusion required",
    );
  }
}

async function assertCanonicalFree(
  store: Store,
  points: { txid: string; vout: number }[],
): Promise<void> {
  for (const point of points) {
    if (await store.get(canonicalOutpointKey(point.txid, point.vout), "RESERVATION"))
      throw new GateError(409, "Outpoint already reserved.");
  }
}

async function currentReservation(
  store: Store,
  owner: string,
  jobId: string,
  point: { txid: string; vout: number },
): Promise<Row> {
  const row = await store.get(canonicalOutpointKey(point.txid, point.vout), "RESERVATION");
  if (!row || row.owner !== owner || row.jobId !== jobId)
    throw new GateError(409, "Outpoint reservation is no longer current.");
  return row;
}

function sameReservation(left: Row, right: Row | undefined): boolean {
  return (
    !!right &&
    left.pk === right.pk &&
    left.sk === right.sk &&
    left.version === right.version &&
    left.owner === right.owner &&
    left.jobId === right.jobId
  );
}

function authorizedCoreDigest(): string {
  const digest = coreSourceDigest(process.cwd());
  if (digest !== contract.coreSourceManifest)
    throw new GateError(503, "Supervised search capability is not active.");
  return digest;
}

function assertConfirmedFunding(
  owner: string,
  vault: PublicVault,
  manifest: Withdrawal,
): void {
  if (
    vault.status !== "confirmed" ||
    vault.network !== "mainnet" ||
    vault.paymentAddress !== owner ||
    !vault.funding ||
    fingerprint(vault.funding) !== fingerprint(manifest.funding) ||
    hex.encode(outputScript(manifest.destination)).toLowerCase() !==
      manifest.outputScript.toLowerCase() ||
    BigInt(manifest.outputValue) <= 0n ||
    BigInt(manifest.fee) <= 0n ||
    BigInt(manifest.funding.value) + BigInt(manifest.helper.value) !==
      BigInt(manifest.outputValue) + BigInt(manifest.fee)
  )
    throw new GateError(
      409,
      "Confirmed original mainnet owner, vault and route required.",
    );
}

async function assertSpendableFunding(
  ledger: FundingLedger,
  owner: string,
  vault: PublicVault,
  manifest: Withdrawal,
): Promise<void> {
  try {
    await ledger.assertNetwork();
    await ledger.unspent(manifest.funding, vault.scriptHex);
    await ledger.unspent(manifest.helper, hex.encode(outputScript(owner)));
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(409, "Confirmed vault funding is not spendable.");
  }
}

function assertVaultStillAdmitted(job: SupervisedJob, vault: PublicVault): void {
  if (vault.status !== "confirmed" || !vault.funding)
    throw new GateError(409, "Confirmed vault funding is no longer current.");
  if (fingerprint(vault.funding) !== fingerprint(job.manifest.funding))
    throw new GateError(409, "Confirmed vault funding is no longer current.");
  let solver: ReturnType<typeof pinSolver>;
  try {
    solver = pinSolver(vault);
  } catch {
    throw new GateError(409, "Vault solver pin no longer matches the admitted job.");
  }
  if (!job.solver || fingerprint(solver) !== fingerprint(job.solver))
    throw new GateError(409, "Vault solver pin no longer matches the admitted job.");
}

export async function admitSupervisedJob(
  store: Store,
  owner: string,
  serviceNetwork: string,
  body: unknown,
  ledger: FundingLedger,
): Promise<{ job: SupervisedJob; created: boolean }> {
  assertServiceChain(serviceNetwork);
  const capability = await assertSearchCapability(store);
  const authority = await enrolledReservationAuthority(store);
  const authorityHash = fingerprint(authority);
  const parsed = bodySchema.parse(body);
  let request: ReturnType<typeof validateRequest>;
  try {
    request = validateRequest(parsed.request);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new GateError(
      400,
      error instanceof Error ? error.message : "Invalid request",
    );
  }
  if (request.wallet.address !== owner || request.vault.paymentAddress !== owner)
    throw new GateError(409, "Wallet does not match this session.");
  if (fingerprint(parsed.manifest) !== fingerprint(request.manifest))
    throw new GateError(409, "Manifest does not match the original request.");
  if (parsed.execution.releaseId !== MAINNET_SEARCH_PROFILE)
    throw new GateError(409, "Unsupported supervised release.");
  const pk = `OWNER#${owner}`;
  const vaultRow = await store.get(pk, `VAULT#${request.id}`);
  if (!vaultRow) throw new GateError(404, "Vault not found");
  const vault = vaultRow.vault as PublicVault;
  if (fingerprint(vault) !== fingerprint(request.vault))
    throw new GateError(409, "Vault does not match the original request.");
  assertConfirmedFunding(owner, vault, request.manifest);
  const coreDigest = authorizedCoreDigest();
  const id = request.manifest.idempotencyKey;
  const requestHash = fingerprint(request);
  const existing = await store.get(pk, `JOB#${id}`);
  if (existing) {
    const job = existing.job as SupervisedJob;
    if (job.reservationAuthorityHash !== authorityHash)
      throw new GateError(409, "Job belongs to a different reservation authority.");
    if (job.mainnetRequestHash !== requestHash)
      throw new GateError(
        409,
        "Idempotency key already belongs to another withdrawal.",
      );
    return { job, created: false };
  }
  for (const row of await store.list(pk, "JOB#")) {
    const job = row.job as { id?: string; vaultId?: string };
    if (job.vaultId === request.id && job.id !== id)
      throw new GateError(409, "A job already exists for this vault.");
  }
  await assertSpendableFunding(ledger, owner, vault, request.manifest);
  await assertCanonicalFree(store, [request.manifest.funding, request.manifest.helper]);
  const now = new Date().toISOString();
  const job: SupervisedJob = {
    id,
    owner,
    vaultId: request.id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    stage: "pinning",
    manifest: request.manifest,
    manifestHash: fingerprint(request.manifest),
    mainnetRequestHash: requestHash,
    reservationAuthorityHash: authorityHash,
    solver: pinSolver(vault),
    execution: {
      kind: "qsb-supervised-service-v1",
      network: "mainnet",
      profile: { id: MAINNET_SEARCH_PROFILE },
      sourceManifestFormat: RELEASE_MANIFEST_FORMAT,
      coreSourceManifest: coreDigest,
      nativeBinariesEnrolled: false,
      broadcastAuthorized: false,
    },
    runtime: { state: "queued", searchRunning: false },
    solverFacts: "not-run",
    chainFacts: "not-run",
    coverage: "none",
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
  };
  const stored = { ...job };
  try {
    await store.atomicPut([
      { row: { pk, sk: `JOB#${id}`, version: 0, job: stored } },
      ...(await canonicalReservationWrites(
        store,
        [request.manifest.funding, request.manifest.helper].map((point) => ({
          owner,
          jobId: id,
          txid: point.txid,
          vout: point.vout,
        })),
      )),
      { row: capability, expected: capability.version },
      { row: authority, expected: authority.version },
    ]);
  } catch (error) {
    if (error instanceof Conflict) {
      if (
        error.message === "LegacyWriterExcluded" ||
        error.message === "ReservationAuthorityStopped" ||
        error.message === "ReservationAliasUnresolved"
      )
        throw new GateError(409, error.message);
      const raced = await store.get(pk, `JOB#${id}`);
      if (raced) {
        const racedJob = raced.job as SupervisedJob;
        if (
          racedJob.reservationAuthorityHash === authorityHash &&
          racedJob.mainnetRequestHash === requestHash
        )
          return { job: racedJob, created: false };
      }
      const currentAuthority = await store.get(authority.pk, authority.sk);
      if (
        !currentAuthority ||
        currentAuthority.version !== authority.version ||
        fingerprint(currentAuthority) !== authorityHash
      )
        throw new GateError(409, "Reservation authority changed.");
      const current = await store.get(capability.pk, capability.sk);
      if (
        !current ||
        current.version !== capability.version ||
        current.enabled !== true ||
        fingerprint(current.contract) !== fingerprint(capability.contract)
      )
        throw new GateError(503, "Supervised search capability is not active.");
      throw new GateError(409, "Outpoint already reserved.");
    }
    throw error;
  }
  return { job: stored, created: true };
}

export async function claimAdmittedLaunch(
  store: Store,
  owner: string,
  jobId: string,
  ledger: FundingLedger,
) {
  if (release.mainnetEnabled || contract.broadcastAuthorized)
    throw new GateError(503, "Supervised search capability is not active.");
  const capability = await assertSearchCapability(store);
  const authority = await enrolledReservationAuthority(store);
  const authorityHash = fingerprint(authority);
  const coreDigest = authorizedCoreDigest();
  const pk = `OWNER#${owner}`;
  const jobRow = await store.get(pk, `JOB#${jobId}`);
  if (!jobRow) throw new GateError(404, "Job not found");
  const job = jobRow.job as SupervisedJob;
  if (job.execution.coreSourceManifest !== coreDigest)
    throw new GateError(503, "Supervised search capability is not active.");
  if (job.reservationAuthorityHash !== authorityHash)
    throw new GateError(409, "Reservation authority changed.");
  for (;;) {
    const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
    if (!vaultRow) throw new GateError(404, "Vault not found");
    const vault = vaultRow.vault as PublicVault;
    assertVaultStillAdmitted(job, vault);
    await assertSpendableFunding(ledger, owner, vault, job.manifest);
    const fundingReservation = await currentReservation(
      store,
      owner,
      job.id,
      job.manifest.funding,
    );
    const helperReservation = await currentReservation(
      store,
      owner,
      job.id,
      job.manifest.helper,
    );
    const configuration = vault.configuration ?? vaultConfiguration(vault);
    const bindings: LaunchBindings = {
      owner,
      requestId: job.id,
      revision: job.revision,
      phase: job.stage,
      slot: 0,
      reservations: reservations(job),
      capability: "search-only",
      configurationHash: fingerprint(configuration),
      release: {
        profileId: job.execution.profile.id,
        sourceManifestFormat: job.execution.sourceManifestFormat,
        coreSourceManifest: coreDigest,
        nativeBinariesEnrolled: false,
        broadcastAuthorized: false,
      },
      inputHash: job.mainnetRequestHash,
    };
    const guarded: Store = {
      get: (rowPk, sk) => store.get(rowPk, sk),
      list: (rowPk, prefix) => store.list(rowPk, prefix),
      reservationRows: () => store.reservationRows(),
      put: (row, expected) => store.put(row, expected),
      delete: (rowPk, sk, expected) => store.delete(rowPk, sk, expected),
      atomicPut: (writes) =>
        store.atomicPut([
          ...writes,
          { row: capability, expected: capability.version },
          { row: authority, expected: authority.version },
          { row: vaultRow, expected: vaultRow.version },
          { row: fundingReservation, expected: fundingReservation.version },
          { row: helperReservation, expected: helperReservation.version },
        ]),
    };
    try {
      return await claimLaunch(guarded, vault, bindings);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      const currentVault = await store.get(pk, `VAULT#${job.vaultId}`);
      if (
        !currentVault ||
        currentVault.version !== vaultRow.version ||
        fingerprint(currentVault.vault) !== fingerprint(vault)
      )
        throw new GateError(409, "Confirmed vault funding is no longer current.");
      const currentFunding = await currentReservation(
        store,
        owner,
        job.id,
        job.manifest.funding,
      ).catch(() => undefined);
      const currentHelper = await currentReservation(
        store,
        owner,
        job.id,
        job.manifest.helper,
      ).catch(() => undefined);
      if (
        !sameReservation(fundingReservation, currentFunding) ||
        !sameReservation(helperReservation, currentHelper)
      )
        throw new GateError(409, "Outpoint reservation is no longer current.");
      const currentAuthority = await store.get(authority.pk, authority.sk);
      if (
        !currentAuthority ||
        currentAuthority.version !== authority.version ||
        fingerprint(currentAuthority) !== authorityHash
      )
        throw new GateError(409, "Reservation authority changed.");
      const current = await store.get(capability.pk, capability.sk);
      if (
        !current ||
        current.version !== capability.version ||
        current.enabled !== true ||
        fingerprint(current.contract) !== fingerprint(capability.contract)
      )
        throw new GateError(503, "Supervised search capability is not active.");
    }
  }
}
