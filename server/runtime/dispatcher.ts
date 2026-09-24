import { z } from "zod";
import { fingerprint, pinSolver, vaultConfiguration } from "../../src/lib/provenance";
import {
  type PublicVault,
  withdrawalSchema,
} from "../../src/lib/model";
import { Conflict, type Store } from "../store";
import { validateRequest } from "../../src/mainnet/solvedContract";
import { MAINNET_SEARCH_PROFILE } from "../../src/mainnet/submission";
import { assertSearchCapability, assertServiceChain, GateError } from "./capability";
import {
  claimLaunch,
  type SupervisedJob,
} from "./host-bridge";
import { RELEASE_MANIFEST_FORMAT, type LaunchBindings } from "./types";

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

export async function admitSupervisedJob(
  store: Store,
  owner: string,
  serviceNetwork: string,
  body: unknown,
): Promise<{ job: SupervisedJob; created: boolean }> {
  assertServiceChain(serviceNetwork);
  await assertSearchCapability(store);
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
  const id = request.manifest.idempotencyKey;
  const requestHash = fingerprint(request);
  const existing = await store.get(pk, `JOB#${id}`);
  if (existing) {
    const job = existing.job as SupervisedJob;
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
    solver: pinSolver(vault),
    execution: {
      kind: "qsb-supervised-service-v1",
      network: "mainnet",
      profile: { id: MAINNET_SEARCH_PROFILE },
      sourceManifestFormat: RELEASE_MANIFEST_FORMAT,
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
      ...[request.manifest.funding, request.manifest.helper].map((point) => ({
        row: {
          pk: `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
          sk: "RESERVATION",
          version: 0,
          owner,
          jobId: id,
        },
      })),
    ]);
  } catch (error) {
    if (error instanceof Conflict)
      throw new GateError(409, "Outpoint already reserved.");
    throw error;
  }
  return { job: stored, created: true };
}

export async function claimAdmittedLaunch(
  store: Store,
  owner: string,
  jobId: string,
) {
  await assertSearchCapability(store);
  const pk = `OWNER#${owner}`;
  const jobRow = await store.get(pk, `JOB#${jobId}`);
  if (!jobRow) throw new GateError(404, "Job not found");
  const job = jobRow.job as SupervisedJob;
  const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
  if (!vaultRow) throw new GateError(404, "Vault not found");
  const vault = vaultRow.vault as PublicVault;
  const configuration = vault.configuration ?? vaultConfiguration(vault);
  return claimLaunch(store, vault, {
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
      nativeBinariesEnrolled: false,
      broadcastAuthorized: false,
    },
    inputHash: job.mainnetRequestHash,
  });
}
