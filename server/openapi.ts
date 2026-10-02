import { z } from "zod";
import packageJson from "../package.json";
import {
  API_ERROR_CODES,
  apiErrorCodes,
  type ApiErrorCode,
} from "./api-errors";
import {
  CHALLENGE_SECONDS,
  SESSION_SECONDS,
  challengeRequest,
  eventType,
  eventsCursorParam,
  eventsLimitParam,
  fundRequest,
  fundResubmitRequest,
  fundSubmitRequest,
  submitRequest,
  transactionIdParam,
  verifyRequest,
  webhookRequest,
} from "./api-schemas";
import {
  outpoint,
  publicVaultSchema,
  release,
  sats,
  strayPaymentsSchema,
  withdrawalSchema,
  type Job,
} from "../src/lib/model";
import { NETWORK_ID } from "../src/lib/network";
import { BODY_HASH_HEADER, CREDENTIAL_HEADER } from "../src/lib/session";
import { coordinatorSolvedResultSchema } from "../src/mainnet/coordinatorResult";
import { slipstreamRatesSchema } from "./providers";
import {
  apiKeyIdParam,
  apiKeyRequest,
  apiKeyRevokeRequest,
  apiKeyScopes,
  defaultApiKeyDays,
  maxActiveApiKeys,
  routeScopes,
  type ApiKeyMetadata,
  type ApiKeyScope,
} from "./scoped-keys";
import { idempotencyKey, idempotentPosts } from "./idempotency";
import type { Esplora } from "./chain";
import type { EsploraInclusionReport } from "./miner-inclusion";
import type { submitExact } from "./submit-exact";
import type { FundingSubmission, submitFunding } from "./submit-funding";
import {
  EVENT_RETENTION_SECONDS,
  EVENT_SETTLE_MS,
  type OwnerEvent,
  type listOwnerEvents,
} from "./owner-events";
import {
  FAILING_AFTER,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  WEBHOOK_LIMIT,
  type listWebhooks,
  type registerWebhook,
} from "./webhooks";

// The OpenAPI 3.1 document for createApp's routes. `npm run openapi` writes it
// to docs/api/openapi.json; tests/openapi.test.ts checks it against the served
// routes. Request schemas are the objects the handlers parse. Response schemas
// reuse the model's schemas where the handler returns a parsed value, and
// otherwise describe what the handler returns; handlers don't parse those.

/** Ids (components) and descriptions for the document. Local, so nothing leaks into zod's global registry. */
const docs = z.registry<{ id?: string; description?: string }>();
const describe = <T extends z.ZodType>(schema: T, description: string): T => {
  docs.add(schema, { description });
  return schema;
};
const component = <T extends z.ZodType>(
  id: string,
  schema: T,
  description: string,
): T => {
  docs.add(schema, { id, description });
  return schema;
};

// Handler results must fit their described schema (`Fits`), or match it exactly (`Same`).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Fits<Actual, Documented> = [Actual] extends [Documented] ? true : false;
type Assert<T extends true> = T;

component(
  "Sats",
  sats,
  "An amount in satoshis: a decimal string without leading zeros, at most the Bitcoin supply.",
);
component(
  "Outpoint",
  outpoint,
  "A transaction output: its txid, output index and value.",
);
component(
  "PublicVault",
  publicVaultSchema,
  "A vault's public record. It carries the public QSB state only; the secret state and the recovery backup stay with the owner.",
);
const strayPayments = component(
  "StrayPayments",
  strayPaymentsSchema,
  "Confirmed payments to a vault's script other than its recorded deposit, as the server last counted them. `count` and `sats` cover all of them; `outputs` lists the first 20 by when they were first seen. A vault takes one deposit: no withdrawal spends these outputs, and the app can't recover them.",
);
component(
  "Withdrawal",
  withdrawalSchema,
  "A withdrawal manifest: the vault's funding outpoint, the owner's helper outpoint, the single output and the fee. `idempotencyKey` becomes the job id.",
);
component(
  "MinerRates",
  slipstreamRatesSchema,
  "MARA Slipstream's live fee quote, in sat/vB.",
);
component(
  "SolvedResult",
  coordinatorSolvedResultSchema,
  "The coordinator's public solved result: the approved manifest and the GPU solution. It carries no secret; the client assembles the withdrawal from it and its recovery backup.",
);

const releaseCheck = component(
  "ReleaseCheck",
  z.object({ id: z.string(), label: z.string(), passed: z.boolean() }),
  "A release validation check.",
);
type _ReleaseCheck = Assert<
  Fits<(typeof release.checks)[number], z.infer<typeof releaseCheck>>
>;

const apiErrorCode = component(
  "ApiErrorCode",
  z.enum(API_ERROR_CODES as [ApiErrorCode, ...ApiErrorCode[]]),
  [
    "A stable, machine-readable error code. Branch on it; `error` is for people and can change. A code isn't tied to one HTTP status.",
    "",
    ...API_ERROR_CODES.map((code) => `- \`${code}\`: ${apiErrorCodes[code]}`),
  ].join("\n"),
);
component(
  "ErrorResponse",
  z.object({
    error: describe(z.string(), "A human-readable message. Don't parse it."),
    code: apiErrorCode,
    issues: describe(
      z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
      "With `invalid_request`: each validation problem.",
    ),
    checks: describe(
      z.array(releaseCheck).optional(),
      "With `operations_disabled` from the deposit route: the release checks.",
    ),
  }),
  "Every JSON error response.",
);

// Described responses.

const submissionStatus = component(
  "SubmissionStatus",
  z.enum(["uncertain", "submitted", "confirmed", "conflict"]),
  "A withdrawal submission's recorded outcome. `uncertain`: the miner POST's outcome is unknown; never resubmit, reconcile. `submitted`: the miner acknowledged it or the chain sees it. `confirmed`: mined on the current chain. `conflict`: the funding outpoint was spent by a transaction that differs from the approved one.",
);
const fundingSubmission = component(
  "FundingSubmission",
  z.enum(["submitted", "uncertain", "rejected"]),
  "A deposit submission's outcome at MARA Slipstream. `submitted`: accepted. `uncertain`: unknown; resend the same bytes. `rejected`: refused, and the intent was cleared.",
);
type _FundingSubmission = Assert<
  Same<z.infer<typeof fundingSubmission>, FundingSubmission>
>;
const chainStatus = component(
  "ChainStatus",
  z.object({
    confirmed: z.boolean(),
    confirmations: z.number().int(),
    blockHash: z.string().optional(),
    blockHeight: z.number().int().optional(),
  }),
  "The chain provider's view of a transaction. `confirmed` is true only when its block is on the current chain.",
);
type _ChainStatus = Assert<
  Fits<Awaited<ReturnType<Esplora["status"]>>, z.infer<typeof chainStatus>>
>;
const withdrawalObservation = component(
  "WithdrawalObservation",
  chainStatus.extend({
    txid: describe(
      z.string().optional(),
      "The transaction that spent the funding outpoint. A legacy scriptSig change can give it a different id from the submitted one.",
    ),
    outpointMatched: z.boolean().optional(),
    outputMatched: z.boolean().optional(),
  }),
  "The chain's view of a withdrawal, found by following the funding outpoint.",
);
type _WithdrawalObservation = Assert<
  Fits<
    Awaited<ReturnType<Esplora["withdrawalInclusion"]>>,
    z.infer<typeof withdrawalObservation>
  >
