/** Read-only provider reconciliation for already attached research siblings. No submit/cancel API. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { assertIdentity } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/identity";
import { SCHEMA } from "../../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import { PIN_RESEARCH_RELEASE_ID } from "./pin_route";

/** read is a trusted status GET adapter; 404, errors and nonterminal states never prove drain.
 * Revoked releases may still drain. This never publishes a candidate, credits coverage,
 * advances a phase or resumes a paused scope. Unknown IDs must use identity reconciliation.
 */
export async function recordResearchPinTerminal(
  store: Store,
  binding: { scope: string; owner: string; revision: number; intent: string },
  read: (endpoint: string, id: string) => Promise<unknown>,
) {
  const b = structuredClone(binding);
  if (
    !/^isolated-yukon-[a-z0-9-]+$/.test(b.scope) ||
    !/^PIN#(0|[1-9][0-9]*)$/.test(b.intent) ||
    !b.owner ||
    !Number.isSafeInteger(b.revision) ||
    b.revision < 1
  )
    throw Error("Invalid terminal binding");
  const pk = "VALIDATION#" + b.scope;
  const scope = await store.get(pk, "SCOPE"),
    intent = await store.get(pk, b.intent);
  if (
    !scope ||
    !intent ||
    scope.identitySchema !== SCHEMA ||
    scope.identityConflict ||
    scope.owner !== b.owner ||
    intent.owner !== b.owner ||
    intent.revision !== b.revision ||
    scope.stage !== "pinning" ||
    !["pinning_draining", "paused"].includes(String(scope.phase)) ||
    !Number.isSafeInteger(scope.revision) ||
    Number(scope.revision) < b.revision ||
    (scope.phase === "pinning_draining" && scope.revision !== b.revision) ||
    scope.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    intent.researchReleaseId !== PIN_RESEARCH_RELEASE_ID ||
    intent.state !== "attached" ||
    intent.terminal ||
    !Number.isSafeInteger(intent.dispatchAuthorizedAtMs) ||
    typeof intent.provider !== "string" ||
    !intent.provider ||
    typeof scope.endpoint !== "string" ||
    !scope.endpoint ||
    ["xbgi2q58lbyyls", "72cqi112b9t8qv"].includes(scope.endpoint) ||
    scope.expiresAt !== undefined ||
    intent.expiresAt !== undefined
  )
    throw Error("No attached draining research sibling");
  const identity = await assertIdentity(store, intent);
  const claim = await store.get(
    "VALIDATION#YUKON_PROVIDER_IDS",
    createHash("sha256").update(intent.provider).digest("hex"),
  );
  if (
    !claim ||
    claim.scope !== b.scope ||
    claim.intent !== b.intent ||
    claim.provider !== intent.provider ||
    claim.expiresAt !== undefined ||
    identity.expiresAt !== undefined
  )
    throw Error("Missing durable provider claim");
  const raw = structuredClone(await read(scope.endpoint, intent.provider));
  const terminal = z
    .object({
      id: z.literal(intent.provider),
      status: z.enum(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]),
    })
    .parse(raw);
  const receipt = { ...terminal, observedAt: new Date().toISOString() };
  await store.atomicPut([
    { row: { ...scope, version: scope.version + 1 }, expected: scope.version },
    {
      row: {
        ...intent,
        version: intent.version + 1,
        terminal: receipt,
        researchTerminalReceipt: {
          providerResultHash: fingerprint(raw),
          rangeCreditGranted: false,
          candidateVerified: false,
          releaseStatus: "HOLD",
        },
      },
      expected: intent.version,
    },
    { row: identity, expected: identity.version, conditionOnly: true },
    { row: claim, expected: claim.version, conditionOnly: true },
  ]);
  return receipt;
}
