# Deployed PQB public search qualification

The selected production workflow at app source
`3a29b0d8e62fbaee1b507356b1ea3c7edd9c456a` completed the committed public
synthetic problem through its actual Step Functions coordinator, CPU reference,
permanent Batch revision 12 and S3 transport. Controller and offline-checker source
is `0dd98e99f61c67f7a9a5f0df273bc0f1dd339ef7`. This qualifies the normal London
`g5.xlarge`/`BEST_FIT`, zero-minimum, 64-vCPU pool with sixteen workers and the
enrolled `pqb-ranked-v2-cfd99e384469-edce7a14b554` image. No serving configuration,
image publication or enrollment changed during this assessment.

All 146 submissions were reconciled: 107 completed units (24 pinning, 44 round 1,
39 round 2) and 39 superseded cancellations. Canceled partial work gets no
completion or hit credit. Independent pinned upstream native checking agreed with
all 15 emitted-candidate verdicts and verified the three full solutions. Offline
Core 27.2 accepted the solved synthetic transaction and rejected twelve mutations
in containers with networking disabled. No transaction was broadcast.

The root execution ran from 16:57:03.944 to 18:03:18.474 UTC on 2026-11-14:
3,974.530 seconds, including queue/startup, computation, transport, coordinator CPU
verification and polling. This is one cold first-verified observation, without a
matched baseline or a performance distribution. Trial/gate sanity and emitted-hit
checking do not prove exhaustive enumeration. Deposit admission, wallet recovery,
funded UTXOs and miner inclusion are outside this public-data assessment. The
offline Core helper is deliberately public `OP_TRUE` with nonexistent outpoints.

Estimated VM compute is $20.30; the retained termination-observation bound is
$23.77. Both include idle, canceled and unused host time. EBS, IPv4,
registry/storage, services, logging and networking are excluded, and provider
billing was not queried. All 586 independent cleanup checks passed: seventeen
recorded hosts and seventeen volumes are removed, the entire synthetic owner
partition and all 253 owned objects are empty, and the dedicated guard resources
are absent. Production configuration and all 29 unrelated metadata rows are
unchanged. The $200 operational reservation is released.

An earlier collector interruption submitted sixteen jobs that never started GPU
execution. Its test resources and owner event were removed, all 61 corrected
independent cleanup checks passed, and its reservation was released before this
fresh campaign. Its observed VM estimate is zero; other service charges remain
excluded. The negative result is retained in `assessment.json` and the private
original receipts rather than credited as successful work.

`native-requests-and-results.json` retains every original public request and
available response as exact JSON strings with SHA-256s. The public bundle also
contains the complete consumer audit, upstream native verdicts, final public job,
and Core inputs/results. Provider account, role, network and host readbacks stay
private; their hashes bind the delivered operator assessment. Public arithmetic
replay does not independently reproduce provider execution or timing evidence.

Check every exported byte from the repository root:

```sh
(cd docs/pqb-deployed-validation && shasum -a256 -c SHA256SUMS)
```

Recompute public problem hashes, sampled canonical sighashes and every emitted
full-predicate verdict with a clean upstream challenge checkout at
`eccdd09772edf14ab37fc63992b0626ad7ff2221` and its native
`coincurve==21.0.0` dependency. Use a fresh output path:

```sh
python docs/pqb-production-validation/independent-native-crosscheck.py \
  /path/to/clean/upstream \
  docs/pqb-deployed-validation/native-accounting-audit.json \
  /tmp/fresh-pqb-native-check.json
```

The existing consumer verifier can replay the three solutions from a fresh
directory outside Git after installing repository dependencies:

```sh
evidence_dir=$(mktemp -d /tmp/pqb-public-replay.XXXXXX)
cp docs/pqb-deployed-validation/public-fixture.json "$evidence_dir/"
cp docs/pqb-deployed-validation/final-job.json "$evidence_dir/"
QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/fixture.ts verify "$evidence_dir"
```

See [the bounded deployed procedure](../../ops/pqb-serving/README.md#deployed-public-data-validation)
for campaign preparation, ownership checks, stop controls and independent cleanup.