>;
const inclusionReport = z.object({
  format: z.literal("qsb-inclusion-judgment-v1"),
  structurallyComplete: z.boolean(),
  independentlyConfirmed: z.boolean(),
  preflightIsInclusion: z.literal(false),
  httpSuccessIsInclusion: z.literal(false),
  section7Closed: z.literal(false),
  observedByThisCheckout: z.boolean(),
  overclaim: z.boolean(),
  reason: z.string(),
  limits: z.array(z.string()),
});
type _InclusionReport = Assert<
  Same<keyof EsploraInclusionReport, keyof z.infer<typeof inclusionReport>>
>;

const jobFields = {
  id: z.string(),
  owner: z.string(),
  vaultId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum([
    "queued",
    "searching",
    "paused",
    "failed",
    "awaiting_authorization",
    "submitted",
    "confirmed",
  ]),
  stage: z.enum(["pinning", "round1", "round2", "verification"]),
  manifest: withdrawalSchema,
  manifestHash: z.string(),
  attempt: z.number().int(),
  computeSeconds: z.number(),
  usage: describe(
    z
      .object({
        chunks: describe(z.number().int().nonnegative(), "GPU chunks seen finished, whatever the outcome."),
        failed: describe(z.number().int().nonnegative(), "Of those, chunks that failed, timed out or were cancelled."),
        runMs: describe(z.number().int().nonnegative(), "Total time the chunks ran on a GPU: AWS Batch `stoppedAt` minus `startedAt`."),
        queueMs: describe(z.number().int().nonnegative(), "Total time from submission to each chunk starting (or stopping, for a chunk that never started): queueing, instance start and image pull."),
        unmeasured: describe(z.number().int().nonnegative(), "Chunks with a missing or out-of-order Batch time for either interval; their other times still count."),
      })
      .optional(),
    "The AWS Batch time this withdrawal's GPU chunks took, measured from each finished chunk's Batch record. Absent until the first chunk finishes. A chunk is counted once a tick sees it finished; one still running when the search paused is counted when it's next polled.",
  ),
  revision: z.number().int(),
  txid: z.string().optional(),
  error: z.string().optional(),
  solution: z
    .object({
      sequence: z.number().int(),
      locktime: z.number().int(),
      round1: z.array(z.number().int()),
      round2: z.array(z.number().int()),
    })
    .optional(),
};
type _JobFields = Assert<
  Same<
    z.infer<z.ZodObject<typeof jobFields>>,
    Pick<Job, keyof typeof jobFields>
  >
>;
const job = component(
  "Job",
  z.looseObject(jobFields),
  "A withdrawal job record. The listed fields are the stable ones; the record also carries operational fields (solver pin, compute submissions, reconciliation) that can change.",
);
const jobResponse = component("JobResponse", z.object({ job }), "A job.");
const vaultResponse = component(
  "VaultResponse",
  z.object({ vault: publicVaultSchema }),
  "A vault.",
);
const fundingSubmissionResponse = component(
  "FundingSubmissionResponse",
  z.object({
    vault: publicVaultSchema,
    submission: fundingSubmission,
    reason: describe(
      z.string().optional(),
      "With `rejected`: the miner's refusal.",
    ),
  }),
  "The vault after a deposit submission, and the submission's outcome.",
);
type _FundingSubmissionResponse = Assert<
  Fits<
    Awaited<ReturnType<typeof submitFunding>>,
    z.infer<typeof fundingSubmissionResponse>
  >
>;
const submitWithdrawalResponse = z.object({
  txid: z.string(),
  status: submissionStatus,
});
type _SubmitWithdrawal = Assert<
  Same<
    keyof Awaited<ReturnType<typeof submitExact>>,
    keyof z.infer<typeof submitWithdrawalResponse>
  >
>;
const paymentInputResponse = z.object({
  previousTxHex: z.string(),
  confirmations: z.number().int(),
});
type _PaymentInput = Assert<
  Same<
    Awaited<ReturnType<Esplora["unspent"]>>,
    z.infer<typeof paymentInputResponse>
  >
>;
const paymentUtxosResponse = z.object({ utxos: z.array(outpoint) });
type _PaymentUtxos = Assert<
  Fits<
    Awaited<ReturnType<Esplora["paymentUtxos"]>>,
    z.infer<typeof paymentUtxosResponse>["utxos"]
  >
>;
const apiKeyScope = component(
  "ApiKeyScope",
  z.enum(apiKeyScopes),
  "What an API key may do. `read`: every authenticated GET and the payment-input lookup. `vaults`: register and fund vaults. `withdrawals`: create, pause and resume withdrawal jobs. `submit`: submit a signed withdrawal.",
);
const apiKeyMetadata = component(
  "ApiKeyMetadata",
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    scopes: z.array(apiKeyScope),
    network: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
    status: z.enum(["active", "expired", "revoked"]),
  }),
  "An API key's metadata. It never includes the key or its hash.",
);
type _ApiKeyMetadata = Assert<
  Fits<ApiKeyMetadata, z.infer<typeof apiKeyMetadata>>
>;
const apiKeyResponse = z.object({ apiKey: apiKeyMetadata });
const configResponse = z.object({
  protocol: z.string(),
  qsbCommit: z.string(),
  kernelCommit: z.string(),
  checks: z.array(releaseCheck),
  network: z.literal(NETWORK_ID),
  mainnetEnabled: z.boolean(),
  operationsEnabled: describe(
    z.boolean(),
    "Whether deposits and withdrawals are switched on.",
  ),
  solverReleaseId: describe(
    z.string().nullable(),
    "The solver release this deployment serves, or null.",
  ),
  exactSubmitEnabled: describe(
    z.boolean(),
    "Whether submission to the miner is switched on.",
  ),
  apiKeysEnabled: describe(
    z.boolean(),
    "Whether API keys are switched on for this deployment.",
  ),
  billing: z.literal("not_configured"),
  awsRegion: z.string(),
  maxBtc: z.null(),
  withdrawalDeadline: z.null(),
  computeBudget: z.null(),
  ownerLimits: describe(
    z
      .object({
        allowlist: describe(z.boolean(), "Whether an owner allowlist is set. The list itself is never returned."),
        allowlisted: describe(
          z.boolean().nullable(),
          "Whether the caller, by its session or API key, is on the allowlist; null without either or without an allowlist.",
        ),
        maxActiveJobs: describe(
          z.number().int().nullable(),
          "The most withdrawals one owner may have queued or searching, or null.",
        ),
        maxGpuSeconds: describe(
          z.number().int().nullable(),
          "GPU seconds one owner may reserve across its withdrawals, or null.",
        ),
      })
      .nullable(),
    "The per-owner limits in force, or null when a limit setting is malformed.",
  ),
});
const transactionStatusResponse = z.object({
  txid: z.string(),
  includedTxid: describe(
    z.string().optional(),
    "Once confirmed: the mined transaction's id.",
  ),
  chainUnavailable: describe(
    z.literal(true).optional(),
    "The chain provider couldn't be read; `status` is the recorded one.",
  ),
  status: submissionStatus,
  checkedAt: z.string().datetime(),
  chain: withdrawalObservation.nullable(),
  miner: z.union([
    z.object({ visible: z.literal(true), reportedConfirmed: z.boolean() }),
    z.object({ visible: z.null() }),
  ]),
  alert: z.string().optional(),
  retrySafe: describe(
    z.literal(false),
    "Always false: a missing record or an unavailable provider isn't proof of rejection.",
  ),
  section7Inclusion: inclusionReport,
});
const jobStatusResponse = z.object({
  job,
  status: describe(
    withdrawalObservation.nullable().optional(),
    "Once the job has a transaction: the chain's view of it. Null when the chain provider is unavailable or the funding outpoint's spender conflicts with the approved withdrawal.",
  ),
  submissionStatus: submissionStatus.optional(),
  alert: z.string().optional(),
  includedTxid: z.string().optional(),
  chainUnavailable: z.literal(true).optional(),
  retrySafe: z.literal(false).optional(),
});

