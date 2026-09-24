/** Recover a known provider ID from bound completed evidence; never submit or resume. */
import type { Store } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { PinInventoryV3 } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import { PIN_RESEARCH_RELEASE, PIN_RESEARCH_RELEASE_ID } from "./pin_route";
import { decodeResearchQueueCompletion } from "./pin_store";
import { createPinVerifier } from "./pin_verifier";

export async function reconcileResearchPin(
  store: Store,
  binding: { scope: string; owner: string; revision: number; intent: string },
  providerId: string,
  read: (endpoint: string, id: string) => Promise<unknown>,
) {
  const b = structuredClone(binding);
  if (
    !/^isolated-yukon-[a-z0-9-]+$/.test(b.scope) ||
    !/^PIN#(0|[1-9][0-9]*)$/.test(b.intent) ||
    typeof providerId !== "string" ||
    !providerId ||
    providerId.length > 512
  )
    throw Error("Invalid reconciliation binding");
  const pk = "VALIDATION#" + b.scope,
    scope = await store.get(pk, "SCOPE"),
    intent = await store.get(pk, b.intent);
  if (
    !scope ||
    !intent ||
    scope.owner !== b.owner ||
    intent.owner !== b.owner ||
    intent.revision !== b.revision ||
    !["uncertain", "attached"].includes(intent.state as string) ||
    intent.terminal ||
    !Number.isSafeInteger(intent.dispatchAuthorizedAtMs) ||
    intent.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    scope.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    typeof intent.frozen !== "string" ||
    typeof scope.publicContext !== "string" ||
    typeof scope.endpoint !== "string" ||
    !scope.endpoint ||
    scope.expiresAt !== undefined ||
    intent.expiresAt !== undefined ||
    ["xbgi2q58lbyyls", "72cqi112b9t8qv"].includes(scope.endpoint)
  )
    throw Error("No submitted research intent to reconcile");
  const request = JSON.parse(intent.frozen),
    context = JSON.parse(scope.publicContext);
  if (fingerprint(context) !== scope.publicContextHash)
    throw Error("Changed public context");
  const raw = structuredClone(await read(scope.endpoint, providerId));
  const decoded = decodeResearchQueueCompletion(
    raw,
    request,
    PIN_RESEARCH_RELEASE.runtimeManifestSha256,
  );
  if (decoded.id !== providerId) throw Error("Provider identity mismatch");
  const verdict = await createPinVerifier()(
    request,
    decoded.output,
    context,
    PIN_RESEARCH_RELEASE.binarySha256,
  );
  const receipt = {
    providerId,
    providerResultHash: fingerprint(raw),
    contextHash: scope.publicContextHash,
    requestHash: fingerprint(request),
    reference: verdict,
    releaseStatus: "HOLD",
    rangeCreditGranted: false,
  };
  const guarded: Store = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    reservationRows: store.reservationRows.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    atomicPut: async (original) => {
      const writes = structuredClone(original);
      const s = writes.find((w) => w.row.pk === pk && w.row.sk === "SCOPE"),
        r = writes.find((w) => w.row.pk === pk && w.row.sk === b.intent);
      if (
        !s ||
        !r ||
        s.row.endpoint !== scope.endpoint ||
        s.row.publicContext !== scope.publicContext ||
        s.row.publicContextHash !== scope.publicContextHash ||
        s.row.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
        r.row.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
        r.row.frozen !== intent.frozen ||
        r.row.dispatchAuthorizedAtMs !== intent.dispatchAuthorizedAtMs ||
        r.row.terminal
      )
        throw Error("Reconciliation context changed");
      r.row.researchReconciliation = receipt;
      return store.atomicPut(writes);
    },
  };
  const inventory = new PinInventoryV3(guarded, b.scope, b.owner, b.revision);
  await inventory.attach(b.intent, providerId);
  return receipt;
}
