# Exact mainnet withdrawal submission

How a solved, signed withdrawal reaches the miner (#20): one checked transaction, one POST, and no second submission whatever happens after it. Operator recovery is in the [runbook](OPERATIONAL-RUNBOOK.md#reconcile-an-uncertain-withdrawal-tx).

## One switch, one attempt

Submission needs `QSB_EXACT_SUBMIT_ENABLED="true"` as well as `QSB_MAINNET_ENABLED="true"`, at the API and at the final miner boundary (Terraform `exact_submit_enabled` and `mainnet_enabled`, both `false` by default; see the [switch matrix](OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)). The submit switch gates every miner submission: this withdrawal route, and the deposit relay (`POST /api/vaults/:id/fund/submit`, `/fund/resubmit`, and the manual-export bytes from `GET /fund/signed`). The Slipstream POST checks both switches again. It doesn't turn on vault creation or job admission.

The authenticated `POST /api/jobs/:id/submit` accepts only `rawTxHex`. It loads the owner's stored job and vault, checks the #19 exact-spend binding (the single destination, amount, fee, inputs, sequence, locktime and helper SIGHASH_ALL), requires `awaiting_authorization`, and checks that both inputs are confirmed and unspent. Core then verifies every input against the real chain output scripts and amounts. A request can't provide its own verdict or spend record. The two input observations are fetched in parallel; every amount, script, unspent and confirmation check still applies, in Core's spent-output order.

Before any miner request, the miner credential, if one is configured, is read; a failure refuses the request with nothing written. Then one atomic transaction creates `OWNER#`/`TX#<txid>` and moves the job to `submitted` with that txid, conditional on the job and vault versions. The durable intent stores the exact bytes, their hash (including witness) and the manifest, and its initial outcome is `uncertain`. A process-local single-use permit then allows exactly one POST to `https://slipstream.mara.com/api/transactions` with `{tx_hex: rawTxHex}`, plus `client_code` when the credential holds MARA's client code, reusing the credential already read. There is no policy preflight: Core checks consensus, and the miner decides relay and mining policy. Redirects and automatic HTTP retries are disabled. The response must name the expected txid. A successful POST acknowledgement is merged through conditional database-write races; those retries repeat only the database write, never the POST.

A duplicate request returns the saved outcome without a second POST. Concurrent callers can't both win the intent transaction. A different witness for the same txid, or a different transaction for a job with an intent, is refused. A timeout, HTTP error, malformed response, crash, or failure to persist a response can't authorize another submission: the intent and the outpoint reservations remain. Even a crash after the intent but before the POST needs operator reconciliation. Availability is deliberately secondary to avoiding a second submission. Definite miner rejections currently keep the same conservative `uncertain` state.

The API Lambda timeout is 120 seconds, to budget the chain reads, the bounded native check and the miner POST. CloudFront's origin response timeout stays 30 seconds, so a browser can time out while Lambda continues. That timeout is an unknown outcome, not permission to submit again.

## Native verification

See [consensus build and rules](../consensus/README.md). The deployment build packages the Core 27.2 consensus library and a thin arm64 native wrapper into the API Lambda, after running signed mutation tests in a network-disabled Linux container. Missing or failing binaries refuse the transaction before any intent or miner call. The wrapper uses no node and no wallet material.

This is script-consensus verification with the activated flags, not a block validator or relay-policy checker. The exact-spend check supplies the bounded two-input, one-output layout, balanced amounts and fee, and the QSB locktime range; chain reads supply confirmed unspent outputs. Core must be reassessed if another script soft fork activates.

## Inclusion

Both the transaction and job status routes require the original durable intent. They query the vault funding outpoint's spender, fetch and hash-check its raw transaction, require both expected inputs and the single manifest output, value and fee, then check its canonical block status. A valid scriptSig re-encoding may change the txid: `includedTxid` reports that spender while the original intent and job txid stay unchanged. Miner-reported success alone never confirms inclusion.

An Esplora response is chain-provider evidence, not an independently operated full-node proof. Reorganizations or missing data stay unconfirmed. Chain-provider failures keep the last recorded conflict or confirmation and its evidence; only the last-check time advances. A successful observation can downgrade that state after a reorg or an absent or unconfirmed spender. An unavailable provider is never reorg evidence.

## Miner transport

The transport follows [MARA's OpenAPI](https://slipstream.mara.com/docs/openapi.json). Runtime authorization, if configured, stays confined to the exact MARA origin. The optional credential is the administrator-created `qsb/slipstream` secret: at runtime only the API function can read it, with the credentials Lambda issues to it, but anyone who can deploy runtime code can too. See "MARA Slipstream credential" in [`terraform/README.md`](../terraform/README.md#mara-slipstream-credential).