const ownerEvent = component(
  "OwnerEvent",
  z.object({
    id: describe(z.string(), "The event id. The same state change always has the same id: drop duplicates by it."),
    type: eventType,
    subjectId: describe(z.string(), "The job id for `withdrawal.*`, the vault id for `deposit.*`."),
    status: describe(z.string(), "The job or vault status it moved to, or `dropped` or `stray_payment`."),
    stage: describe(z.string().optional(), "Withdrawal events only: the search stage."),
    at: describe(z.string(), "When the status changed, ISO 8601."),
  }),
  "A withdrawal or deposit status change, or a flagged stray payment to a vault. Identifiers and statuses only: no transaction bytes, scripts or secrets.",
);
type _OwnerEvent = Assert<Same<z.infer<typeof ownerEvent>, OwnerEvent>>;
const eventsResponse = z.object({
  events: z.array(ownerEvent),
  next: describe(
    z.string().nullable(),
    "Pass as `after` on the next call. Null when there are no events yet and no `after` was given.",
  ),
  hasMore: describe(z.boolean(), "Whether more events follow this page now."),
});
type _Events = Assert<
  Fits<Awaited<ReturnType<typeof listOwnerEvents>>, z.infer<typeof eventsResponse>>
>;
const webhookView = component(
  "Webhook",
  z.object({
    id: z.string(),
    url: z.string(),
    events: describe(z.array(eventType).nullable(), "The subscribed types; null for all."),
    status: describe(
      z.enum(["active", "failing"]),
      `\`failing\` after ${FAILING_AFTER} failed rounds in a row: it gets no more deliveries. Delete it and register it again.`,
    ),
    createdAt: z.string(),
    failures: describe(z.number().int(), "Failed rounds in a row."),
    pending: describe(z.number().int(), "Deliveries waiting to be sent."),
    lastDeliveryAt: z.string().optional(),
    lastFailureAt: z.string().optional(),
    lastError: describe(
      z.string().optional(),
      "Why the last round failed: `timeout`, `network`, `http_<status>`, `url_forbidden`, `url_unresolvable` or `url_invalid`.",
    ),
  }),
  "A registered webhook, without its signing secret.",
);
type _Webhooks = Assert<
  Fits<Awaited<ReturnType<typeof listWebhooks>>, z.infer<typeof webhookView>[]>
>;
const createdWebhook = z.object({
  webhook: webhookView,
  secret: describe(
    z.string(),
    "The HMAC-SHA256 signing secret. Shown only in this response; keep it.",
  ),
});
type _CreatedWebhook = Assert<
  Fits<Awaited<ReturnType<typeof registerWebhook>>, z.infer<typeof createdWebhook>>
>;

// The routes.

type Method = "get" | "post";
type SuccessStatus = 200 | 201 | 202;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;
type Errors = Partial<Record<ErrorStatus, readonly ApiErrorCode[]>>;
export type ApiRoute = {
  method: Method;
  /** As registered in createApp, e.g. `/api/vaults/:id`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  /**
   * Whether it needs sign-in. Which credentials it takes, and the scope an API
   * key needs, come from routeScopes: see `routeAuth`.
   */
  auth: boolean;
  params?: Record<string, z.ZodType>;
  /** Optional query parameters, as the handler reads them. */
  query?: Record<string, z.ZodType>;
  body?: z.ZodType;
  /** The handler accepts a missing body. */
  bodyOptional?: true;
  responses: Partial<
    Record<SuccessStatus, { description: string; schema: z.ZodType }>
  >;
  /** Route-specific errors. `routeErrors` adds the ones every route of its kind can return. */
  errors: Errors;
};

const merge = (...sets: Errors[]): Errors => {
  const out: Partial<Record<ErrorStatus, ApiErrorCode[]>> = {};
  for (const set of sets)
    for (const [status, codes] of Object.entries(set) as [
      `${ErrorStatus}`,
      ApiErrorCode[],
    ][])
      (out[Number(status) as ErrorStatus] ??= []).push(...codes);
  return out;
};
// Errors raised outside a route's own code, each with the sites it covers in
// tests/api-error-sites.json (`file | function`). tests/openapi.test.ts checks
// that every such site's code is listed by a source that covers it, or that the
// site is in unreachedErrorSites. Routes merge the sources of what they call.
const sources = new Map<Errors, readonly string[]>();
const source = (sites: readonly string[], errors: Errors) => {
  sources.set(errors, sites);
  return errors;
};
/** The error sources, with the snapshot sites each covers. */
export const errorSources = () =>
  [...sources].map(([errors, sites]) => ({ sites, errors }));
/**
 * Sites (`file | function`, or `file | function | class`) whose error never
 * reaches a response, and why.
 */
export const unreachedErrorSites: Record<string, string> = {
  "chain.ts | withdrawalInclusion":
    "observeWithdrawal settles it; a conflicting spender becomes the response's `alert`.",
  "transaction-checks.ts | assertWithdrawalSpendAgainstJob | ChainError":
    "It rethrows these as exact_spend_mismatch.",
  "transaction-checks.ts | helperSighashAll":
    "Only assertWithdrawalSpendAgainstJob calls it, which rethrows as exact_spend_mismatch.",
  "transaction-checks.ts | assertOutput":
    "assertWithdrawalSpendAgainstJob rethrows it as exact_spend_mismatch; checkFunding isn't called by a route.",
  "transaction-checks.ts | parse":
    "assertWithdrawalSpendAgainstJob rethrows it as exact_spend_mismatch; checkWithdrawal parses the same bytes only after that passed; checkFunding isn't called by a route.",
  "transaction-checks.ts | checkFunding": "No route calls it.",
  "owner-limits.ts | save":
    "Only the coordinator's paid-submission save calls OwnerGpuBudget.save; no route does.",
};

