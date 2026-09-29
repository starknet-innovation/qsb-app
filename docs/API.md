# QSB API

The server is a JSON HTTP API (`server/app.ts`). It is non-custodial: keys,
passphrases and one-time material never reach it (#85).

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
reports `apiKeysEnabled`. Once the owner allowlist (#89) lands, it can also limit
who uses keys.

These three routes take a wallet session only. An API key cannot mint, list or
revoke keys.

Send a key as `Authorization: Bearer qsb_<network>_<43 base64url characters>`.
It works only on the network in its prefix. Expiry is required: 30 days by
default, 90 at most. An owner can have at most 10 active keys.

### Scopes

| Scope | Routes |
|---|---|
| `read` | Every authenticated `GET` except `/api/api-keys`, plus `POST /api/payment-input` (a chain lookup that writes nothing) |
| `vaults` | `POST /api/vaults`, `POST /api/vaults/:id/fund`, `/fund/submit`, `/fund/resubmit` |
| `withdrawals` | `POST /api/jobs`, `POST /api/jobs/:id/pause`, `/resume` |
| `submit` | `POST /api/jobs/:id/submit` |

`routeScopes` in `server/scoped-keys.ts` is the single table. A request needs
the scope of every route it matches. An authenticated route missing from the
table is refused for API keys, and a test fails until it is added.

### Errors

Refusals carry a `code`: `api_key_invalid` (unknown or expired),
`api_key_revoked`, `network_mismatch` (all 401), `api_key_not_allowed`
(session-only or unmapped route), `api_key_scope_denied` (both 403),
`api_key_limit_reached` (409), `api_key_not_found` (404, on revoke) and
`api_keys_disabled` (503, while keys are off).
