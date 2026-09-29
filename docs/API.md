# API

The server is a JSON HTTP API under `/api`: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts). This page covers its errors.

## OpenAPI

[`docs/api/openapi.json`](api/openapi.json) is the OpenAPI 3.1 document for the mainnet API: every route, its sign-in requirement, request and response schemas, and the error codes each route can return, by status.

It's generated; don't edit it by hand. After changing a route, a request schema or a code, regenerate it and commit the result:

```sh
npm run openapi
```

[`server/openapi.ts`](../server/openapi.ts) holds the route registry. Request schemas are the zod objects the handlers parse ([`server/api-schemas.ts`](../server/api-schemas.ts) and [`src/lib/model.ts`](../src/lib/model.ts)). [`tests/openapi.test.ts`](../tests/openapi.test.ts) fails when the committed file is stale, when `createApp` serves a route the document lacks (or the reverse), or when a route's sign-in requirement differs from the server's. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) also checks that the document lists each status and code it drives.

## Errors

Every error response has a JSON body with a message and a code:

```json
{ "error": "Vault not found", "code": "vault_not_found" }
```

- `error` is for people. Its wording can change, so don't parse it.
- `code` is stable and machine-readable. Branch on it.
- Some errors add fields. `invalid_request` adds `issues`, each with a `path` and a `message`. `operations_disabled` from `POST /api/vaults/:id/fund` adds the release `checks`.
- A code isn't tied to one HTTP status. For example, `vault_not_found` is a 404 from the vault routes and a 409 from deposit submission. Adding the codes didn't change any status or message.

[`server/api-errors.ts`](../server/api-errors.ts) is the source of truth. It exports `apiErrorCodes` (each code and its meaning), the `ApiErrorCode` type and the `API_ERROR_CODES` list. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) drives every code through `createApp` and checks that this table lists each one.

| Area | Codes |
|---|---|
| Request | `invalid_request`, `request_too_large`, `network_mismatch` |
| Sign-in | `auth_required`, `session_expired`, `challenge_expired`, `signature_invalid` |
| Switches | `operations_disabled`, `submit_disabled` |
| Vaults and deposits | `vault_invalid`, `vault_not_found`, `vault_not_funded`, `vault_not_confirmed`, `funding_intent_exists`, `funding_transaction_invalid`, `signed_deposit_not_found` |
| Withdrawal jobs | `job_not_found`, `job_unsupported`, `job_state_invalid`, `idempotency_conflict`, `withdrawal_invalid`, `solver_not_served`, `solved_result_unavailable`, `reconcile_required`, `operator_review_required`, `coverage_stopped` |
| Withdrawal submission | `intent_not_found`, `intent_conflict`, `exact_spend_mismatch`, `consensus_rejected`, `inclusion_check_failed` |
| Chain and miner | `input_unavailable`, `chain_transaction_not_found`, `chain_unavailable`, `chain_error`, `miner_unavailable`, `miner_rate_unavailable` |
| General | `state_conflict`, `internal_error` |

A route that doesn't exist gets Hono's plain-text 404, not a JSON error.

In the browser client, a failed request throws `ApiRequestError` ([`src/lib/session.ts`](../src/lib/session.ts)), which carries the `status` and the `code`.
