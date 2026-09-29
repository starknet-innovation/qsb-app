# API

The server is a JSON HTTP API under `/api`: `createApp` in [`server/app.ts`](../server/app.ts), served on Lambda by [`server/lambda.ts`](../server/lambda.ts).

## Per-owner limits

Three deployment switches limit what one owner, the signed-in wallet address, can do. Each is off when unset or empty, which keeps the default behaviour. They only add refusals, and a refusal writes nothing and starts nothing. [`server/owner-limits.ts`](../server/owner-limits.ts) implements them; the [runbook](OPERATIONAL-RUNBOOK.md#per-owner-limits) covers operating them.

| Environment (Terraform variable) | When set | Refusal |
|---|---|---|
| `QSB_OWNER_ALLOWLIST` (`owner_allowlist`) | Only listed owners may register a vault, deposit (`/fund`, `/fund/submit`, `/fund/signed`, `/fund/resubmit`), or create or resume a withdrawal. The coordinator pauses other owners' withdrawals. | 403 `owner_not_allowlisted` |
| `QSB_OWNER_MAX_ACTIVE_JOBS` (`owner_max_active_jobs`) | Most withdrawals one owner may have queued, searching or paused. | 429 `owner_active_withdrawal_limit` from `POST /api/jobs` |
| `QSB_OWNER_MAX_GPU_SECONDS` (`owner_max_gpu_seconds`) | GPU seconds reserved across all of one owner's withdrawals. | 429 `owner_gpu_budget_reached` from `POST /api/jobs`; the coordinator pauses the withdrawal |

A malformed value, including a GPU budget smaller than one submission's reservation, refuses these routes with 503 `owner_limits_invalid`, and `GET /api/config` then reports `ownerLimits: null`. A creation that races another withdrawal for the last slot or the last of the GPU budget gets the usual 409 and writes nothing.

Sign-in, reads and pause stay open, and so does `POST /api/jobs/:id/submit`: it sends the owner's own solved withdrawal and uses no GPU. Replaying an `idempotencyKey` returns the existing job and takes no slot.

`GET /api/config` reports `ownerLimits`: `allowlist` (whether one is set), `allowlisted` (the signed-in caller's standing, or `null` without a session or an allowlist), `maxActiveJobs` and `maxGpuSeconds`. It never returns the list.