// A store write that loses a version race.
const writes = source(
  [
    "store.ts | put",
    "store.ts | atomicPut",
    "store.ts | delete",
  ],
  { 409: ["state_conflict"] },
);
const reservations = source(
  ["store.ts | canonicalReservationWrites"],
  { 409: ["state_conflict"] },
);
// Any chain read checks the provider's network first. A request that fails
// before any response, or an error status, is a 503 chain_unavailable. An
// answer that doesn't parse is a 502 chain_error; one that is too large or
// fails a check (another network, inconsistent) a 409 chain_error.
const chainRead = source(
  ["chain.ts | read", "chain.ts | answer", "chain.ts | assertNetwork"],
  {
    409: ["chain_error"],
    502: ["chain_error"],
    503: ["chain_unavailable"],
  },
);
const chainLookup = source(
  ["chain.ts | read", "chain.ts | raw", "chain.ts | status"],
  merge(chainRead, { 409: ["chain_transaction_not_found"] }),
);
// A vout past the previous transaction's outputs is a 409 input_not_found.
const inputCheck = source(
  ["chain.ts | unspent"],
  merge(chainLookup, {
    409: ["input_not_found", "input_mismatch", "input_unconfirmed", "input_spent"],
  }),
);
// A failed secret read or a refused credential: a 503.
const minerCredential = source(
  ["providers.ts | credential", "providers.ts | minerSecret"],
  { 503: ["miner_unavailable"] },
);
// A miner status lookup: no response, an error status or a malformed answer
// is a 502, and a 401 or 403 from the miner a 503.
const minerLookup = source(
  [
    "providers.ts | request",
    "providers.ts | status",
    "providers.ts | secretFor",
  ],
  {
    502: ["miner_request_failed"],
    503: ["miner_unavailable"],
  },
);
const inclusionJudgment = source(
  ["miner-inclusion.ts | judgeInclusionEvidence"],
  { 409: ["inclusion_check_failed"] },
);
const consensusCheck = source(
  ["consensus.ts | verify", "consensus.ts | reject"],
  {
    409: ["consensus_rejected"],
  },
);
const fundingMatch = source(["transaction-checks.ts | invalid"], {
  409: ["funding_transaction_invalid"],
});
const fundingExport = source(
  ["submit-funding.ts | exportFunding"],
  merge(writes),
);
// submitFunding; a retry asks the miner whether it already has the deposit.
const deposit = source(
  [
    "submit-funding.ts | submitFunding",
    "submit-funding.ts | touch",
    "submit-funding.ts | record",
  ],
  merge(writes, fundingMatch, minerCredential, minerLookup, {
    409: [
      "funding_transaction_invalid",
      "vault_not_found",
      "funding_intent_exists",
    ],
    503: ["submit_disabled"],
  }),
);
// submitExact: the stored spend and transaction checks, checkWithdrawal's
// chain checks, and the consensus check.
const exactSubmit = source(
  [
    "submit-exact.ts | submitExact",
    "job-spend-record.ts | mismatch",
    "transaction-checks.ts | assertWithdrawalSpendAgainstJob",
    "transaction-checks.ts | checkWithdrawal",
    "miner-inclusion.ts | readTransaction",
  ],
  merge(inputCheck, writes, minerCredential, consensusCheck, {
    409: [
      "job_not_found",
      "job_unsupported",
      "job_state_invalid",
      "exact_spend_mismatch",
      "intent_conflict",
      "vault_not_found",
    ],
    503: ["submit_disabled"],
  }),
);

// The auth middleware's API key checks, for every authenticated route.
const apiKeyAuth = source(
  [
    "scoped-keys.ts | authorizeApiKey",
    "scoped-keys.ts | wrongNetwork",
    "scoped-keys.ts | disabled",
  ],
  {
    401: ["api_key_invalid", "api_key_revoked", "network_mismatch"],
    403: ["api_key_not_allowed", "api_key_scope_denied"],
    503: ["api_keys_disabled"],
  },
);
const apiKeyIssue = source(["scoped-keys.ts | POST /api/api-keys"], {
  409: ["api_key_limit_reached"],
  503: ["api_keys_disabled"],
});
const apiKeyRevoke = source(
  ["scoped-keys.ts | POST /api/api-keys/:id/revoke"],
  { 404: ["api_key_not_found"] },
);
// The Idempotency-Key layer on idempotentPosts: a malformed key, a key bound to
// another request, or one whose first request still holds its lease.
const idempotent = source(
  ["idempotency.ts | idempotency", "idempotency.ts | inProgress"],
  {
    400: ["invalid_request"],
    409: ["idempotency_conflict", "idempotency_in_progress"],
  },
);
/** Whether the route accepts an Idempotency-Key header (server/idempotency.ts). */
export const acceptsIdempotencyKey = (route: ApiRoute) =>
  route.method === "post" &&
  idempotentPosts.some((path) => `/api${path}` === route.path);
describe(
  idempotencyKey,
  "Optional. Names one attempt of this request for 24 hours. The same key with the same path and body replays the first settled 2xx (with `Idempotency-Replayed: true`) without running the handler; a different path or body is `idempotency_conflict`; a retry while the first still runs is `idempotency_in_progress`. Errors and `uncertain` outcomes aren't stored, so a retry runs the handler again. A new attempt needs a new key. See docs/API.md.",
);
// Reading the owner limits: a malformed QSB_OWNER_* value refuses the route.
const ownerLimitsRead = source(
  ["owner-limits.ts | positive", "owner-limits.ts | gpuSeconds"],
  { 503: ["owner_limits_invalid"] },
);
// Routes that check the owner allowlist (QSB_OWNER_ALLOWLIST).
const allowlisted = merge(ownerLimitsRead, { 403: ["owner_not_allowlisted"] });
// The owner's single webhook row: a registration or deletion that keeps losing its version race.
const webhookRow = source(["webhooks.ts | update"], { 409: ["state_conflict"] });

const vaultId = describe(z.string(), "The vault id.");
const jobId = describe(
  z.string(),
  "The job id: the withdrawal's `idempotencyKey`.",
);
describe(transactionIdParam, "The submitted transaction's id, lowercase hex.");
describe(
  fundSubmitRequest.shape.rawTxHex,
  "The signed deposit, hex. A deposit over 150,000 characters (75,000 bytes) passes this schema but is refused with a 409 `funding_transaction_invalid`, before anything is stored or sent.",
);

