/** Research-only submission composition; no live enrollment or provider credential access. */
import type { Store } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { PinInventoryV3 } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import {
  PIN_RESEARCH_RELEASE,
  PIN_RESEARCH_RELEASE_ID,
  PIN_RESEARCH_RELEASE_PK,
} from "./pin_route";
import { createPinPreflight } from "./pin_verifier";

/** send/preflight are trusted operator adapters, never request-supplied functions.
 * No retry of send. Uncertainty is retained by PinInventoryV3. A final database
 * fence cannot atomically revoke a POST already authorized and in flight.
 */
export async function submitResearchPin(
  store: Store,
  binding: { scope: string; owner: string; revision: number; attempt: number },
  rawRequest: unknown,
  adapters: {
    preflight: (
      endpoint: string,
      descriptor: typeof PIN_RESEARCH_RELEASE,
    ) => Promise<void>;
    send: (
      endpoint: string,
      input: { runtimeManifestSha256: string; request: unknown },
    ) => Promise<string>;
  },
) {
  const b = structuredClone(binding),
    request = structuredClone(rawRequest);
  if (!/^isolated-yukon-[a-z0-9-]+$/.test(b.scope))
    throw Error("Research scope required");
  const pk = "VALIDATION#" + b.scope;
  const scope = await store.get(pk, "SCOPE"),
    release = await store.get(PIN_RESEARCH_RELEASE_PK, PIN_RESEARCH_RELEASE_ID);
  if (
    !scope ||
    !release ||
    scope.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    release.enabled !== true ||
    release.researchExecutionEnabled !== true ||
    release.startupCapacityValidated !== true ||
    release.expiresAt !== undefined ||
    scope.expiresAt !== undefined ||
    fingerprint(release.descriptor) !== PIN_RESEARCH_RELEASE_ID ||
    !Array.isArray(release.scopes) ||
    !release.scopes.includes(b.scope) ||
    typeof release.endpoint !== "string" ||
    !release.endpoint ||
    release.endpoint !== scope.endpoint ||
    ["xbgi2q58lbyyls", "72cqi112b9t8qv"].includes(release.endpoint) ||
    typeof scope.publicContext !== "string"
  )
    throw Error("Research execution enrollment missing or blocked");
  const endpoint = release.endpoint;
  const context = JSON.parse(scope.publicContext);
  if (fingerprint(context) !== scope.publicContextHash)
    throw Error("Public context changed");
  await createPinPreflight()(
    request,
    context,
    PIN_RESEARCH_RELEASE.binarySha256,
  );
  const guarded: Store = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    reservationRows: store.reservationRows.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    atomicPut: async (original) => {
      const writes = structuredClone(original);
      const pin = writes.find(
        (w) => w.row.pk === pk && w.row.sk === "PIN#" + b.attempt,
      );
      const reservation =
        pin && pin.expected === undefined && pin.row.state === "reserved";
      const dispatch =
        pin && writes.length === 2 && pin.row.state === "uncertain";
      if (reservation || dispatch) {
        const s = writes.find((w) => w.row.pk === pk && w.row.sk === "SCOPE");
        if (
          !s ||
          s.row.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
          s.row.endpoint !== endpoint ||
          s.row.publicContextHash !== scope.publicContextHash ||
          s.row.publicContext !== scope.publicContext
        )
          throw Error("Research route changed before dispatch");
        if (reservation) pin.row.researchReleaseId = PIN_RESEARCH_RELEASE_ID;
        if (pin.row.researchReleaseId !== PIN_RESEARCH_RELEASE_ID)
          throw Error("Intent release changed");
        writes.push({
          row: release,
          expected: release.version,
          conditionOnly: true,
        });
      }
      // Identity journaling/attachment must survive revocation after the POST.
      return store.atomicPut(writes);
    },
  };
  const inventory = new PinInventoryV3(guarded, b.scope, b.owner, b.revision);
  await inventory.reserve(b.attempt, request, async (_payload, s) => {
    if (s.version !== scope.version)
      throw Error("Scope changed during CPU preflight");
  });
  return inventory.submit(
    "PIN#" + b.attempt,
    (payload) =>
      adapters.send(endpoint, {
        runtimeManifestSha256: PIN_RESEARCH_RELEASE.runtimeManifestSha256,
        request: payload,
      }),
    () => adapters.preflight(endpoint, PIN_RESEARCH_RELEASE),
  );
}
