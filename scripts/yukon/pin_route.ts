/** Explicit research-only receive route. Does not submit jobs or select a default solver. */
import type { Store } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import {
  decodeResearchQueueCompletion,
  publishResearchPin,
  prepareResearchSubset,
} from "./pin_store";
import { createPinVerifier, createPinHandoff } from "./pin_verifier";

export const PIN_RESEARCH_RELEASE = Object.freeze({
  protocol: "qsb-yukon-pin-queue-v1",
  binarySha256:
    "88cf46c45a63972e31af5f1c835a3b4088d6ea76af4b69e7bb0d7227d1562263",
  runtimeManifestSha256:
    "4e380441231fce434745d6116187aef06ad4086c8df9496948b65b880a7d9039",
  imageIndexSha256:
    "851855ef0d2d1e70f9b27dc60097d3ab44c15bd0f9bdd5b624b8d4da46b9f41e",
  imageManifestSha256:
    "01cfa2347438e42d5c682cb3d64e139e7e8a1cae22ef74424040cbe68712395c",
  purpose: "isolated-research",
  releaseStatus: "HOLD",
  dispatchAuthorized: false,
});
export const PIN_RESEARCH_RELEASE_ID = fingerprint(PIN_RESEARCH_RELEASE);
export const PIN_RESEARCH_RELEASE_PK = "SYSTEM#QSB_RESEARCH_RELEASES";

type Binding = Omit<Parameters<typeof publishResearchPin>[1], "binarySha256">;
/** Enrollment is trusted operator state; this function never creates or enables it. */
export async function receiveResearchPin(
  store: Store,
  binding: Binding,
  rawProviderResult: unknown,
) {
  const b = structuredClone(binding),
    provider = structuredClone(rawProviderResult);
  const { guarded, intent } = await selectResearchRoute(store, b);
  const decoded = decodeResearchQueueCompletion(
    provider,
    JSON.parse(intent.frozen as string),
    PIN_RESEARCH_RELEASE.runtimeManifestSha256,
  );
  return publishResearchPin(
    guarded,
    {
      ...b,
      binarySha256: PIN_RESEARCH_RELEASE.binarySha256,
    },
    decoded,
    createPinVerifier(),
  );
}

/** Fixed CPU exporter; observe is a trusted operator read adapter, never user input.
 * Preparing parameters grants neither paid dispatch nor production release approval.
 */
export async function handoffResearchPin(
  store: Store,
  binding: Binding,
  observe: Parameters<typeof prepareResearchSubset>[3],
) {
  const b = structuredClone(binding);
  const { guarded } = await selectResearchRoute(store, b);
  return prepareResearchSubset(
    guarded,
    { ...b, binarySha256: PIN_RESEARCH_RELEASE.binarySha256 },
    createPinHandoff(),
    observe,
  );
}

async function selectResearchRoute(store: Store, binding: Binding) {
  const b = structuredClone(binding);
  if (!/^isolated-yukon-[a-z0-9-]+$/.test(b.scope))
    throw Error("Research scope required");
  const pk = "VALIDATION#" + b.scope;
  const scope = await store.get(pk, "SCOPE");
  const intent = await store.get(pk, b.intent);
  const release = await store.get(
    PIN_RESEARCH_RELEASE_PK,
    PIN_RESEARCH_RELEASE_ID,
  );
  if (
    !scope ||
    !intent ||
    !release ||
    typeof intent.frozen !== "string" ||
    scope.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    intent.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    release.enabled !== true ||
    release.expiresAt !== undefined ||
    !Number.isSafeInteger(release.version) ||
    fingerprint(release.descriptor) !== PIN_RESEARCH_RELEASE_ID ||
    !Array.isArray(release.scopes) ||
    !release.scopes.includes(b.scope) ||
    release.endpoint !== scope.endpoint ||
    typeof release.endpoint !== "string" ||
    !release.endpoint ||
    ["xbgi2q58lbyyls", "72cqi112b9t8qv"].includes(release.endpoint)
  )
    throw Error("Research release is absent, revoked or mismatched");
  const guarded: Store = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    reservationRows: store.reservationRows.bind(store),
    put: async () => {
      throw Error("Unexpected single write");
    },
    delete: async () => {
      throw Error("Unexpected delete");
    },
    atomicPut: async (writes) => {
      // Publication must use the exact scope/intent read before release selection.
      // The publisher CAS then rejects any intervening scope/intent change.
      for (const [sk, version] of [
        ["SCOPE", scope.version],
        [b.intent, intent.version],
      ] as const) {
        const w = writes.find((x) => x.row.pk === pk && x.row.sk === sk);
        if (
          !w ||
          w.expected !== version ||
          w.row.researchReleaseId !== PIN_RESEARCH_RELEASE_ID
        )
          throw Error("Research route changed during verification");
      }
      await store.atomicPut([
        ...writes,
        { row: release, expected: release.version, conditionOnly: true },
      ]);
    },
  };
  return { guarded, intent };
}
