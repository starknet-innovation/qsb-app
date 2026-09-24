/** Research result publication through the application's Store. Not enrolled or routed. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { assertIdentity } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/identity";
import { SCHEMA } from "../../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const range = z
  .object({
    sequence: z.number().int().min(2147483648).max(4294967295),
    sequenceCount: z.number().int().min(1).max(16),
    locktime: z.number().int().min(500000000),
    locktimeCount: z.number().int().positive(),
  })
  .strict();
const pin = z
  .object({
    sequence: z.number().int(),
    locktime: z.number().int(),
    recid: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const result = z
  .object({
    protocol: z.literal("qsb-yukon-pinning-research-v1"),
    requestId: z.string(),
    manifestHash: hash,
    binarySha256: hash,
    parameterSha256: hash,
    range,
    status: z.literal("range-drained"),
    candidates: z.array(pin).max(4096),
    verified: z.literal(false),
    rangeCreditEligible: z.literal(false),
    releaseStatus: z.literal("HOLD"),
  })
  .strict();
const verdict = z
  .object({
    referenceChecked: z.literal(true),
    contextHash: hash,
    verdicts: z.array(
      z.union([
        z
          .object({
            valid: z.literal(true),
            sequence: z.number().int(),
            locktime: z.number().int(),
          })
          .strict(),
        z
          .object({ valid: z.literal(false), derOnly: z.literal(true) })
          .strict(),
      ]),
    ),
    decision: z.enum(["candidate-verified", "range-drained-reference-bound"]),
    rangeCreditEligible: z.literal(false),
    releaseStatus: z.literal("HOLD"),
    freshWithdrawal: z.literal(false),
  })
  .strict();

/** verify is a trusted local CPU runner, never a provider/user-supplied verdict. */
export async function publishResearchPin(
  store: Store,
  binding: {
    scope: string;
    owner: string;
    revision: number;
    intent: string;
    binarySha256: string;
  },
  providerResult: unknown,
  verify: (
    request: unknown,
    output: unknown,
    context: unknown,
    expectedBinary: string,
  ) => Promise<unknown>,
) {
  const b = structuredClone(binding);
  if (
    !/^isolated-yukon-[a-z0-9-]+$/.test(b.scope) ||
    !b.owner ||
    !Number.isSafeInteger(b.revision) ||
    b.revision < 1 ||
    !/^PIN#(0|[1-9][0-9]*)$/.test(b.intent)
  )
    throw Error("Invalid research binding");
  hash.parse(b.binarySha256);
  const envelope = z
    .object({
      id: z.string().min(1),
      status: z.literal("COMPLETED"),
      output: result,
    })
    .strict()
    .parse(structuredClone(providerResult));
  const pk = "VALIDATION#" + b.scope;
  const s = await store.get(pk, "SCOPE"),
    r = await store.get(pk, b.intent);
  if (
    !s ||
    !r ||
    s.identitySchema !== SCHEMA ||
    s.identityConflict ||
    s.owner !== b.owner ||
    s.revision !== b.revision ||
    s.stage !== "pinning" ||
    s.phase !== "pinning_searching" ||
    r.owner !== b.owner ||
    r.revision !== b.revision ||
    r.state !== "attached" ||
    r.terminal ||
    r.provider !== envelope.id ||
    typeof r.frozen !== "string" ||
    typeof s.publicContext !== "string"
  )
    throw Error("Stale or unattached research result");
  if (s.expiresAt !== undefined || r.expiresAt !== undefined)
    throw Error("Publication rows must not expire");
  const identity = await assertIdentity(store, r);
  const claim = await store.get(
    "VALIDATION#YUKON_PROVIDER_IDS",
    createHash("sha256").update(envelope.id).digest("hex"),
  );
  if (
    !claim ||
    claim.scope !== b.scope ||
    claim.intent !== b.intent ||
    claim.provider !== envelope.id ||
    claim.expiresAt !== undefined ||
    identity.expiresAt !== undefined
  )
    throw Error("Missing durable provider claim");
  const request = JSON.parse(r.frozen),
    context = JSON.parse(s.publicContext);
  if (
    !context ||
    Object.keys(context).sort().join(",") !== "manifest,publicStateJson" ||
    fingerprint(context) !== s.publicContextHash ||
    request.manifestHash !== fingerprint(context.manifest)
  )
    throw Error("Public context mismatch");
  for (const key of [
    "protocol",
    "requestId",
    "manifestHash",
    "binarySha256",
    "parameterSha256",
    "range",
  ])
    if (!isDeepStrictEqual(request[key], (envelope.output as any)[key]))
      throw Error("Frozen request/result mismatch");
  if (request.binarySha256 !== b.binarySha256) throw Error("Unenrolled binary");
  const v = verdict.parse(
    await verify(
      structuredClone(request),
      structuredClone(envelope.output),
      structuredClone(context),
      b.binarySha256,
    ),
  );
  if (
    v.contextHash !== s.publicContextHash ||
    v.verdicts.length !== envelope.output.candidates.length
  )
    throw Error("Unbound CPU verdict");
  v.verdicts.forEach((value, i) => {
    const c = envelope.output.candidates[i];
    if (
      value.valid &&
      (value.sequence !== c.sequence || value.locktime !== c.locktime)
    )
      throw Error("CPU candidate mismatch");
  });
  const winner = v.verdicts.find((x) => x.valid);
  if ((v.decision === "candidate-verified") !== Boolean(winner))
    throw Error("Inconsistent CPU decision");
  const receipt = {
    providerId: envelope.id,
    outputHash: fingerprint(envelope.output),
    reference: v,
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
  };
  // Scope, intent, identity and global provider claim are checked in one transaction.
  // A candidate requests drain; publication does not activate a subset or credit a range.
  await store.atomicPut([
    {
      row: {
        ...s,
        version: s.version + 1,
        ...(winner ? { phase: "pinning_draining" } : {}),
      },
      expected: s.version,
    },
    {
      row: {
        ...r,
        version: r.version + 1,
        state: "research_result_verified",
        terminal: {
          id: envelope.id,
          status: "COMPLETED",
          observedAt: new Date().toISOString(),
        },
        researchReceipt: receipt,
        ...(winner
          ? {
              candidate: {
                sequence: winner.sequence,
                locktime: winner.locktime,
              },
            }
          : {}),
      },
      expected: r.version,
    },
    { row: identity, expected: identity.version, conditionOnly: true },
    { row: claim, expected: claim.version, conditionOnly: true },
  ]);
  return receipt;
}
