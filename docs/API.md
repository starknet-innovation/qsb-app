# API

The server is a JSON HTTP API: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts). It is non-custodial: keys, passphrases and one-time material stay on the caller's side. This page covers its prefixes, OpenAPI document, errors and idempotency.

## Prefixes

- `/v1` is the stable prefix for integrators.
- `/api` serves the same routes. The webapp still calls it; moving the webapp onto `/v1` (#85) is a follow-up after the phase-2 API PRs land.

Both prefixes reach the same handlers and middleware: secure headers, CORS, the body limit, sign-in and error mapping. With `versionedAlias`, `createApp` rewrites a leading `/v1` segment to `/api` before routing, so a route is defined once. Only the coordinator API opts in: the mainnet Lambda (`server/lambda.ts`) and the local server (`server/local.ts`). The parked supervised apps have no `/v1`. CloudFront forwards `/v1/*` and `/api/*` to the API with the same uncached behaviour (`terraform/web.tf`).

## OpenAPI

[`docs/api/openapi.json`](api/openapi.json) is the OpenAPI 3.1 document for the mainnet API: every route, its sign-in requirement, request and response schemas, and the error codes each route can return, by status. Its paths are relative to its two servers, `/v1` and the `/api` webapp alias.

It's generated; don't edit it by hand. After changing a route, a request schema or a code, regenerate it and commit the result:

```sh
npm run openapi
```

[`server/openapi.ts`](../server/openapi.ts) holds the route registry. Request schemas are the zod objects the handlers parse ([`server/api-schemas.ts`](../server/api-schemas.ts) and [`src/lib/model.ts`](../src/lib/model.ts)). The `Idempotency-Key` header parameter and its error codes come from `idempotentPosts` in [`server/idempotency.ts`](../server/idempotency.ts). [`tests/openapi.test.ts`](../tests/openapi.test.ts) fails when the committed file is stale, when the mainnet Lambda's app (`deployedApiApp` in [`server/lambda.ts`](../server/lambda.ts)) serves a route the document lacks (or the reverse), or when a route's sign-in requirement differs from the server's. It also fails when an error site in [`tests/api-error-sites.json`](../tests/api-error-sites.json) isn't listed: a route's own site for that route and status, and any other site by an error source in the registry that covers it, unless the registry records why it never reaches a response. The snapshot covers `server/app.ts` and every server module it imports, `server/runtime/` included, and each error class `app.onError` answers for. Which sources a route merges, that is which helpers it calls, is declared by hand. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) also checks that the document lists each status and code it drives.

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

[`server/api-errors.ts`](../server/api-errors.ts) is the source of truth. It exports `apiErrorCodes` (each code and its meaning), the `ApiErrorCode` type and the `API_ERROR_CODES` list. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) drives every code through `createApp`, checks that this table lists each one, and pins each error site's status, code and message in [`tests/api-error-sites.json`](../tests/api-error-sites.json), across `server/app.ts` and the server modules it imports.

| Area | Codes |
|---|---|
| Request | `invalid_request`, `request_too_large`, `network_mismatch` |
| Sign-in | `auth_required`, `session_expired`, `challenge_expired`, `signature_invalid` |
| Switches | `operations_disabled`, `submit_disabled` |
| Idempotency | `idempotency_conflict`, `idempotency_in_progress` |
| Vaults and deposits | `vault_invalid`, `vault_not_found`, `vault_not_funded`, `vault_not_confirmed`, `funding_intent_exists`, `funding_transaction_invalid`, `signed_deposit_not_found` |
| Withdrawal jobs | `job_not_found`, `job_unsupported`, `job_state_invalid`, `withdrawal_invalid`, `solver_not_served`, `solved_result_unavailable`, `reconcile_required`, `operator_review_required`, `coverage_stopped` |
| Withdrawal submission | `intent_not_found`, `intent_conflict`, `exact_spend_mismatch`, `consensus_rejected`, `inclusion_check_failed` |
| Inputs | `input_not_found`, `input_mismatch`, `input_unconfirmed`, `input_spent` |
| Chain and miner | `chain_transaction_not_found`, `chain_unavailable`, `chain_error`, `miner_unavailable`, `miner_request_failed`, `miner_rate_unavailable` |
| General | `state_conflict`, `internal_error` |

In the browser client, a failed request throws `ApiRequestError` ([`src/lib/session.ts`](../src/lib/session.ts)). It carries the `status`, and the `code` when the body has one. A failure whose body isn't a JSON object has no code.

## Idempotency-Key

These POSTs accept an optional `Idempotency-Key` header, 8 to 128 characters from `A-Z a-z 0-9 _ -`:

- `/vaults`
- `/vaults/:id/fund`
- `/vaults/:id/fund/submit`
- `/vaults/:id/fund/resubmit`
- `/jobs/:id/submit`
- `/jobs/:id/pause`
- `/jobs/:id/resume`

`POST /jobs` keeps the manifest's `idempotencyKey`, and its reuse for a different withdrawal is also `idempotency_conflict`. Other routes ignore the header.

A key names one attempt. It belongs to one owner and one route, and for 24 hours it is bound to its first request's path and body. A retry with the same key gets:

- **the same request, after a 2xx that settled the outcome**, including a deposit MARA refused (`submission: "rejected"`): the stored status and body, with `Idempotency-Replayed: true`. The handler doesn't run.
- **the same request, while the first is still running**: 409 `idempotency_in_progress`, with `Retry-After`.
- **the same request, after an error or an `"uncertain"` outcome, or once the lease of a request that never finished runs out**: the handler runs again, as it would for a retry without the header.
- **a different path or body**: 409 `idempotency_conflict`.

A malformed key gets 400 `invalid_request`. Malformed JSON is a 4xx like any other: it isn't stored, and the key stays bound to that body. Without the header, nothing changes.

A replay is the first attempt's result, not the current state, and may be stale. Read current state from the GET routes. The bodies of `fund/resubmit`, `pause` and `resume` are empty, so a reused key always matches the first request. A new attempt, such as a resend after MARA dropped a deposit, a second pause or a second resume, needs a new key.

**Submit safety.** The layer can only skip the handler; it never sends anything itself. Nothing is stored as final for a 4xx, a 5xx, or a 2xx whose `submission` or `status` is `"uncertain"`. Each attempt leases the key for 150 seconds from its start, longer than the API Lambda can run. If it stops before its outcome is recorded, a retry after the lease reaches the handler, and the handler's own intent rules decide what happens: a deposit resend asks MARA first and sends only the stored bytes; a withdrawal with a stored intent is never resubmitted.

Records are rows `OWNER#<owner>` / `IDEMPOTENCY#<route>#<key>`, holding the request hash, a lease, the settled response and `expiresAt` (the table's TTL attribute).
