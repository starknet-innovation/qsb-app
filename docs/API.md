# API

The server is a JSON HTTP API: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts). It is non-custodial: keys, passphrases and one-time material stay on the caller's side, except the HORS preimages a signed withdrawal reveals by design. This page covers its prefixes, request headers, OpenAPI document, errors, per-owner limits, stray payments, idempotency, API keys, and its event log and webhooks.

## Prefixes

- `/v1` is the stable prefix, for integrators and the mainnet webapp. The webapp builds every API URL from `API_BASE_PATH` in [`src/lib/network.ts`](../src/lib/network.ts) (#85).
- `/api` serves the same routes and stays for compatibility: a browser may still run a bundle cached from before the move. The webapp calls `/v1`; QSB runs on mainnet only.

Both prefixes reach the same handlers and middleware: secure headers, CORS, the body limit, sign-in and error mapping. With `versionedAlias`, `createApp` rewrites a leading `/v1` segment to `/api` before routing, so a route is defined once. Only the coordinator API opts in: the mainnet Lambda (`server/lambda.ts`) and the local server (`server/local.ts`). CloudFront forwards `/v1/*` and `/api/*` to the API with the same uncached behaviour (`terraform/web.tf`), and `npm run dev`'s Vite proxy forwards both to the local server.

## Request headers

These two headers let the API sit behind CloudFront origin access control to a Lambda function URL, which signs each request with its own `Authorization` header and refuses a POST without a body hash.

- **Credential.** Send a session token or an API key as `X-Qsb-Authorization: Bearer <credential>`. `Authorization: Bearer <credential>` is accepted too; when both are sent, `X-Qsb-Authorization` wins. The server reads only a bearer from `Authorization`, never a signature.
- **Body hash.** On every request with a body, send `x-amz-content-sha256` with the hex SHA-256 of the exact body bytes. The API itself doesn't check it.

The webapp and the SDK send both ([`src/lib/session.ts`](../src/lib/session.ts)), and CORS allows them.

## OpenAPI

[`docs/api/openapi.json`](api/openapi.json) is the OpenAPI 3.1 document for the mainnet API: every route, its sign-in requirement, request and response schemas, and the error codes each route can return, by status. Its paths are relative to its two servers, `/v1` and the `/api` compatibility alias.

It's generated; don't edit it by hand. After changing a route, a request schema or a code, regenerate it and commit the result:

```sh
npm run openapi
```

[`server/openapi.ts`](../server/openapi.ts) holds the route registry. Request schemas are the zod objects the handlers parse ([`server/api-schemas.ts`](../server/api-schemas.ts) and [`src/lib/model.ts`](../src/lib/model.ts)). The `Idempotency-Key` header parameter and its error codes come from `idempotentPosts` in [`server/idempotency.ts`](../server/idempotency.ts). [`tests/openapi.test.ts`](../tests/openapi.test.ts) fails when the committed file is stale, when the mainnet Lambda's app (`deployedApiApp` in [`server/lambda.ts`](../server/lambda.ts)) serves a route the document lacks (or the reverse), or when a route's sign-in requirement differs from the server's. It also fails when an error site in [`tests/api-error-sites.json`](../tests/api-error-sites.json) isn't listed: a route's own site for that route and status, and any other site by an error source in the registry that covers it, unless the registry records why it never reaches a response. The snapshot covers `server/app.ts` and every server module it imports, and each error class `app.onError` answers for. Which sources a route merges, that is which helpers it calls, is declared by hand. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) also checks that the document lists each status and code it drives.

## Errors

Every error that `createApp` returns has a JSON body with a message and a code:

```json
{ "error": "Vault not found", "code": "vault_not_found" }
```

- `error` is for people. Its wording can change, so don't parse it.
- `code` is stable and machine-readable. Branch on it.
- Some errors add fields. `invalid_request` adds `issues`, each with a `path` and a `message`; a body that isn't valid JSON is one too. `operations_disabled` from `POST /api/vaults/:id/fund` adds the release `checks`.
- A code isn't tied to one HTTP status. For example, `vault_not_found` is a 404 from the vault routes and a 409 from deposit submission.
- A failed provider request is a 5xx. `chain_unavailable` is a 503: the chain provider gave no answer (DNS, a refused connection, the 15-second timeout) or an error status. `miner_unavailable` is a 503: the miner credential can't be read or was refused. `miner_request_failed` is a 502: the miner gave no usable answer (no response, a timeout, an error status such as a 5xx or 429, or a malformed body). `chain_error` is a 502 when the chain provider's answer doesn't parse (a schema failure, a body that isn't JSON, transaction bytes that don't decode), and a 409 when the answer is too large or fails a check (another network, a hash mismatch, an inconsistent tip). These 5xx bodies never carry the provider's validation `issues`. Their `error` is the generic `Unable to complete the request. Please retry.`, except for two 503s: a chain provider's error status returns `chain_unavailable` with `Chain lookup failed (<status>). Retry before signing.`, and a `MinerAuthenticationError` (the deployment's miner credential can't be read, the miner answers 401 or 403, or the credential is for another destination) returns `miner_unavailable` with that error's message, such as `Miner API credential is unavailable. Contact the service operator.`
- `input_not_found` (a vout past its transaction's outputs) is a 409, like the other `input_*` codes. Its body has its own message, not the generic one: retrying the same outpoint can't succeed.
- On `POST /api/vaults/:id/fund/submit`, `…/fund/resubmit` and `POST /api/jobs/:id/submit`, a provider failure's 502 or 503 isn't a refusal. An earlier attempt may have reached the miner, so treat the outcome as uncertain. Keep the signed bytes: resend a deposit only as those bytes, and check a withdrawal's status instead of submitting it again. The SDK and the webapp do this; the SDK counts only `submit_disabled` and the per-owner limit refusals as final.

Errors produced in front of the app have no `code`. That includes errors from the API gateway, for example on throttling or when the function fails or times out (these can be JSON with only a `message` field), other non-JSON proxy errors, and Hono's plain-text 404 for a route that doesn't exist.

[`server/api-errors.ts`](../server/api-errors.ts) is the source of truth. It exports `apiErrorCodes` (each code and its meaning), the `ApiErrorCode` type and the `API_ERROR_CODES` list. [`tests/api-errors.test.ts`](../tests/api-errors.test.ts) drives every code through `createApp`, checks that this table lists each one, and pins each error site's status, code and message in [`tests/api-error-sites.json`](../tests/api-error-sites.json), across `server/app.ts` and the server modules it imports.

| Area | Codes |
|---|---|
| Request | `invalid_request`, `request_too_large`, `network_mismatch` |
| Sign-in | `auth_required`, `session_expired`, `challenge_expired`, `signature_invalid` |
| API keys | `api_key_invalid`, `api_key_revoked`, `api_key_not_allowed`, `api_key_scope_denied`, `api_key_limit_reached`, `api_key_not_found`, `api_keys_disabled` |
| Switches | `operations_disabled`, `submit_disabled` |
| Idempotency | `idempotency_conflict`, `idempotency_in_progress` |
| Owner limits | `owner_not_allowlisted`, `owner_active_withdrawal_limit`, `owner_gpu_budget_reached`, `owner_limits_invalid` |
| Vaults and deposits | `vault_invalid`, `vault_not_found`, `vault_not_funded`, `vault_not_confirmed`, `funding_intent_exists`, `funding_transaction_invalid`, `signed_deposit_not_found` |
| Withdrawal jobs | `job_not_found`, `job_unsupported`, `job_state_invalid`, `withdrawal_invalid`, `solver_not_served`, `solved_result_unavailable`, `reconcile_required`, `operator_review_required` |
| Withdrawal submission | `intent_not_found`, `intent_conflict`, `exact_spend_mismatch`, `consensus_rejected`, `inclusion_check_failed` |
| Inputs | `input_not_found`, `input_mismatch`, `input_unconfirmed`, `input_spent` |
| Chain and miner | `chain_transaction_not_found`, `chain_unavailable`, `chain_error`, `miner_unavailable`, `miner_request_failed`, `miner_rate_unavailable` |
| Webhooks | `webhook_url_invalid`, `webhook_url_forbidden`, `webhook_url_unresolvable`, `webhook_limit_reached`, `webhook_not_found` |
| General | `state_conflict`, `internal_error` |

In the browser client and the SDK ([`sdk/`](../sdk/README.md)), a failed request throws `ApiRequestError` ([`src/lib/session.ts`](../src/lib/session.ts)). It carries the `status`, and the `code` when the body has one. A failure whose body isn't a JSON object has no code.

## Per-owner limits

Three deployment switches limit what one owner, the signed-in wallet address, can do. Each is off when unset or empty, which keeps the default behaviour. They only add refusals, and a refusal writes nothing and starts nothing. [`server/owner-limits.ts`](../server/owner-limits.ts) implements them; the [runbook](OPERATIONAL-RUNBOOK.md#per-owner-limits) covers operating them.

- **`QSB_OWNER_ALLOWLIST`** (Terraform `owner_allowlist`): only listed owners may register a vault, deposit (`/fund`, `/fund/submit`, `/fund/signed`, `/fund/resubmit`), create or resume a withdrawal, or register a webhook; others get 403 `owner_not_allowlisted`. The coordinator pauses other owners' withdrawals.
- **`QSB_OWNER_MAX_ACTIVE_JOBS`** (Terraform `owner_max_active_jobs`): the most withdrawals one owner may have queued or searching. Pausing frees a slot, and resume claims one again. Over the limit, `POST /api/jobs` and `POST /api/jobs/:id/resume` return 429 `owner_active_withdrawal_limit`.
- **`QSB_OWNER_MAX_GPU_SECONDS`** (Terraform `owner_max_gpu_seconds`): GPU seconds reserved across all of one owner's withdrawals. Once it can't cover another submission, `POST /api/jobs` returns 429 `owner_gpu_budget_reached`, and the coordinator pauses the withdrawal.

A malformed value, including a GPU budget smaller than one submission's reservation, refuses these routes with 503 `owner_limits_invalid`, and `GET /api/config` then reports `ownerLimits: null`. A creation or resume that races another for the last slot, or a creation that races for the last of the GPU budget, gets 409 `state_conflict` and writes nothing.

Sign-in, reads and pause stay open, and so does `POST /api/jobs/:id/submit`: it sends the owner's own solved withdrawal and uses no GPU. Replaying an `idempotencyKey` returns the existing job and takes no slot.

`GET /api/config` reports `ownerLimits`: `allowlist` (whether one is set), `allowlisted` (the caller's standing, from its session or API key, or `null` without either or without an allowlist), `maxActiveJobs` and `maxGpuSeconds`. It never returns the list.

## Stray payments

A vault takes exactly one deposit, its recorded `funding`. Someone can still pay the vault's script from outside the app. `GET /api/vaults/:id/funding` looks up the script's unspent outputs on the chain API (Esplora's `/scripthash/<scriptHash>/utxo`; a vault's `scriptHash` is the SHA-256 of its script, which is what Esplora indexes it by). It counts the confirmed outputs other than `funding`, and each time that count grows it records it on the vault row ([`server/stray-outputs.ts`](../server/stray-outputs.ts)):

- The response's `strayPayments`, and `GET /api/vaults`'s `strayPayments` (one per flagged vault), give `{ vaultId, count, sats, outputs }`. `count` and `sats` cover every such output; `outputs` lists the first 20 by when they were first seen, each as `{ txid, vout, value, firstSeenAt }`. Anyone can pay the script, so the record keeps a fixed size however many outputs arrive.
- A `deposit.stray_payment` event, with status `stray_payment`, goes to the owner's event log and webhooks.
- The API logs a `strayPayment` line for the operator, which raises the `<name>-stray-payments` alarm ([runbook](OPERATIONAL-RUNBOOK.md#stray-payments)).

A withdrawal never spends a stray output: `POST /api/jobs` accepts only the recorded `funding` as the vault input, and exact submission binds the transaction to it. The app offers no way to recover one. An unconfirmed payment is flagged once it confirms. A failed lookup returns the record already flagged (or `null`), changes nothing and doesn't fail the request.

The webapp calls this route on its own while it's open and on screen:
- A pending deposit is checked once a minute, once the tab has seen that deposit pending for five minutes, longer than a submission can run.
- Each funded or withdrawn vault is checked about once an hour, at most three a minute.
- A submitted withdrawal is checked with `GET /api/transactions/:id/status` once a minute.

In each browser, one tab per wallet does the checking, and none does while a transaction dialog is open. Other browsers and devices check on their own. This needs the browser's Web Locks API. Without it, the webapp checks only when the user presses "Check now", which every vault with a deposit has.

## Events and webhooks

Withdrawals take hours. Instead of polling each job, read your account's event log, and optionally register webhooks that tell you when to read it. `GET /events` and `GET /webhooks` take a wallet session or an API key with the `read` scope. Registering and deleting a webhook take a wallet session only: registration returns the signing secret and decides where your notifications go.

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
| `deposit.stray_payment` | A confirmed payment reached the vault's script outside its one deposit ([stray payments](#stray-payments)). |
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

Each delivery is a `POST` of one event as JSON (described under `webhooks` in [`openapi.json`](api/openapi.json)), with:

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

- Deliveries are sent right after the change that caused them, from the request or coordinator step that made it, within a budget of a few seconds (API) or two seconds (coordinator). When a step has no time left to send, its deliveries are still queued. An API request that has already taken about 28 seconds skips this work, so its response still beats API Gateway's 30-second timeout. A change it made outside a transaction can then be missing from the event log; the job and vault endpoints still show it. Retries and queued deliveries go out on later coordinator steps and later API calls for your account. Where the deployment runs the scheduled dispatcher, they also go out within about five minutes of falling due, even when your account is idle; without it, an idle account's deliveries wait for its next activity.
- After a failed attempt the webhook waits 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, then 4 h between tries. An event is dropped after 8 failed attempts, and a webhook that fails 8 times in a row is marked `failing` and gets no more deliveries: delete it and register it again.
- Up to 100 deliveries wait per account; past that the oldest are dropped.
- Deliveries can arrive out of order or more than once. Use `at`, `QSB-Event-Id` and the pull endpoint to reconcile.

## Idempotency-Key

These POSTs accept an optional `Idempotency-Key` header, 8 to 128 characters from `A-Z a-z 0-9 _ -`:

- `/vaults`
- `/vaults/:id/fund`
- `/vaults/:id/fund/submit`
- `/vaults/:id/fund/resubmit`
- `/jobs/:id/submit`
- `/jobs/:id/pause`
- `/jobs/:id/resume`

`POST /jobs` keeps the manifest's `idempotencyKey`, and its reuse for a different withdrawal is also `idempotency_conflict`. The stored manifest is the request with `funding.txid` and `helper.txid` lowercased, however the request spelled them; the response `manifest`, its `manifestHash` and the replay comparison all cover that stored form, so hash the lowercase manifest when comparing (the SDK sends lowercase already). Other routes ignore the header. That includes `POST /webhooks`: its response carries the webhook's signing secret, which is never stored for a replay, so a retried registration registers a second webhook. List and delete the extra one.

A key names one attempt. It belongs to one owner and one route, and for 24 hours it is bound to its first request's path and body. A retry with the same key gets:

- **the same request, after a 2xx that settled the outcome**, including a deposit MARA refused (`submission: "rejected"`): the stored status and body, with `Idempotency-Replayed: true`. The handler doesn't run.
- **the same request, while the first is still running**: 409 `idempotency_in_progress`, with `Retry-After`.
- **the same request, after an error or an `"uncertain"` outcome, or once the lease of a request that never finished runs out**: the handler runs again, as it would for a retry without the header.
- **a different path or body**: 409 `idempotency_conflict`.

A malformed key gets 400 `invalid_request`. Malformed JSON is a 4xx like any other: it isn't stored, and the key stays bound to that body. Without the header, nothing changes.

A replay is the first attempt's result, not the current state, and may be stale. Read current state from the GET routes. The bodies of `fund/resubmit`, `pause` and `resume` are empty, so a reused key always matches the first request. A new attempt, such as a resend after MARA dropped a deposit, a second pause or a second resume, needs a new key.

**Submit safety.** The layer can only skip the handler; it never sends anything itself. Nothing is stored as final for a 4xx, a 5xx, or a 2xx whose `submission` or `status` is `"uncertain"`. Each attempt leases the key for 150 seconds from its start, longer than the API Lambda can run. If it stops before its outcome is recorded, a retry after the lease reaches the handler, and the handler's own intent rules decide what happens: a deposit resend asks MARA first and sends only the stored bytes; a withdrawal with a stored intent is never resubmitted.

Records are rows `OWNER#<owner>` / `IDEMPOTENCY#<route>#<key>`, holding the request hash, a lease, the settled response and `expiresAt` (the table's TTL attribute).

## API keys

A BIP-322 wallet sign-in (`POST /api/auth/challenge`, then `/api/auth/verify`)
remains the root of identity. Its 1-hour session token can mint API keys that act
for the same owner address:

- `POST /api/api-keys` with `{ "name", "scopes", "expiresInDays"? }` returns
  `{ key, apiKey }`. The key is shown once. Only its SHA-256 is stored.
- `GET /api/api-keys` lists metadata: id, name, scopes, network, createdAt,
  expiresAt, revokedAt and status (`active`, `expired` or `revoked`).
- `POST /api/api-keys/:id/revoke` revokes the key at once.

Keys are off unless the deployment sets `api_keys_enabled = true` (Terraform),
which sets `QSB_API_KEYS_ENABLED=true` on the API Lambda only. Turning it on
needs the maintainer's explicit approval of third-party access, like the mainnet
switches. While it's off, minting and every well-formed key get 503
`api_keys_disabled`; sessions can still list and revoke keys. `GET /api/config`
reports `apiKeysEnabled`. A key acts for its owner, so the per-owner limits,
including the allowlist, apply to it as to the owner's session.

These three routes take a wallet session only. An API key cannot mint, list or
revoke keys. They don't take `Idempotency-Key`: its records keep the response
body, and a minted key must never be stored. If a mint's response is lost, mint
again and revoke the key you didn't receive.

Send a key as `X-Qsb-Authorization: Bearer qsb_mainnet_<43 base64url characters>` ([request headers](#request-headers)).
A bearer with any other prefix isn't a key, so the request is unauthenticated
(401 `auth_required`). Expiry is required: 30 days by default, 90 at most. An owner can have at most 10 active keys.

### Scopes

- `read`: every authenticated `GET` except `/api/api-keys`, plus `POST /api/payment-input` (a chain lookup that writes nothing).
- `vaults`: `POST /api/vaults`, `POST /api/vaults/:id/fund`, `/fund/submit`, `/fund/resubmit`.
- `withdrawals`: `POST /api/jobs`, `POST /api/jobs/:id/pause`, `/resume`.
- `submit`: `POST /api/jobs/:id/submit`.

`routeScopes` in `server/scoped-keys.ts` is the single table. A request needs
the scope of every route it matches. An authenticated route missing from the
table is refused for API keys, and a test fails until it is added. In the OpenAPI
document, each operation that takes a key has an `apiKey` security requirement
naming its scope, derived from the same table.

### Refusals

Key refusals use the API keys codes in the table above: unknown, expired and
revoked keys are 401, and so is a key whose stored record names another
network (`network_mismatch`),
session-only or unmapped routes and missing scopes are 403, the active-key cap
is 409, revoking an unknown key is 404, and keys switched off are 503.