export const apiRoutes: readonly ApiRoute[] = [
  {
    method: "get",
    path: "/api/health",
    operationId: "getHealth",
    summary: "Health check",
    auth: false,
    responses: {
      200: {
        description: "The API is up.",
        schema: z.object({
          ok: z.literal(true),
          network: z.literal(NETWORK_ID),
        }),
      },
    },
    errors: {},
  },
  {
    method: "get",
    path: "/api/config",
    operationId: "getConfig",
    summary: "Deployment configuration and switches",
    auth: false,
    responses: {
      200: { description: "The configuration.", schema: configResponse },
    },
    errors: {},
  },
  {
    method: "get",
    path: "/api/rates",
    operationId: "getRates",
    summary: "The miner's live fee quote",
    auth: false,
    responses: {
      200: { description: "The quote.", schema: slipstreamRatesSchema },
    },
    errors: { 503: ["miner_rate_unavailable"] },
  },
  {
    method: "post",
    path: "/api/auth/challenge",
    operationId: "createChallenge",
    summary: "Start sign-in: get a message to sign",
    description:
      "The message names the app origin, the address, the network, a nonce and the expiry. It authorizes a session only, never a Bitcoin transaction.",
    auth: false,
    body: challengeRequest,
    responses: {
      200: {
        description: "The challenge.",
        schema: z.object({
          id: describe(z.string().uuid(), "The challenge id."),
          message: describe(z.string(), "The message to sign with BIP-322."),
        }),
      },
    },
    errors: merge(writes, { 400: ["network_mismatch"] }),
  },
  {
    method: "post",
    path: "/api/auth/verify",
    operationId: "verifyChallenge",
    summary: "Finish sign-in: exchange the signature for a session token",
    auth: false,
    body: verifyRequest,
    responses: {
      200: {
        description: "The session.",
        schema: z.object({
          token: describe(
            z.string(),
            `The bearer token, for \`${CREDENTIAL_HEADER}: Bearer <token>\`.`,
          ),
        }),
      },
    },
    errors: merge(writes, { 401: ["challenge_expired", "signature_invalid"] }),
  },
  {
    method: "get",
    path: "/api/vaults",
    operationId: "listVaults",
    summary: "The owner's vaults",
    auth: true,
    responses: {
      200: {
        description: "The vaults.",
        schema: z.object({
          vaults: z.array(publicVaultSchema),
          resendable: describe(
            z.array(z.string()),
            "Ids of vaults whose unconfirmed deposit the server stored and can resend.",
          ),
          strayPayments: describe(
            z.array(strayPayments),
            "One record per vault with flagged stray payments, as last checked by `GET /api/vaults/{id}/funding`.",
          ),
        }),
      },
    },
    errors: {},
  },
  {
    method: "post",
    path: "/api/vaults",
    operationId: "createVault",
    summary: "Register a new vault's public record",
    description:
      "The vault is generated on the client; only its public record is sent. It must be unfunded, for this network and owned by the signed-in address.",
    auth: true,
    body: publicVaultSchema,
    responses: {
      201: { description: "The vault was registered.", schema: vaultResponse },
    },
    errors: merge(writes, allowlisted, { 400: ["vault_invalid"] }),
  },
  {
    method: "get",
    path: "/api/payment-utxos",
    operationId: "listPaymentUtxos",
    summary: "The owner's confirmed UTXOs",
    auth: true,
    responses: {
      200: { description: "The UTXOs.", schema: paymentUtxosResponse },
    },
    errors: chainRead,
  },
  {
    method: "post",
    path: "/api/payment-input",
    operationId: "checkPaymentInput",
    summary: "Check that an outpoint is the owner's, confirmed and unspent",
    auth: true,
    body: outpoint,
    responses: {
      200: {
        description: "The input is usable.",
        schema: paymentInputResponse,
      },
    },
    errors: inputCheck,
  },
  {
    method: "post",
    path: "/api/vaults/:id/fund",
    operationId: "recordFunding",
    summary: "Record a deposit the wallet already broadcast",
    description:
      "The server reads the transaction from the chain provider and records it when output 0 pays this vault `amount`. It doesn't broadcast. A vault takes one deposit.",
    auth: true,
    params: { id: vaultId },
    body: fundRequest,
    responses: {
      201: { description: "The deposit was recorded.", schema: vaultResponse },
    },
    errors: merge(chainLookup, writes, fundingMatch, allowlisted, {
      404: ["vault_not_found"],
      409: ["network_mismatch", "funding_intent_exists"],
      503: ["operations_disabled"],
    }),
  },
  {
    method: "post",
    path: "/api/vaults/:id/fund/submit",
    operationId: "submitFunding",
    summary: "Record a signed deposit and submit it to MARA Slipstream",
    description:
      "A deposit pays a bare, non-standard QSB script that public relay refuses, so it goes to MARA Slipstream. The intent is recorded before the POST. Every outcome is a 201; `submission` says which.",
    auth: true,
    params: { id: vaultId },
    body: fundSubmitRequest,
    responses: {
      201: {
        description: "The submission's outcome.",
        schema: fundingSubmissionResponse,
      },
    },
    errors: merge(deposit, allowlisted, { 503: ["operations_disabled", "submit_disabled"] }),
  },
  {
    method: "get",
    path: "/api/vaults/:id/fund/signed",
    operationId: "getSignedFunding",
    summary: "Export the stored signed deposit",
    description:
      "For manual submission on Slipstream. There's no chain lookup. Offered only while deposit submission is switched on.",
    auth: true,
    params: { id: vaultId },
    responses: {
      200: {
        description: "The signed deposit.",
        schema: z.object({
          txid: z.string(),
          rawTxHex: z.string(),
          status: publicVaultSchema.shape.status,
          submission: fundingSubmission.optional(),
        }),
      },
    },
    errors: merge(fundingExport, allowlisted, {
      404: ["signed_deposit_not_found"],
      503: ["submit_disabled"],
    }),
  },
  {
    method: "post",
    path: "/api/vaults/:id/fund/resubmit",
    operationId: "resubmitFunding",
    summary: "Resend the stored signed deposit",
    description:
      "Resends exactly the stored bytes, e.g. after an `uncertain` outcome. They can confirm only once; a second deposit is never created.",
    auth: true,
    params: { id: vaultId },
    body: fundResubmitRequest,
    bodyOptional: true,
    responses: {
      201: {
        description: "The submission's outcome.",
        schema: fundingSubmissionResponse,
      },
    },
    errors: merge(deposit, allowlisted, {
      404: ["vault_not_found"],
      409: ["signed_deposit_not_found"],
      503: ["operations_disabled", "submit_disabled"],
    }),
  },
  {
    method: "get",
    path: "/api/vaults/:id/funding",
    operationId: "getVaultFunding",
    summary: "The deposit's chain status and transaction",
    description:
      "Until a Slipstream deposit is mined the chain provider doesn't know it. Then the stored signed bytes stand in for `previousTxHex` and `status` is unconfirmed; they never count as confirmation. The check also looks up the vault script's confirmed outputs and flags any beyond the recorded deposit, with a `deposit.stray_payment` event.",
    auth: true,
    params: { id: vaultId },
    responses: {
      200: {
        description: "The deposit.",
        schema: z.object({
          vault: publicVaultSchema,
          status: chainStatus,
          strayPayments: describe(
            strayPayments.nullable(),
            "The vault's flagged stray payments, including any this check found, or null. A failed lookup returns the record already flagged.",
          ),
          submission: fundingSubmission.optional(),
          previousTxHex: z.string(),
        }),
      },
    },
    errors: merge(chainLookup, fundingExport, writes, {
      404: ["vault_not_found"],
      409: ["network_mismatch", "vault_not_funded"],
    }),
  },
  {
    method: "get",
    path: "/api/transactions/:id/status",
    operationId: "getTransactionStatus",
    summary: "Reconcile a withdrawal submission",
    description:
      "Reads the chain and the miner and records what they report. It never submits again.",
    auth: true,
    params: { id: transactionIdParam },
    responses: {
      200: {
        description: "The submission's status.",
        schema: transactionStatusResponse,
      },
    },
    errors: merge(writes, inclusionJudgment, {
      400: ["invalid_request"],
      404: ["intent_not_found"],
    }),
  },
  {
    method: "get",
    path: "/api/jobs",
    operationId: "listJobs",
    summary: "The owner's withdrawal jobs",
    auth: true,
    responses: {
      200: {
        description: "The jobs.",
        schema: z.object({ jobs: z.array(job) }),
      },
    },
    errors: {},
  },
  {
    method: "post",
    path: "/api/jobs",
    operationId: "createJob",
    summary: "Create a withdrawal job",
    description:
      "Checks both inputs on the chain, reserves them atomically and starts the coordinator. `idempotencyKey` is the job id: the same manifest again returns the existing job (200); a different one is `idempotency_conflict`.",
    auth: true,
    body: withdrawalSchema,
    responses: {
      200: { description: "The existing job.", schema: jobResponse },
      201: { description: "The job was created.", schema: jobResponse },
    },
    errors: merge(inputCheck, writes, reservations, allowlisted, {
      429: ["owner_active_withdrawal_limit", "owner_gpu_budget_reached"],
      400: ["withdrawal_invalid"],
      404: ["vault_not_found"],
      409: [
        "idempotency_conflict",
        "network_mismatch",
        "vault_not_confirmed",
        "withdrawal_invalid",
      ],
      503: ["operations_disabled", "solver_not_served"],
    }),
  },
  {
    method: "get",
    path: "/api/jobs/:id/solved-result",
    operationId: "getSolvedResult",
    summary: "The job's public solved result",
    description:
      "Available once the job is `awaiting_authorization`. The client assembles and signs the withdrawal from it.",
    auth: true,
    params: { id: jobId },
    responses: {
      200: {
        description: "The solved result.",
        schema: coordinatorSolvedResultSchema,
      },
    },
    errors: {
      404: ["job_not_found", "solved_result_unavailable"],
      409: ["job_unsupported"],
    },
  },
  {
    method: "post",
    path: "/api/jobs/:id/submit",
    operationId: "submitWithdrawal",
    summary: "Submit the signed withdrawal",
    description:
      "Checks the transaction against the approved manifest (inputs, the single output's script, amount and fee) and the inputs on the chain, runs the offline Bitcoin Core consensus check, records the intent, then makes exactly one POST to the miner. On `uncertain`, don't resubmit; reconcile with the transaction status route.",
    auth: true,
    params: { id: jobId },
    body: submitRequest,
    responses: {
      200: {
        description: "The submission's outcome.",
        schema: submitWithdrawalResponse,
      },
    },
    errors: merge(exactSubmit, { 503: ["submit_disabled"] }),
  },
  {
    method: "post",
    path: "/api/jobs/:id/pause",
    operationId: "pauseJob",
    summary: "Pause a queued or searching job",
    auth: true,
    params: { id: jobId },
    responses: { 200: { description: "The paused job.", schema: jobResponse } },
    errors: merge(writes, {
      404: ["job_not_found"],
      409: ["job_unsupported", "job_state_invalid"],
    }),
  },
  {
    method: "post",
    path: "/api/jobs/:id/resume",
    operationId: "resumeJob",
    summary: "Resume a paused job",
    auth: true,
    params: { id: jobId },
    responses: {
      202: { description: "The job is queued again.", schema: jobResponse },
    },
    errors: merge(writes, allowlisted, {
      429: ["owner_active_withdrawal_limit"],
      404: ["job_not_found"],
      409: [
        "job_unsupported",
        "job_state_invalid",
        "reconcile_required",
        "operator_review_required",
      ],
      503: ["operations_disabled"],
    }),
  },
  {
    method: "get",
    path: "/api/jobs/:id/status",
    operationId: "getJobStatus",
    summary: "The job and its transaction's chain status",
    description:
      "Once the job has a transaction, reads its status and updates the job to `submitted` or `confirmed`.",
    auth: true,
    params: { id: jobId },
    responses: {
      200: { description: "The job's status.", schema: jobStatusResponse },
    },
    errors: merge(chainLookup, writes, {
      404: ["job_not_found", "intent_not_found", "vault_not_found"],
      409: ["job_unsupported", "intent_conflict"],
    }),
  },
  {
    method: "post",
    path: "/api/api-keys",
    operationId: "createApiKey",
    summary: "Mint an API key for the signed-in owner",
    description: `Wallet session only. The key is returned once; only its SHA-256 is stored. \`expiresInDays\` defaults to ${defaultApiKeyDays}. An owner can have ${maxActiveApiKeys} active keys. Refused with \`api_keys_disabled\` unless the deployment switches keys on (\`apiKeysEnabled\` in the configuration).`,
    auth: true,
    body: apiKeyRequest,
    responses: {
      201: {
        description: "The new key and its metadata.",
        schema: apiKeyResponse.extend({
          key: describe(
            z.string(),
            `The API key, \`qsb_mainnet_<43 base64url characters>\`, for \`${CREDENTIAL_HEADER}: Bearer <key>\`. Shown only here.`,
          ),
        }),
      },
    },
    errors: merge(writes, apiKeyIssue),
  },
  {
    method: "get",
    path: "/api/api-keys",
    operationId: "listApiKeys",
    summary: "The owner's API keys",
    description: "Wallet session only. Metadata only, never a key or its hash.",
    auth: true,
    responses: {
      200: {
        description: "The keys.",
        schema: z.object({ apiKeys: z.array(apiKeyMetadata) }),
      },
    },
    errors: {},
  },
  {
    method: "post",
    path: "/api/api-keys/:id/revoke",
    operationId: "revokeApiKey",
    summary: "Revoke an API key at once",
    description:
      "Wallet session only. Revoking a revoked key returns it again. Listing and revocation work while keys are switched off.",
    auth: true,
    params: { id: describe(apiKeyIdParam, "The API key id.") },
    body: apiKeyRevokeRequest,
    bodyOptional: true,
    responses: {
      200: { description: "The revoked key.", schema: apiKeyResponse },
    },
    errors: merge(writes, apiKeyRevoke),
  },
  {
    method: "get",
    path: "/api/events",
    operationId: "listEvents",
    summary: "The owner's event log, oldest first",
    description: `The record of withdrawal and deposit status changes; webhooks only notify. Keep \`next\` and pass it as \`after\`. Events are kept ${EVENT_RETENTION_SECONDS / 86400} days and listed once they are ${EVENT_SETTLE_MS / 1000} seconds old.`,
    auth: true,
    query: {
      after: describe(eventsCursorParam, "A `next` cursor from a previous page."),
      limit: describe(eventsLimitParam, "Events per page, 1 to 100. Default 50."),
    },
    responses: {
      200: { description: "A page of events.", schema: eventsResponse },
    },
    errors: { 400: ["invalid_request"] },
  },
  {
    method: "get",
    path: "/api/webhooks",
    operationId: "listWebhooks",
    summary: "The owner's webhooks, without their secrets",
    auth: true,
    responses: {
      200: {
        description: "The webhooks.",
        schema: z.object({ webhooks: z.array(webhookView) }),
      },
    },
    errors: {},
  },
  {
    method: "post",
    path: "/api/webhooks",
    operationId: "createWebhook",
    summary: "Register a webhook",
    description: `At most ${WEBHOOK_LIMIT} per owner. The URL must be https on port 443, without credentials, on a public host name or address; the host is resolved and every address checked, now and at each delivery. Omit \`events\` to receive all types.`,
    auth: true,
    body: webhookRequest,
    responses: {
      201: {
        description: "The webhook, and its signing secret, shown only here.",
        schema: createdWebhook,
      },
    },
    errors: merge(writes, webhookRow, allowlisted, {
      400: ["webhook_url_invalid", "webhook_url_forbidden", "webhook_url_unresolvable"],
      409: ["webhook_limit_reached"],
    }),
  },
  {
    method: "post",
    path: "/api/webhooks/:id/delete",
    operationId: "deleteWebhook",
    summary: "Delete a webhook and its queued deliveries",
    auth: true,
    params: { id: describe(z.string(), "The webhook id.") },
    responses: {
      200: {
        description: "Deleted.",
        schema: z.object({ deleted: z.literal(true) }),
      },
    },
    errors: merge(writes, webhookRow, { 404: ["webhook_not_found"] }),
  },
];

