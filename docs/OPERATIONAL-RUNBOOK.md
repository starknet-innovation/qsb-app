# Operational runbook

**This document defines procedures. It is not an activation decision, a deployment, or permission to spend.**

Publishing research source is not deployment or activation. Feature enablement is not authorization to spend. `release.mainnetEnabled` stays false. `broadcastAuthorized` is not set. No step below starts a worker, contacts a provider, or broadcasts a transaction.

The checked-in capability limit is `providerGpuLimit: 1` in `server/mainnet-capability.json`. Until a later reviewed decision changes that file, the concurrency cap is one concurrent search and one GPU worker. The minimum idle worker count is zero. This is not a measured production capacity plan.

## Concurrency and cost caps

- `maxConcurrentSearches`: 1
- `maxGpuWorkers`: 1
- `minIdleWorkers`: 0
- The coordinator path uses `server/gpu-spend.json`: `workersMax` 1, `workersMin` 0, `executionTimeoutMs` 900000, and `maxJobAttempts` 32768 (lifetime submissions, including retries and all stages). A 64-hit output is not credited as a finished range. These checks do not start a worker, evaluate the USD ceiling, or authorize a spend.
- `costUnit` is `operator-units`. `maxCostUnits` is a positive integer of those units. The operator cost field is not the experimental USD ceiling. A plan that labels the field as USD, or that supplies `vaultUsd`, `feeUsd`, or `gpuUsd` on the runbook, is refused with `CostFieldIsNotUsdCeiling`.
- The experimental USD limits are vault 10000, fee 1000, and GPU 1000. They are encoded only in `assertExperimentalUsdLimits`. That check cannot run while `release.mainnetEnabled` and `broadcastAuthorized` are false: it throws `UsdLimitCheckClosed` and does not compare amounts. It does not read `maxCostUnits`, approve activation, or authorize a spend.
- A missing or zero operator cost ceiling is refused. A plan above the concurrency cap is refused. `acceptOperationalRunbook` does not provision workers. `executed`, `provisioned`, and `usdLimitsEvaluated` stay false. `costFieldIsUsdCeiling` stays false.

## Deadlines

Every plan has a deadline later than the operator-supplied clock reading. When the deadline passes, stop new submissions and reconcile anything already paid or possibly paid. Do not start a replacement paid job to "finish" the deadline.

## Cleanup

The cleanup watchdog is a different identity from the worker. The worker is not its own watchdog. A cleanup failure raises the `cleanup-failure` alert and does not submit the job again.

## Alerts

The plan names all of these alerts: `cost-cap`, `deadline`, `uncertain-paid-outcome`, `cleanup-failure`, and `activation-attempt`. An activation attempt is an alert, not an approval.

## Incident handling

1. Stop new work.
2. Preserve unknown paid outcomes for reconciliation rather than retrying blindly.
3. Do not enable mainnet or authorize a spend as part of incident response.
4. Keep the backup, passphrase, and runtime credentials out of the incident record. Record public identifiers only.

## Safe stop and rollback

Stop new submissions. Loss of a local process is not proof that remote GPU work stopped. Do not clear an unknown provider result by submitting it again.

Rollback cannot revive legacy writers, release consumed commitments, or duplicate paid work. Rollback does not authorize a spend and does not set `release.mainnetEnabled` or `broadcastAuthorized`.

## Unknown paid outcomes

Treat `unknown`, `timeout`, and `http-ambiguous` as unpaid-or-paid until a provider or invoice record says which. The only action is reconcile. `reconcilePaidOutcome` returns `retry: false`. Requesting retry throws `BlindRetryRefused`. A known success is recorded once and is not submitted again.

## Commit before deploy

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

Local builds and source flags are not live-configuration evidence. A clean pushed commit is necessary and is not itself a deployment. Record the source-manifest sha256, the configuration hash, and, once an image exists, the image config digest, the OCI index digest, and the registry manifest digest as separate `sha256:` values. Do not relabel a source hash as an image digest.

## Spend authorization

Every proposed mainnet spend requires a separate exact-transaction authorization. The activation decision does not carry the transaction id, amount, or fee, and it does not set `broadcastAuthorized`. An exact spend record is still not a broadcast. This checkout grants neither.

### Coordinator attempt allowance

`server/gpu-spend.json` is the bundled source of truth. Its schema accepts positive
integer submission caps up to 1,000,000; changing a value requires the normal
review/build/deploy process, not four matching literals. The default is 32,768
lifetime submissions. Stage-local `attempt` is a range index, not the spend counter:
stage transitions reset that index but never reset `gpuSubmissions`.

This is a conservative allowance, not a measured expected search time. Exact
range arithmetic gives ceil(C(150,9) / 2^34) = 4,829 ranges per subset round;
two complete rounds consume 9,658 submissions, leaving 23,110 for pinning/retries.
The upstream ~2^47 honest-work comment corresponds to about 8,192 subset-sized
units but is a theoretical estimate, not performance or success evidence. The
32,768 default supplies four times that estimate; hard instances can still stop.
The cap cannot promise a hit or support claims about withdrawal price. At the
900-second timeout, the execution allowance alone is at most 8,192 worker-hours;
startup, idle time, storage and provider retries/billing are not an invoice cap.
No paid run is authorized by changing this configuration.

Before a paid claim, endpoint-limit failures pause with `Runpod limits unconfirmed;
nothing was submitted` and leave the lifetime count unchanged. Fix the endpoint
permission/configuration, then resume normally. A failure after the paid POST
boundary remains an unknown submission and must be reconciled, never retried
blindly. The 90-second coordinator timeout budgets the CPU export (25 seconds),
endpoint check (20 seconds), paid POST (20 seconds), and persistence overhead;
it reduces timeout exposure but does not make a POST and database write atomic.
