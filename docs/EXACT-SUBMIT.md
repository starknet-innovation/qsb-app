# Exact mainnet withdrawal submission (#20)

This implements the coordinator withdrawal submit path. It does not enable mainnet,
deploy, fund a fixture, start a search or broadcast a transaction. The first live
submit remains #22, requiring approval of the exact transaction, amount and fee.

## One switch, one attempt

The trusted server switch is QSB_EXACT_SUBMIT_ENABLED=true on mainnet. Terraform
exposes exact_submit_enabled, default false; examples and deployed-source flags
remain disabled. This switch controls only submission of an already solved and
signed coordinator withdrawal, independently of the old disabled rehearsal
permit. It does not turn on vault creation, job admission or the parked supervised
pipeline. Do not activate it in a shared service before the #22 review.

The authenticated POST /api/jobs/:id/submit accepts only rawTxHex. It loads the
owner's stored job and vault, checks the #19 exact-spend binding (including the
single destination, amount, fee, inputs, sequence, locktime and helper
SIGHASH_ALL), requires awaiting_authorization and checks both inputs are confirmed
and unspent. Core then verifies every input against real chain output scripts and
amounts. A request cannot provide its own verdict or spend record.

Before any miner request, one atomic transaction creates OWNER#/TX#txid and moves
the job to submitted with that txid, conditional on the job and vault versions.
The durable intent stores exact bytes, their hash (including witness), and the
manifest. The initial outcome is uncertain. A process-local single-use permit
then allows exactly one POST to https://slipstream.mara.com/api/transactions with
{tx_hex: rawTxHex}. No policy preflight POST is required: Core checks consensus,
and the miner decides relay/mining policy. Redirects and automatic HTTP retries
are disabled. The response must name the expected txid.

A duplicate request returns the saved outcome without a second POST. Concurrent
callers cannot both win the intent transaction. A different witness for the same
txid, or a different transaction for a job with an intent, is refused. Timeout,
HTTP error, malformed response, crash or failure to persist a response cannot
authorize another submission. The intent and outpoint reservations remain.
Even a crash after the intent but before POST requires operator reconciliation;
availability is deliberately secondary to avoiding a second submission.

## Native verification

See [consensus build and rules](../consensus/README.md). The deployment build
packages the Core 27.2 consensus library and a thin arm64 native wrapper into the
API Lambda. It runs signed mutation tests in a network-disabled Linux container
before packaging. Missing or failing binaries refuse the transaction before any
intent or miner call. No node or private wallet material is used by the wrapper.

This is script-consensus verification with the activated flags, not a block
validator or relay-policy checker. Exact-spend validation supplies the bounded
two-input/one-output layout, balanced amounts and fee, and the QSB locktime range;
chain reads supply confirmed unspent outputs. Core must be reassessed if another
script soft fork activates.

## Inclusion and limitations

Both transaction and job status routes require the original durable intent.
For new exact-withdrawal intents they query the vault funding outpoint's spender,
fetch and hash-check its raw transaction, require both expected inputs and the
single manifest output/value/fee, then check its canonical block status. A valid
scriptSig re-encoding may change the txid: includedTxid reports that spender
while the original intent and job txid remain unchanged. Miner-reported success
alone never confirms inclusion.

An Esplora response is chain-provider evidence, not an independently operated
full-node proof. Reorganizations or missing data remain unconfirmed. This PR
does not claim miner acceptance or a live withdrawal.

The direct miner transport follows the official
[MARA OpenAPI](https://slipstream.mara.com/docs/openapi.json), read 25 September 2026.
Runtime authorization, if configured, remains confined to the exact MARA origin;
no operator credentials were retrieved in implementation or testing.

## Operator recovery without another POST

For an `uncertain` intent, preserve the original signed bytes and both outpoint
reservations. **Keep the helper UTXO unspent**: spending it elsewhere makes this
withdrawal unable to confirm. Do not ask the user to sign a replacement or reuse
one-time material.

First inspect `GET /api/transactions/:originalTxid/status`. An unspent funding
outpoint is not proof that the miner accepted a POST. The response remains
`uncertain` unless the intent recorded acknowledgement. A funding spend with
unexpected inputs/outputs is an alert requiring investigation, not a successful
withdrawal.

An authorized operator can persist the same observation and an audit reference:

```sh
QSB_NETWORK=mainnet TABLE_NAME=your-records-table AWS_REGION=eu-west-1 \
  npx tsx scripts/reconcile-withdrawal.ts OWNER JOB \
    --operator OPERATOR --evidence audit://incident/reference
```

Use the approved scoped reconciliation-role session described in the operational
runbook. This CLI requires the persistent table and mainnet configuration before
importing clients. It loads `JOB#` → original `TX#`, checks owner/job identity,
exact signed-byte hash and stored spend binding, then observes the funding
outpoint and original miner txid using the same status logic as the API. It saves
the observation conditionally against both intent and job versions. It never
posts a transaction, changes the original bytes/txid, starts work, or releases
reservations. An alternate valid mined txid is recorded separately. An alert
produces a nonzero exit code. Failed reads or concurrent changes must be
investigated and the read-only observation rerun; they cannot authorize a POST.

Even when the funding is unspent and the miner reports no transaction, this tool
**does not re-POST**. Another POST would need new explicit user approval and a
separate reviewed operation; neither a network error nor an operator evidence
string is that approval. Definite miner rejections currently retain the same
conservative uncertain state. An expired or spent helper is a re-authorization
problem under #8, not permission to accept a different transaction.

Pre-submit input checks now fetch the two independent input observations in
parallel, preserving all amount/script/unspent/confirmation checks and ordered
Core spent-output data. Timeout reductions do not remove the crash boundary
between creating the intent, POSTing and recording its result.

If a later observation no longer confirms a previously confirmed intent, operator
reconciliation downgrades the job to submitted and clears its current inclusion
identifier while retaining the original txid, signed bytes and reservations.
It never substitutes another transaction. A successful POST acknowledgement is
merged through conditional database-write races; those retries repeat only the
database write, never the POST.

The API Lambda timeout is 120 seconds to budget chain reads, the bounded native
check and the miner POST. The API Gateway integration remains 30 seconds: a
browser timeout can therefore occur while Lambda continues. That timeout is an
unknown outcome, not permission to submit again. Inspect the retained transaction
status or use the reconciliation CLI; never clear its intent to make a retry.

Chain-provider failures preserve the last recorded conflict or confirmation and its evidence; only the last-check time advances. A successful chain observation can downgrade that state after a reorg or an absent/unconfirmed spender. An unavailable provider is never reorg evidence.

The deployment must also set `mainnet_enabled=true` (`QSB_MAINNET_ENABLED="true"`). Both switches are required at the API and final provider boundary. See [the switch matrix](OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches); both defaults remain false.