/**
 * Who may call a route: nobody signed in, a wallet session only, or a session
 * or an API key holding `scope`. From routeScopes, the table the auth
 * middleware enforces.
 */
export function routeAuth(
  route: ApiRoute,
):
  | { kind: "none" }
  | { kind: "session" }
  | { kind: "session-or-key"; scope: ApiKeyScope } {
  if (!route.auth) return { kind: "none" };
  const scope = routeScopes[`${route.method.toUpperCase()} ${route.path}`];
  return scope ? { kind: "session-or-key", scope } : { kind: "session" };
}

/** A route's errors, including those every route of its kind can return. */
export function routeErrors(route: ApiRoute): Errors {
  const auth = routeAuth(route);
  return merge(
    route.errors,
    { 500: ["internal_error"] },
    route.auth ? { 401: ["auth_required", "session_expired"] } : {},
    // Any authenticated route checks a presented API key.
    route.auth
      ? {
          401: apiKeyAuth[401]!,
          403: [
            auth.kind === "session"
              ? "api_key_not_allowed"
              : "api_key_scope_denied",
          ],
          503: apiKeyAuth[503]!,
        }
      : {},
    route.method === "post" ? { 413: ["request_too_large"] } : {},
    route.body ? { 400: ["invalid_request"] } : {},
    acceptsIdempotencyKey(route) ? idempotent : {},
  );
}

