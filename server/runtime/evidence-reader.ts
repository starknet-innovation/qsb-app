import { fingerprint } from "../../src/lib/provenance";
import { validateSolvedState } from "../../src/mainnet/solvedContract";
import type { Store } from "../store";
import { assertSearchCapability, GateError } from "./capability";
import { launchRecordSchema } from "./types";

/** Reads durable terminal evidence. It does not read a developer work directory. */
export async function readAdmittedSolvedBundle(
  store: Store,
  owner: string,
  jobId: string,
): Promise<{ bundle: ReturnType<typeof validateSolvedState>; bundleSha256: string }> {
  await assertSearchCapability(store);
  const rows = await store.list(`OWNER#${owner}`, `LAUNCH#${jobId}#`);
  if (!rows.length) throw new GateError(404, "Solved state is not admitted.");
  const records = rows.map((row) => launchRecordSchema.parse(row.launch));
  const primary = records.find((record) => record.bindings.slot === 0);
  if (!primary?.evidence || primary.evidence.outcome !== "verified-hit")
    throw new GateError(404, "Solved state is not admitted.");
  if (
    primary.evidence.wholeRangeCovered !== false ||
    primary.evidence.hitVerified !== true ||
    primary.evidence.freshSearch !== false ||
    primary.evidence.binariesProduced !== false
  )
    throw new GateError(409, "A verified hit is not whole-range coverage.");
  if (primary.processId !== primary.evidence.processId)
    throw new GateError(409, "Solved evidence names a replaced process.");
  if (primary.acknowledgement?.searchSuccess !== false)
    throw new GateError(409, "Process acknowledgement is not search success.");
  for (const record of records) {
    if (record.bindings.slot === 0) continue;
    if (record.state !== "terminal" || record.evidence?.outcome !== "drained")
      throw new GateError(409, "Sibling work is not drained.");
  }
  const bundle = validateSolvedState(primary.evidence.bundle);
  if (fingerprint(bundle.request) !== primary.bindings.inputHash)
    throw new GateError(409, "Solved evidence does not match the stored request.");
  return { bundle, bundleSha256: fingerprint(bundle) };
}

export async function exportSigningHandoff(store: Store, owner: string, jobId: string) {
  const admitted = await readAdmittedSolvedBundle(store, owner, jobId);
  const primary = launchRecordSchema.parse(
    (await store.get(`OWNER#${owner}`, `LAUNCH#${jobId}#0`))?.launch,
  );
  const evidence = primary.evidence;
  if (!evidence) throw new GateError(404, "Solved state is not admitted.");
  return {
    format: "qsb-signing-handoff-v1" as const,
    network: "mainnet" as const,
    broadcastAuthorized: false as const,
    signingAuthorized: false as const,
    mainnetEnabled: false as const,
    coverage: "verified-hit-not-whole-range" as const,
    solverFacts: evidence.solverFacts,
    chainFacts: evidence.chainFacts,
    cpuVerification: evidence.cpuVerification,
    binariesProduced: false as const,
    freshSearch: false as const,
    siblingsDrained: true as const,
    bundle: admitted.bundle,
    bundleSha256: admitted.bundleSha256,
  };
}
