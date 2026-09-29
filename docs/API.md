# QSB API

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
| `deposit.dropped` | The miner refused the deposit and doesn't have it; the vault is unfunded again. |

An event is thin: identifiers and statuses, never transaction bytes, scripts or anything secret.

```json
{ "id": "evt_…", "type": "withdrawal.awaiting_authorization", "subjectId": "<job id>", "status": "awaiting_authorization", "stage": "verification", "at": "2026-09-29T12:00:00.000Z" }
```

`subjectId` is the job id for `withdrawal.*` and the vault id for `deposit.*`. `stage` is on withdrawal events only. Read details from `GET /api/jobs/:id/status` or `GET /api/vaults`.

### Pull: `GET /api/events?after=<cursor>&limit=<1-100>`

Returns `{ events, next, hasMore }`, oldest first. Keep `next` and pass it as `after` on the next call; without `after` you get everything retained. Events are kept for 30 days, and are listed once they are 10 seconds old, so a write still in flight can't land behind your cursor. The log is the record: a webhook only tells you to read it.

### Webhooks

- `POST /api/webhooks` with `{ "url": "https://…", "events": ["withdrawal.awaiting_authorization"] }` (omit `events` for all types) returns `{ webhook, secret }`. **The secret is shown only in this response.** At most 5 per account.
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

Answer with any 2xx within 3 seconds; the response body is ignored.

### Delivery and retries

At least once, best effort; **the pull endpoint is authoritative**.

- Deliveries are sent right after the change that caused them, from the request or coordinator step that made it, within a few seconds' budget. Retries go out on later coordinator steps and later API calls for your account, so an idle account's retries wait for its next activity.
- After a failed attempt the webhook waits 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, then 4 h between tries. An event is dropped after 8 failed attempts, and a webhook that fails 8 times in a row is marked `failing` and gets no more deliveries: delete it and register it again.
- Up to 100 deliveries wait per account; past that the oldest are dropped.
- Deliveries can arrive out of order or more than once. Use `at`, `QSB-Event-Id` and the pull endpoint to reconcile.
