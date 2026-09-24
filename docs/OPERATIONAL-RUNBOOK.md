# Operational runbook

**This document defines procedures. It is not an activation decision, a deployment, or permission to spend.**

Publishing research source is not deployment or activation. Feature enablement is not authorization to spend. `release.mainnetEnabled` stays false. `broadcastAuthorized` is not set. No step below starts a worker, contacts a provider, or broadcasts a transaction.

The checked-in capability limit is `providerGpuLimit: 1` in `server/mainnet-capability.json`. Until a later reviewed decision changes that file, the concurrency cap is one concurrent search and one GPU worker. The minimum idle worker count is zero. This is not a measured production capacity plan.

## Concurrency and cost caps

- `maxConcurrentSearches`: 1
- `maxGpuWorkers`: 1
- `minIdleWorkers`: 0
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

## Reconcile an unknown Runpod submission

The coordinator pauses a job when a billable submission's outcome is unknown (`Submission outcome unknown. Reconcile Runpod before resuming.`). Leave the job paused. Do not resume it, and do not submit it again, until Runpod has been checked.

From a checkout of this repository, pass the job's owner and id:

```
npx tsx scripts/reconcile-submission.ts <owner> <job-id>
```

The command loads that job, lists the endpoint's current Runpod requests with GET `/requests`, and reads each request with GET `/status`. It logs every action to stderr as one JSON object per line. A log line contains the job id, owner, and provider ids only. It does not contain credentials, parameter payloads, or wallet material.

The command records one of two outcomes. It never calls Runpod `/run`, never resumes the job by itself, and never broadcasts:

- One listed request matches this job's manifest hash, stage, attempt, solver identity, and parameter hash. The command stores that provider id and returns the job to `searching` so polling can read that id. Polling uses `/status`. While `release.mainnetEnabled` is false, the command does not start the coordinator, because that pass would fail the job. Re-run the command after transactions are enabled for the owner to start polling. A re-run reads the stored provider id even when the request list no longer includes it, and it does not submit.
- No listed request matches. The command records not submitted and sets `oneSubmissionAllowed`. That flag allows exactly one later `POST /api/jobs/:id/resume` to queue this range. The command does not call resume and does not start a workflow. Running it again, while Runpod still has no match, leaves the same single allowance. It does not grant a second submission.

If more than one request matches, or a listed request cannot be read, the command records neither outcome and does not submit. Resume stays refused until a later successful reconciliation. The request list omits jobs Runpod has already dropped. A not-submitted record means none of the requests still listed matched.

This command does not set `release.mainnetEnabled` or `broadcastAuthorized`.

## Commit before deploy

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

Local builds and source flags are not live-configuration evidence. A clean pushed commit is necessary and is not itself a deployment. Record the source-manifest sha256, the configuration hash, and, once an image exists, the image config digest, the OCI index digest, and the registry manifest digest as separate `sha256:` values. Do not relabel a source hash as an image digest.

## Spend authorization

Every proposed mainnet spend requires a separate exact-transaction authorization. The activation decision does not carry the transaction id, amount, or fee, and it does not set `broadcastAuthorized`. An exact spend record is still not a broadcast. This checkout grants neither.