const pascal = (name: string) => name[0].toUpperCase() + name.slice(1);
const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
/** The component id for a route's schema, registering one when it has none. */
function componentId(schema: z.ZodType, fallback: string): string {
  const existing = docs.get(schema);
  if (existing?.id) return existing.id;
  docs.add(schema, { ...existing, id: fallback });
  return fallback;
}
const requestIds = new Set<string>();
const schemaIds = new Map<z.ZodType, string>();
for (const route of apiRoutes) {
  if (route.body) {
    const id = componentId(route.body, `${pascal(route.operationId)}Request`);
    requestIds.add(id);
    schemaIds.set(route.body, id);
  }
  for (const response of Object.values(route.responses))
    schemaIds.set(
      response.schema,
      componentId(response.schema, `${pascal(route.operationId)}Response`),
    );
}

// JSON Schema `pattern` has no flags. Translate a case-insensitive character
// class, and refuse any other flagged pattern rather than drop its flags: a
// letter outside a class, or an escape that can stand for a letter or its case
// (`\x61`, `\u0041`, `\p{Lu}`, `\k<name>`, a backreference, an escaped letter).
// Only punctuation escapes and the case-neutral `\d \s \w \b \n \r \t \f \v`
// (and their negations) pass.
export function flaglessPattern(regex: RegExp): string {
  if (!regex.flags) return regex.source;
  const outside = regex.source.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  const escapes = [...regex.source.matchAll(/\\(.)/g)].map(([, c]) => c);
  if (
    regex.flags !== "i" ||
    /[a-z]/i.test(outside) ||
    escapes.some((c) => !/^(?:[^0-9A-Za-z]|[dDsSwWbBnrtfv])$/.test(c))
  )
    throw new Error(`No flagless form for the pattern ${regex}`);
  return regex.source.replace(/\[((?:\\.|[^\]\\])*)\]/g, (_, body: string) => {
    const other = (
      body.replace(/\\./g, "").match(/[a-z](?:-[a-z])?|[A-Z](?:-[A-Z])?/g) ?? []
    )
      .map((part) =>
        part === part.toLowerCase() ? part.toUpperCase() : part.toLowerCase(),
      )
      .join("");
    return `[${body}${other}]`;
  });
}
type JsonSchema = Record<string, unknown>;
const jsonSchemaParams = {
  metadata: docs,
  override: ({
    zodSchema,
    jsonSchema,
  }: {
    zodSchema: z.core.$ZodTypes;
    jsonSchema: JsonSchema;
  }) => {
    // A format schema is its own first check, as in zod's string processor.
    const checks = [zodSchema, ...(zodSchema._zod.def.checks ?? [])];
    const patterns = checks
      .map((check) => (check._zod.def as { pattern?: unknown }).pattern)
      .filter((pattern): pattern is RegExp => pattern instanceof RegExp);
    if (!patterns.some((regex) => regex.flags)) return;
    if (patterns.length !== 1)
      throw new Error("A flagged pattern must be the schema's only pattern");
    jsonSchema.pattern = flaglessPattern(patterns[0]);
  },
};
const strip = ({ $schema: _s, $id: _i, ...schema }: JsonSchema) => schema;

/**
 * Component schemas. Requests convert as zod input and responses as output;
 * a schema a request reaches must convert the same both ways.
 */
function componentSchemas(): Record<string, JsonSchema> {
  const convert = (io: "input" | "output") =>
    z.toJSONSchema(docs, {
      ...jsonSchemaParams,
      io,
      uri: (id) => ref(id).$ref,
    }).schemas as Record<string, JsonSchema>;
  const input = convert("input"),
    output = convert("output");
  const pending = [...requestIds],
    reached = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    const text = JSON.stringify(input[id]);
    if (text !== JSON.stringify(output[id]))
      throw new Error(
        `Request schema ${id} differs between zod input and output`,
      );
    for (const [, next] of text.matchAll(/"#\/components\/schemas\/([^"]+)"/g))
      pending.push(next);
  }
  return Object.fromEntries(
    Object.keys(output)
      .sort()
      .map((id) => [id, strip(output[id])]),
  );
}

