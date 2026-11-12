# Public PQB serving validation

This bounded operational assessment invokes the actual coordinator bundle through
its Step Functions state machine and AWS Batch transport. It uses only the
committed, never-funded public synthetic fixture. It creates no API, wallet,
credential, funded output, miner request or transaction submission path. The
production app's release, functions, table, queue settings and switches stay under
their ordinary reviewed deployment process.

`fixture.ts prepare EXTERNAL_DIRECTORY` derives the public vault locally and
writes only public vault/job rows and a public workflow event with fresh identifiers. It never writes the
fixture seed to its output. A native audit requires every successful Batch job’s immutable input, completed
output, A10G/driver and process-isolation startup logs. It re-derives all stage
packets from the public intent and CPU-checked predecessor hits, then rechecks every
emitted candidate, including superseded work.
`fixture.ts verify EXTERNAL_DIRECTORY` projects the
final coordinator result and rechecks all three full hits with the CPU reference.
No test verifier verdict or grinder transcript is substituted for native work.

Before cloud execution, record the clean pushed source, build manifest and bundle
hashes, exact published descriptor and original build attestation, matching ECR
index/platform digests, current Batch policy and zero active-work baseline. Keep
all configuration and original receipts outside Git. Preserve old descriptors and
the production deployment manifest for rollback. Enrollment and this assessment
do not select PQB on the production deployment.

Use two isolated fixture tables and a dedicated coordinator/workflow with bounded
runtime roles. The runtime has no miner secret or exact-submit API. The first
execution has a 900 GPU-second owner allowance: one ordinary complete work unit
through the real transport, accounting and CPU path. Require its completed result,
correct driver/image identities and terminal execution before the full execution.
The second execution uses the other fresh table, the same coordinator binary,
image and partition contract, and a separately recorded allowance. The first
reservation is retained in campaign accounting. Neither execution is resumed or
replayed after an unknown submission.

Set one absolute campaign deadline before resource creation; never extend it.
An independently scheduled `deadline.py` invocation pauses only the two public
fixture jobs and terminates only jobs belonging to the campaign's exact Batch
job-definition revision. It leaves the shared production queue and compute
configuration intact. The ordinary Batch 900-second running timeout and deployed
30-minute queue/startup watchdog remain in force. The schedule is armed at the recorded deadline and read back before any workflow
start. The complete function configuration, runtime roles, trust and inline policies
are checked before each start, including after changing to the solve table.
[Scheduler has 60-second precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html);
retain actual invocation and drain times separately from the deadline. A timeout, unexpectedly failed/incomplete unit, unknown intent or
CPU mismatch stops the assessment for collection and reconciliation. Superseded
units may be cancelled and never receive completion credit; it is not retried automatically.

Retain both workflow histories, every revision-specific Batch job description,
public input/output S3 objects and hashes, native startup/result logs, assigned
ranges, durable reservations, CPU decisions and all allocated instance/volume
identities. Report cold startup and solve wall time separately from measured GPU
runtime. This is one public synthetic solve, not a performance distribution,
complete-domain proof, actual user withdrawal, Core acceptance or miner inclusion.
A solved synthetic spend may subsequently be checked offline without broadcasting.

On success or failure, pause both fixture jobs, drain/cancel only campaign work,
collect receipts and stop the dedicated workflow executions. Delete the dedicated
functions, schedules, tables, runtime roles and inactive definition after retaining
evidence. Verify zero campaign jobs, terminated campaign-used hosts and deleted
recorded volumes (or explain any independently verified host shared with unrelated
work). Never terminate a production host or delete shared resources. Release the
campaign's operational reservation only after independently verified cleanup;
estimated compute and reserved budget are not provider billing.

## Operator sequence

Use a fresh directory outside every checkout. Its `operator.json` contains only
`profile`, `account` and `region` (`eu-west-2`), never credentials. The connected AWS
MCP session should be used when it targets the deployment account; the explicit
local profile is the SDK fallback when that connector is bound to another account.
Provisioning mutations use the SDK with one attempt and retain an exclusive intent
before dispatch. Explicit stop requests retain their intent before the conditional
pause and revision-scoped drain; the independent scheduled drain is logged in CloudWatch. A missing response or prior failure requires reconciliation, not replay.

From a clean pushed checkout with locked dependencies installed:

```sh
QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/fixture.ts prepare "$EVIDENCE"
python3 ops/pqb-serving/control.py inspect "$EVIDENCE"
release_id=$(node -p 'require("./src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json").id')
node terraform/scripts/build.mjs --network=mainnet --solver-release="$release_id"
python3 ops/pqb-serving/control.py prepare "$EVIDENCE"
python3 ops/pqb-serving/control.py mirror "$EVIDENCE"
python3 ops/pqb-serving/control.py deploy "$EVIDENCE"
python3 ops/pqb-serving/control.py start "$EVIDENCE" --phase preflight
python3 ops/pqb-serving/control.py collect "$EVIDENCE"
# Only after the one-unit preflight is recorded as passed:
python3 ops/pqb-serving/control.py start "$EVIDENCE" --phase solve
python3 ops/pqb-serving/control.py collect "$EVIDENCE"
# Only after the real coordinator publishes awaiting_authorization:
QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/fixture.ts verify "$EVIDENCE"
```

Call `collect` regularly during each execution; it retains snapshots rather than
rewriting originals. The whole campaign reserves $200 operationally, has a fixed
four-hour deadline, permits at most 900 + 540,000 reserved GPU-seconds across the
two public jobs, and uses the existing fleet's 16-GPU cap. This is an assessment
reservation, not a guaranteed billing limit. Current regional pricing must be
recorded independently before preparing a new campaign.

`stop` pauses the two public fixture rows and drains only the test revision.
Run `final_collect` after work is terminal. It retains both fixture tables,
complete workflow event histories, native artifacts and resource configuration,
then seals their byte hashes. `remove` requires that receipt, checks that live work
and fixture rows have not changed, and removes only positively collected dedicated
resources and fixture objects. Failed/partial deployments use the same final
collection path; missing mutation responses must first be reconciled separately,
without relabeling a read-back as the original response. Never delete evidence to
get past an uncertain operation. Retain the verified ECR artifact for the reviewed adoption
handoff. Save an independent cleanup reconciliation after removal: all dedicated
resources absent, all campaign work terminal, recorded volumes deleted and the
shared fleet idle. Only that reconciliation closes the budget reservation.

Local checks (no AWS calls):

```sh
npm run typecheck
python3 -m unittest discover -s ops/pqb-serving -p 'test_*.py' -v
```

## Offline solved-spend component check

After the actual solve, run
`QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/consensus.ts "$EVIDENCE"`.
It uses only the committed public test seed and nonexistent outpoints, checks the
three full solutions again during real witness/co-signature assembly, and invokes
the exact packaged Bitcoin Core 27.2 interpreter/library in network-disabled,
read-only containers. It requires one accepted PQB spend and rejection of twelve
transaction/witness mutations, retaining binary, library and container identities.
The helper previous output is deliberately OP_TRUE: this tests the solved PQB
script, not a wallet signature, chain/UTXO acceptance, miner policy or broadcast.
Legacy signatures do not commit previous-output amounts; the production chain and
exact-spend checks retain that responsibility. No wallet material is accepted.

The current-status collector pauses and drains the campaign immediately when it observes an unexpected failed unit or incomplete native output. Successful qualification separately requires provider-declared coordinator cancellation and an earlier CPU-verified winner for the same packet for every superseded failed job.
