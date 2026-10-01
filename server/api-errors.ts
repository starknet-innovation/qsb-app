import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/**
 * Machine-readable codes for the API's JSON errors. Every error body is
 * `{ error, code, ...extra }`: `error` is the human-readable message, which
 * may change; `code` is stable, so integrators branch on it. A code isn't
 * tied to one HTTP status. The value is the code's meaning.
 */
export const apiErrorCodes = {
  invalid_request:
    "Validation failed, usually of the body or a path parameter. `issues` lists each problem.",
  request_too_large: "The request body is over the size limit.",
  auth_required: "No well-formed `X-Qsb-Authorization: Bearer <token>` (or `Authorization: Bearer <token>`) header was sent.",
  session_expired:
    "The session is unknown, expired or for another network. Sign in again.",
  challenge_expired:
    "The sign-in challenge is unknown, expired, already used or for another network.",
  signature_invalid: "The BIP-322 signature doesn't verify for the challenge.",
  api_key_invalid: "The API key is unknown or expired.",
  api_key_revoked: "The API key was revoked.",
  api_key_not_allowed:
    "API keys can't call this route: it takes a wallet session, or has no scope mapping.",
  api_key_scope_denied: "The API key lacks a scope this route needs.",
  api_key_limit_reached:
    "The owner already has the maximum number of active API keys. Revoke one first.",
  api_key_not_found: "No unexpired API key with this id for the signed-in owner.",
  api_keys_disabled: "API keys are switched off for this deployment.",
  network_mismatch:
    "The address, vault or API key is for a different Bitcoin network than this deployment.",
  operations_disabled:
    "Deposits and withdrawals are switched off for this deployment or address.",
  submit_disabled: "Submission to the miner is switched off.",
  owner_not_allowlisted:
    "This deployment has an owner allowlist, and it doesn't list the signed-in address.",
  owner_active_withdrawal_limit:
    "The owner already has the most queued or searching withdrawals this deployment allows.",
  owner_gpu_budget_reached:
    "The owner's GPU-time budget can't cover another submission. Nothing was reserved.",
  owner_limits_invalid:
    "The deployment's owner-limit settings are malformed, so this action is refused.",
  vault_invalid:
    "The vault's ownership, funding state or script commitment is wrong.",
  vault_not_found: "No vault with this id for the signed-in owner.",
  vault_not_funded: "The vault has no deposit yet.",
  vault_not_confirmed: "The vault's deposit isn't confirmed yet.",
  funding_intent_exists:
    "The vault already has a different deposit. Reconcile it; a vault takes one deposit.",
  funding_transaction_invalid:
    "The deposit doesn't parse, or doesn't pay this vault the stated amount at output 0.",
  signed_deposit_not_found: "The vault has no stored signed deposit.",
  job_not_found: "No withdrawal job with this id for the signed-in owner.",
  job_unsupported:
    "The job isn't a coordinator withdrawal, so this route doesn't serve it.",
  job_state_invalid: "The job's current status doesn't allow this action.",
  idempotency_conflict:
    "The idempotency key already belongs to a different request: the manifest's key to another withdrawal, or the Idempotency-Key header to another path or body.",
  idempotency_in_progress:
    "A request with this Idempotency-Key is still running. Retry after `Retry-After` seconds.",
  withdrawal_invalid:
    "The withdrawal doesn't match the vault's deposit, or its destination or amounts don't balance.",
  solver_not_served:
    "The requested solver release isn't served by this deployment. Nothing was reserved.",
  solved_result_unavailable: "No solved result is available for this job.",
  reconcile_required:
    "An unknown compute submission must be reconciled before the job can resume.",
  operator_review_required: "The job's failure needs operator review.",
  intent_not_found: "No recorded transaction intent with this id.",
  intent_conflict:
    "A different transaction intent already exists for this job. Reconcile it.",
  exact_spend_mismatch:
    "The signed transaction doesn't match the approved inputs, output, amount and fee.",
  consensus_rejected: "The offline Bitcoin Core consensus check refused the transaction.",
  inclusion_check_failed: "The inclusion evidence for this transaction was refused.",
  input_not_found: "The input's transaction has no output at this index.",
  input_mismatch: "The input's output doesn't have the stated amount or script.",
  input_unconfirmed:
    "The input's transaction is unconfirmed or was reorganized out. Wait and retry.",
  input_spent: "The input is already spent. Choose another.",
  chain_transaction_not_found: "The chain provider doesn't know this transaction (yet).",
  chain_unavailable: "A chain provider request failed. Retry later.",
  chain_error:
    "The chain provider's answer was malformed, inconsistent, too large or for another network.",
  miner_unavailable: "The miner credential or authorization is unavailable.",
  miner_request_failed:
    "A miner request failed, or its answer was malformed. Retry later.",
  miner_rate_unavailable: "The miner's live fee quote is unavailable. Retry later.",
  webhook_url_invalid:
    "The webhook URL isn't a URL, isn't https on port 443, or has credentials in it.",
  webhook_url_forbidden:
    "The webhook URL's host is a local name, or it is or resolves to a private or reserved address.",
  webhook_url_unresolvable: "The webhook URL's host name doesn't resolve.",
  webhook_limit_reached: "The account already has the most webhooks it can register.",
  webhook_not_found: "No webhook with this id for the signed-in owner.",
  state_conflict: "The record changed during the request. Refresh and retry.",
  internal_error: "An unexpected server error. Retry.",
} as const;
export type ApiErrorCode = keyof typeof apiErrorCodes;
export const API_ERROR_CODES = Object.keys(apiErrorCodes) as ApiErrorCode[];