const reasons: Record<ErrorStatus, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  413: "Request too large",
  429: "Too many requests",
  500: "Internal error",
  502: "Bad gateway",
  503: "Unavailable",
};
const duration = (seconds: number) =>
  seconds % 3600 === 0
    ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`
    : `${seconds / 60} minutes`;
const pathOf = (operationId: string) =>
  openApiPath(apiRoutes.find((route) => route.operationId === operationId)!.path);
/** Hono's `/api/vaults/:id` is OpenAPI's `/vaults/{id}`, under the `/v1` and `/api` servers. */
export const openApiPath = (path: string) =>
  path.replace(/^\/api(?=\/)/, "").replace(/:(\w+)/g, "{$1}");
const parameter = (
  name: string,
  where: "path" | "query" | "header",
  required: boolean,
  schema: z.ZodType,
) => {
  const { description, ...json } = strip(
    z.toJSONSchema(schema, { ...jsonSchemaParams, io: "input" }),
  );
  return { name, in: where, required, description, schema: json };
};

const securityOf = (auth: ReturnType<typeof routeAuth>) =>
  auth.kind === "none"
    ? {}
    : {
        security: [
          { session: [] },
          ...(auth.kind === "session-or-key" ? [{ apiKey: [auth.scope] }] : []),
        ],
      };

function operation(route: ApiRoute) {
  const responses: Record<string, unknown> = {};
  const keyed = acceptsIdempotencyKey(route);
  for (const [status, response] of Object.entries(route.responses))
    responses[status] = {
      description: response.description,
      ...(keyed
        ? {
            headers: {
              "Idempotency-Replayed": {
                description:
                  "`true` when this is a stored response replayed for an Idempotency-Key. It may be stale; read current state from the GET routes.",
                schema: { type: "string", const: "true" },
              },
            },
          }
        : {}),
      content: {
        "application/json": { schema: ref(schemaIds.get(response.schema)!) },
      },
    };
  const parameters = [
    ...Object.entries(route.params ?? {}).map(([name, schema]) =>
      parameter(name, "path", true, schema),
    ),
    ...Object.entries(route.query ?? {}).map(([name, schema]) =>
      parameter(name, "query", false, schema),
    ),
    ...(keyed ? [parameter("Idempotency-Key", "header", false, idempotencyKey)] : []),
  ];
  const errors = routeErrors(route);
  const statuses = Object.keys(errors).map(Number) as ErrorStatus[];
  for (const status of statuses.sort((a, b) => a - b)) {
    const codes = API_ERROR_CODES.filter((code) =>
      errors[status]!.includes(code),
    );
    responses[status] = {
      description: `${reasons[status]}: ${codes.map((code) => `\`${code}\``).join(", ")}.`,
      content: {
        "application/json": {
          schema: {
            allOf: [
              ref("ErrorResponse"),
              { properties: { code: { enum: codes } } },
            ],
          },
        },
      },
    };
  }
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    ...securityOf(routeAuth(route)),
    ...(parameters.length ? { parameters } : {}),
    ...(route.body
      ? {
          requestBody: {
            required: !route.bodyOptional,
            content: {
              "application/json": { schema: ref(schemaIds.get(route.body)!) },
            },
          },
        }
      : {}),
    responses,
  };
}

/** The OpenAPI 3.1 document for the mainnet API. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...apiRoutes].sort(
    (a, b) =>
      openApiPath(a.path).localeCompare(openApiPath(b.path)) ||
      a.method.localeCompare(b.method),
  );
  for (const route of sorted)
    (paths[openApiPath(route.path)] ??= {})[route.method] = operation(route);
  return {
    openapi: "3.1.0",
    info: {
      title: "QSB Vault API",
      version: packageJson.version,
      description: [
        "The QSB Vault server's JSON API: `createApp` in `server/app.ts`, as `server/lambda.ts` serves it on Bitcoin mainnet.",
        "",
        "Paths are relative to a server: `/v1` is the stable prefix, which the mainnet webapp uses; `/api` is the same API, kept as a compatibility alias.",
        "",
        "The server coordinates; it holds no secret. QSB state generation, the recovery backup, deposit signing and withdrawal assembly run on the client.",
        "",
        `Send the credential in \`${CREDENTIAL_HEADER}\` (see the security schemes), and on every request with a body, \`${BODY_HASH_HEADER}\`: the hex SHA-256 of the exact body bytes, which CloudFront origin access control to a Lambda function URL requires. The API itself doesn't check it.`,
        "",
        "Every error is JSON with an `error` message and a stable `code` (`ApiErrorCode`). A route that doesn't exist returns a plain-text 404.",
        "",
        "Generated by `npm run openapi` from `server/openapi.ts` and the zod schemas the handlers parse. Don't edit it by hand.",
      ].join("\n"),
    },
    servers: [
      { url: "/v1" },
      { url: "/api", description: "compatibility alias; the webapp uses /v1" },
    ],
    paths,
    webhooks: {
      ownerEvent: {
        post: {
          operationId: "ownerEventWebhook",
          summary: "An owner event, POSTed to each registered webhook that subscribes to its type",
          description: [
            "A notification, not the record: read `GET /api/events` for the log. At least once, best effort; deliveries can arrive out of order or more than once, so drop duplicates by `QSB-Event-Id`.",
            "",
            "Verify the raw body before parsing it: `QSB-Signature` is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 with the webhook's secret over `<t>.<raw body>`. Refuse a stale `t`.",
            "",
            `Answer any 2xx within ${REQUEST_TIMEOUT_MS / 1000} seconds; the body is ignored and redirects aren't followed. After a failed round the webhook waits ${RETRY_DELAYS_MS.map((ms) => (ms < 3600e3 ? `${ms / 60e3} min` : `${ms / 3600e3} h`)).join(", ")} between tries. An event is dropped after ${MAX_ATTEMPTS} failed attempts, and a webhook that fails ${FAILING_AFTER} rounds in a row is marked \`failing\`.`,
          ].join("\n"),
          parameters: [
            {
              name: "QSB-Signature",
              in: "header",
              required: true,
              description: "`t=<unix seconds>,v1=<hex HMAC-SHA256(secret, \"<t>.<raw body>\")>`.",
              schema: { type: "string", pattern: "^t=\\d+,v1=[a-f0-9]{64}$" },
            },
            {
              name: "QSB-Event-Id",
              in: "header",
              required: true,
              description: "The event's `id`. Drop duplicates by it.",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("OwnerEvent") } },
          },
          responses: {
            "2XX": { description: "Received. The body is ignored." },
          },
        },
      },
    },
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        session: {
          type: "apiKey",
          in: "header",
          name: CREDENTIAL_HEADER,
          description: [
            "A session token from BIP-322 sign-in:",
            "",
            `1. \`POST ${pathOf("createChallenge")}\` with the wallet address. The response has a challenge \`id\` and a \`message\`. The challenge lasts ${duration(CHALLENGE_SECONDS)} and works once.`,
            "2. Sign `message` with the address's key, as a BIP-322 signature.",
            `3. \`POST ${pathOf("verifyChallenge")}\` with the \`id\` and the \`signature\`. The response has the \`token\`.`,
            "",
            `Send \`${CREDENTIAL_HEADER}: Bearer <token>\`. \`Authorization: Bearer <token>\` is accepted too, but behind CloudFront origin access control that header carries CloudFront's signature, so use \`${CREDENTIAL_HEADER}\`. A session lasts ${duration(SESSION_SECONDS)} and is bound to the signing address and this deployment's network. After that, requests return \`session_expired\`; sign in again.`,
          ].join("\n"),
        },
        apiKey: {
          type: "apiKey",
          in: "header",
          name: CREDENTIAL_HEADER,
          description: [
            `An API key minted with a session (\`POST ${pathOf("createApiKey")}\`). It acts for the same owner. Send \`${CREDENTIAL_HEADER}: Bearer qsb_mainnet_<43 base64url characters>\`, or \`Authorization: Bearer …\` where the API isn't behind CloudFront origin access control.`,
            "",
            "An operation that accepts a key lists the one scope the key needs (`ApiKeyScope`). The key-management routes take a session only.",
            "",
            "A key works only on the network in its prefix, until it expires or is revoked. Keys are refused with `api_keys_disabled` unless the deployment switches them on (`apiKeysEnabled` in the configuration).",
          ].join("\n"),
        },
      },
    },
  };
}

export const serializeOpenApi = (
  document: ReturnType<typeof openApiDocument>,
) => `${JSON.stringify(document, null, 2)}\n`;
