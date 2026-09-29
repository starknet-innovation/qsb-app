# API

The server is a JSON HTTP API under `/api`: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts). This page covers its errors, and its event log and webhooks. An OpenAPI spec is planned under #85.

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
| Vaults and deposits | `vault_invalid`, `vault_not_found`, `vault_not_funded`, `vault_not_confirmed`, `funding_intent_exists`, `funding_transaction_invalid`, `signed_deposit_not_found` |
| Withdrawal jobs | `job_not_found`, `job_unsupported`, `job_state_invalid`, `idempotency_conflict`, `withdrawal_invalid`, `solver_not_served`, `solved_result_unavailable`, `reconcile_required`, `operator_review_required`, `coverage_stopped` |
| Withdrawal submission | `intent_not_found`, `intent_conflict`, `exact_spend_mismatch`, `consensus_rejected`, `inclusion_check_failed` |
| Inputs | `input_not_found`, `input_mismatch`, `input_unconfirmed`, `input_spent` |
| Chain and miner | `chain_transaction_not_found`, `chain_unavailable`, `chain_error`, `miner_unavailable`, `miner_request_failed`, `miner_rate_unavailable` |
| Webhooks | `webhook_url_invalid`, `webhook_url_forbidden`, `webhook_url_unresolvable`, `webhook_limit_reached`, `webhook_not_found` |
| General | `state_conflict`, `internal_error` |

In the browser client, a failed request throws `ApiRequestError` ([`src/lib/session.ts`](../src/lib/session.ts)). It carries the `status`, and the `code` when the body has one. A failure whose body isn't a JSON object has no code.

## Events and webhooks

Withdrawals take hours. Instead of polling each job, read your account's event log, and optionally register webhooks that tell you when to read it. All routes need a signed-in session (`Authorization: Bearer <token>`).

### Event types

| Type | When |
|---|---|
| `withdrawal.queued` | A withdrawal is created, resumed, or moves to its next search stage. |
| `withdrawal.searching` | GPU search starts for a stage. |
| `withdrawal.paused` | The search stops: paused by you, by the deployment, or waiting on an operator. |
| `withdrawal.failed` | The withdrawal can't continue. |
| `withdrawal.awaiting_authorization` | The solution is verified; assemble and approve the withdrawal. |
| `withdrawal.submitted` | The signed withdrawal is recorded for the miner. |
| `withdrawal.confirmed` | The withdrawal is confirmed on chain. |
| `deposit.submitted` | A deposit is recorded as sent, and not yet confirmed. |
| `deposit.confirmed` | The deposit is confirmed. |
| `deposit.spent` | The vault's deposit was spent by its withdrawal. |
| `deposit.dropped` | The miner doesn't have the deposit. Either it refused a new deposit (the vault is unfunded again), or a resend found it no longer had a submitted deposit and the resend wasn't accepted (the vault stays submitted; resend or contact the operator). |

An event is thin: identifiers and statuses, never transaction bytes, scripts or anything secret.

```json
{ "id": "evt_…", "type": "withdrawal.awaiting_authorization", "subjectId": "<job id>", "status": "awaiting_authorization", "stage": "verification", "at": "2026-09-29T12:00:00.000Z" }
```

`subjectId` is the job id for `withdrawal.*` and the vault id for `deposit.*`. `stage` is on withdrawal events only. Read details from `GET /api/jobs/:id/status` or `GET /api/vaults`.

### Pull: `GET /api/events?after=<cursor>&limit=<1-100>`

Returns `{ events, next, hasMore }`, oldest first. Keep `next` and pass it as `after` on the next call; without `after` you get everything retained. Events are kept for 30 days, and are listed once they are 10 seconds old, so in normal operation a write still in flight can't land behind your cursor. The log is the record: a webhook only tells you to read it.

### Webhooks

- `POST /api/webhooks` with `{ "url": "https://…", "events": ["withdrawal.awaiting_authorization"] }` (omit `events` for all types) returns `{ webhook, secret }`. **The secret is shown only in this response.** At most 5 per account. The service keeps the secret to sign deliveries, and it stays in the service's database backups for up to 35 days after you delete the webhook. To rotate it, delete the webhook and register it again.
- `GET /api/webhooks` lists them, with `status` (`active` or `failing`), `failures`, `pending`, and the last delivery and failure. Never the secret.
- `POST /api/webhooks/:id/delete` removes one and its queued deliveries.

URLs must be `https` on port 443, without credentials, on a public host name or address. Private, loopback, link-local, CGNAT, unique-local, multicast and reserved addresses are refused, at registration and again at every delivery: the host is resolved, every address is checked, and the connection goes to the checked address. Redirects are not followed.

Each delivery is a `POST` of one event as JSON, with:

- `QSB-Event-Id`: the event id. Use it to drop duplicates.
- `QSB-Signature: t=<unix seconds>,v1=<hex>`: HMAC-SHA256 with your secret over `<t>.<raw body>`.

Verify the raw body before parsing it:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, header: string, rawBody: string, toleranceSeconds = 300) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
  if (!match) return false;
  const [, t, v1] = match;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}
```

Answer with any 2xx within 1 second; slower answers can time out, and the response body is ignored.

### Delivery and retries

At least once, best effort; **the pull endpoint is authoritative**.

- Deliveries are sent right after the change that caused them, from the request or coordinator step that made it, within a budget of a few seconds (API) or two seconds (coordinator). When a step has no time left to send, its deliveries are still queued. An API request that has already taken about 28 seconds skips this work, so its response still beats API Gateway's 30-second timeout. A change it made outside a transaction can then be missing from the event log; the job and vault endpoints still show it. Retries and queued deliveries go out on later coordinator steps and later API calls for your account, so an idle account's deliveries wait for its next activity.
- After a failed attempt the webhook waits 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, then 4 h between tries. An event is dropped after 8 failed attempts, and a webhook that fails 8 times in a row is marked `failing` and gets no more deliveries: delete it and register it again.
- Up to 100 deliveries wait per account; past that the oldest are dropped.
- Deliveries can arrive out of order or more than once. Use `at`, `QSB-Event-Id` and the pull endpoint to reconcile.