/** A JSON error response. `extra` fields (e.g. `issues`, `checks`) sit next to `error` and `code`. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  error: string,
  extra?: Record<string, unknown>,
) {
  return c.json({ error, code, ...extra }, status);
}

const attached = new WeakMap<object, ApiErrorCode>();
/**
 * Run `run`. If it throws or rejects, rethrow the same error with `code` attached.
 * The error keeps its class and message, so callers' catches and app.onError's
 * status and body don't change; only the response's `code` does. The innermost
 * code wins.
 */
export function withApiErrorCode<T>(code: ApiErrorCode, run: () => T): T {
  const attach = (error: unknown) => {
    if (typeof error === "object" && error !== null && !attached.has(error))
      attached.set(error, code);
    return error;
  };
  try {
    const result = run();
    return result instanceof Promise
      ? (result.catch((error) => {
          throw attach(error);
        }) as T)
      : result;
  } catch (error) {
    throw attach(error);
  }
}
/** The code withApiErrorCode attached to `error`, if any. */
export function attachedApiErrorCode(error: unknown): ApiErrorCode | undefined {
  return typeof error === "object" && error !== null
    ? attached.get(error)
    : undefined;
}

/**
 * The status app.onError gives an error carrying one of these attached codes, whatever its
 * class, unless onError maps the class first. Each marks a failure that no error class
 * identifies. Other attached codes keep their class's status. Only the response changes: the
 * error keeps its class and message, so no catch or instanceof check behaves differently.
 */
export const attachedCodeStatus = {
  // The chain provider gave no answer (DNS, refused connection, timeout, broken body). Chain
  // reads have no side effects, so a retry later is safe.
  chain_unavailable: 503,
  // The provider answered, but the answer doesn't parse. It's the provider's fault, not the caller's.
  chain_error: 502,
  // The caller's outpoint is past its transaction's outputs, like the other input_* codes.
  input_not_found: 409,
  // The two miner codes split by what the miner did, not by whether anything reached it.
  // Neither comes from this request's own POST: submitFunding and submitExact catch its
  // failures. On a retry (fund/submit with the same bytes, or fund/resubmit), an earlier
  // request's POST may have landed, so neither is a refusal: clients must treat both as uncertain.
  //
  // The miner credential is unavailable: it couldn't be read, like a refused credential
  // (a MinerAuthenticationError, which onError also answers with 503 miner_unavailable).
  miner_unavailable: 503,
  // The miner answered badly or not at all: no response, an error status other than 401 or
  // 403, or a malformed body.
  miner_request_failed: 502,
} as const satisfies Partial<Record<ApiErrorCode, ContentfulStatusCode>>;
/** The status attachedCodeStatus sets for `code`, if it sets one. */
export function attachedCodeStatusOf(
  code: ApiErrorCode | undefined,
): ContentfulStatusCode | undefined {
  return code !== undefined && code in attachedCodeStatus
    ? attachedCodeStatus[code as keyof typeof attachedCodeStatus]
    : undefined;
}
/**
 * The status app.onError gives a ChainError with this code: 409, except chain_unavailable
 * (the chain provider's error status), which has the same status as an unanswered request.
 */
export function chainErrorStatus(code: ApiErrorCode): ContentfulStatusCode {
  return code === "chain_unavailable" ? attachedCodeStatus.chain_unavailable : 409;
}
// A thrown ZodError built by parse (unlike `new z.ZodError`) is an Error, which Hono's onError needs.
const notJson = z.custom<never>(() => false, "Request body is not valid JSON.");
/** The request's JSON body. Malformed JSON is a 400 invalid_request, like a schema failure. */
export async function jsonBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return await c.req.json();
  } catch (error) {
    // Only a syntax error: a body over the limit must still reach bodyLimit's 413.
    if (!(error instanceof SyntaxError)) throw error;
    return notJson.parse(undefined);
  }
}
