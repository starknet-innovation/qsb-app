import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

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
  auth_required: "No well-formed `Authorization: Bearer <token>` header was sent.",
  session_expired:
    "The session is unknown, expired or for another network. Sign in again.",
  challenge_expired:
    "The sign-in challenge is unknown, expired, already used or for another network.",
  signature_invalid: "The BIP-322 signature doesn't verify for the challenge.",
  network_mismatch:
    "The address or vault is for a different Bitcoin network than this deployment.",
  operations_disabled:
    "Deposits and withdrawals are switched off for this deployment or address.",
  submit_disabled: "Submission to the miner is switched off.",
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
    "The idempotency key already belongs to a different withdrawal.",
  withdrawal_invalid:
    "The withdrawal doesn't match the vault's deposit, or its destination or amounts don't balance.",
  solver_not_served:
    "The requested solver release isn't served by this deployment. Nothing was reserved.",
  solved_result_unavailable: "No solved result is available for this job.",
  reconcile_required:
    "An unknown compute submission must be reconciled before the job can resume.",
  operator_review_required: "The job's failure needs operator review.",
  coverage_stopped: "The job's stopped search coverage can't resume on this account.",
  intent_not_found: "No recorded transaction intent with this id.",
  intent_conflict:
    "A different transaction intent already exists for this job. Reconcile it.",
  exact_spend_mismatch:
    "The signed transaction doesn't match the approved inputs, output, amount and fee.",
  consensus_rejected: "The offline Bitcoin Core consensus check refused the transaction.",
  inclusion_check_failed: "The inclusion evidence for this transaction was refused.",
  input_unavailable:
    "An input is missing, spent, unconfirmed, or doesn't match the stated amount or script.",
  chain_transaction_not_found: "The chain provider doesn't know this transaction (yet).",
  chain_unavailable: "A chain provider request failed. Retry later.",
  chain_error:
    "The chain provider's answer was malformed, inconsistent, too large or for another network.",
  miner_unavailable: "The miner credential or authorization is unavailable.",
  miner_rate_unavailable: "The miner's live fee quote is unavailable. Retry later.",
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
