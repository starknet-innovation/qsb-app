# API

The server is a JSON HTTP API under `/api`: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts). This page covers its errors and the per-owner limits. An OpenAPI spec is planned under #85.

## Errors

Every error that `createApp` returns has a JSON body with a message and a code:

```json
{ "error": "Vault not found", "code": "vault_not_found" }
```

- `error` is for people. Its wording can change, so don't parse it.
- `code` is stable and machine-readable. Branch on it.
- Some errors add fields. `invalid_request` adds `issues`, each with a `path` and a `message`; a body that isn't valid JSON is one too. `operations_disabled` from `POST /api/vaults/:id/fund` adds the release `checks`.
- A code isn't tied to one HTTP status. For example, `vault_not_found` is a 404 from the vault routes and a 409 from deposit submission. A chain or miner request that fails before any answer is `chain_unavailable` or `miner_request_failed` with a 500, and a malformed provider answer is `chain_error` or `miner_request_failed` with a 400 or a 500.

Errors produced in front of the app have no `code`. That includes errors from the API gateway, for example on throttling or when the function fails or times out (these can be JSON with only a `message` field), other non-JSON proxy errors, and Hono's plain-text 404 for a route that doesn't exist.

[`server/api-errors.ts`](../server/api-errors.ts) is the source of truth. It exports `apiErrorCodes` (each code and its meaning), the `ApiErrorCode` type and the `API_ERROR_CODES` list. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) drives every code through `createApp`, checks that this table lists each one, and pins each error site's status, code and message in [`tests/api-error-sites.json`](../tests/api-error-sites.json).

| Area | Codes |
|---|---|
| Request | `invalid_request`, `request_too_large`, `network_mismatch` |
| Sign-in | `auth_required`, `session_expired`, `challenge_expired`, `signature_invalid` |
| Switches | `operations_disabled`, `submit_disabled` |
| Owner limits | `owner_not_allowlisted`, `owner_active_withdrawal_limit`, `owner_gpu_budget_reached`, `owner_limits_invalid` |
| Vaults and deposits | `vault_invalid`, `vault_not_found`, `vault_not_funded`, `vault_not_confirmed`, `funding_intent_exists`, `funding_transaction_invalid`, `signed_deposit_not_found` |
| Withdrawal jobs | `job_not_found`, `job_unsupported`, `job_state_invalid`, `idempotency_conflict`, `withdrawal_invalid`, `solver_not_served`, `solved_result_unavailable`, `reconcile_required`, `operator_review_required`, `coverage_stopped` |
| Withdrawal submission | `intent_not_found`, `intent_conflict`, `exact_spend_mismatch`, `consensus_rejected`, `inclusion_check_failed` |
| Inputs | `input_not_found`, `input_mismatch`, `input_unconfirmed`, `input_spent` |
| Chain and miner | `chain_transaction_not_found`, `chain_unavailable`, `chain_error`, `miner_unavailable`, `miner_request_failed`, `miner_rate_unavailable` |
| General | `state_conflict`, `internal_error` |

In the browser client, a failed request throws `ApiRequestError` ([`src/lib/session.ts`](../src/lib/session.ts)). It carries the `status`, and the `code` when the body has one. A failure whose body isn't a JSON object has no code.

## Per-owner limits

Three deployment switches limit what one owner, the signed-in wallet address, can do. Each is off when unset or empty, which keeps the default behaviour. They only add refusals, and a refusal writes nothing and starts nothing. [`server/owner-limits.ts`](../server/owner-limits.ts) implements them; the [runbook](OPERATIONAL-RUNBOOK.md#per-owner-limits) covers operating them.

- **`QSB_OWNER_ALLOWLIST`** (Terraform `owner_allowlist`): only listed owners may register a vault, deposit (`/fund`, `/fund/submit`, `/fund/signed`, `/fund/resubmit`), or create or resume a withdrawal; others get 403 `owner_not_allowlisted`. The coordinator pauses other owners' withdrawals.
- **`QSB_OWNER_MAX_ACTIVE_JOBS`** (Terraform `owner_max_active_jobs`): the most withdrawals one owner may have queued or searching. Pausing frees a slot, and resume claims one again. Over the limit, `POST /api/jobs` and `POST /api/jobs/:id/resume` return 429 `owner_active_withdrawal_limit`.
- **`QSB_OWNER_MAX_GPU_SECONDS`** (Terraform `owner_max_gpu_seconds`): GPU seconds reserved across all of one owner's withdrawals. Once it can't cover another submission, `POST /api/jobs` returns 429 `owner_gpu_budget_reached`, and the coordinator pauses the withdrawal.

A malformed value, including a GPU budget smaller than one submission's reservation, refuses these routes with 503 `owner_limits_invalid`, and `GET /api/config` then reports `ownerLimits: null`. A creation or resume that races another for the last slot, or a creation that races for the last of the GPU budget, gets 409 `state_conflict` and writes nothing.

Sign-in, reads and pause stay open, and so does `POST /api/jobs/:id/submit`: it sends the owner's own solved withdrawal and uses no GPU. Replaying an `idempotencyKey` returns the existing job and takes no slot.

`GET /api/config` reports `ownerLimits`: `allowlist` (whether one is set), `allowlisted` (the signed-in caller's standing, or `null` without a session or an allowlist), `maxActiveJobs` and `maxGpuSeconds`. It never returns the list.
