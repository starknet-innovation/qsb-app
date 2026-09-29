# API

The server is a JSON HTTP API (`server/app.ts`). It is non-custodial: keys, passphrases and one-time material stay on the caller's side (#85).

## Prefixes

- `/v1` is the stable prefix for integrators.
- `/api` stays for the webapp. It serves the same routes.

Both prefixes reach the same handlers and middleware: secure headers, CORS, the body limit, sign-in and error mapping. `createApp` rewrites a leading `/v1` segment to `/api` before routing, so a route is defined once. CloudFront forwards `/v1/*` and `/api/*` to the API with the same uncached behaviour (`terraform/web.tf`).

## Idempotency-Key

These POSTs accept an optional `Idempotency-Key` header, 8 to 128 characters from `A-Z a-z 0-9 _ -`:

- `/vaults`
- `/vaults/:id/fund`
- `/vaults/:id/fund/submit`
- `/vaults/:id/fund/resubmit`
- `/jobs/:id/submit`
- `/jobs/:id/pause`
- `/jobs/:id/resume`

`POST /jobs` keeps the manifest's `idempotencyKey`. Other routes ignore the header.

A key belongs to one owner and one route. For 24 hours it is bound to its first request's path and body:

| Retry with the same key | Result |
|---|---|
| Same request, after a 2xx that settled the outcome | The stored status and body, with `Idempotency-Replayed: true`. The handler doesn't run. |
| Same request, while the first is still running | 409 `idempotency_in_progress`, with `Retry-After`. |
| Same request, after an error or an `"uncertain"` outcome, or once the lease of a request that never finished runs out | The handler runs again, as it would for a retry without the header. |
| Different path or body | 409 `idempotency_conflict`. |

A malformed key gets 400 `invalid_request`. Without the header, nothing changes.

**Submit safety.** The layer can only skip the handler; it never sends anything itself. Nothing is stored as final for a 4xx, a 5xx, or a 2xx whose `submission` or `status` is `"uncertain"`. Each attempt leases the key for 150 seconds from its start, longer than the API Lambda can run. If it stops before its outcome is recorded, a retry after the lease reaches the handler, and the handler's own intent rules decide what happens: a deposit resend asks MARA first and sends only the stored bytes; a withdrawal with a stored intent is never resubmitted.

Records are rows `OWNER#<owner>` / `IDEMPOTENCY#<route>#<key>`, holding the request hash, a lease, the settled response and `expiresAt` (the table's TTL attribute).
