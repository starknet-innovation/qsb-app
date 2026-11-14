# London public consumer-workflow evidence

The enrolled TLS-fixed image completed a public synthetic solve through the real
Step Functions coordinator and immutable AWS Batch/S3 consumer in the production
London account. Native consumer/controller and offline-checker source is
`266de4a4bf5e603f8bc85a46aaa91b5cedefcc4f`. These receipts qualify the temporary
four-slot `g5.4xlarge` A10G validation profile. Production serves Config A and its
original `g5.xlarge`/`BEST_FIT` pool is restored; PQB deployment and hardware
selection still require a reviewed adoption decision.

`assessment.json` records immutable source/image/contract and all 28 packaged
artifact identities, runtime, measured boundaries, costs and cleanup scope. The
image is the already enrolled
`pqb-ranked-v2-cfd99e384469-edce7a14b554`; publication and enrollment are unchanged.
Its existing producer assessment retains the binary/compiler/dependency identities
and license notices. Attestation verification bound this digest to producer
`cfd99e3844698f59679e4c15cf567db2976b9ffc`; the ECR mirror preserved that digest.

The public data retain every original request and available response as exact JSON
strings with SHA-256s, the complete consumer audit, every emitted candidate's
independent verdict, and the exact solved transaction and thirteen Core inputs and
results. The 111 native records comprise 103 completed units (one preflight plus
102 solve units) and eight superseded cancellations. Partial/canceled work gets no
completed-work or hit credit. Independent native coincurve checking reproduced all
14 emitted-candidate verdicts and three full solutions. Core 27.2 accepted one
solved public transaction and rejected twelve mutations in network-disabled,
read-only containers.

The full pipeline took 13,013.448 seconds across its root workflow and two
continuations, including queue/startup, compute, transport, coordinator CPU checks
and polling. This is one complete-pipeline observation, without a matched baseline
or a performance distribution. Trial/gate sanity checks do not prove exhaustive
enumeration; the supported first-verified workflow deliberately supersedes work.

Estimated VM compute is $28.92, with a $31.65 bound from retained terminated-state
observations. Including both interrupted London runs gives $38.86 estimated VM
compute and a $47.42 conservative bound; capacity-blocked attempts allocated no
hosts. EBS, IPv4, storage/registry, service, logging and network charges are
excluded, and provider billing was not queried. All twelve recorded hosts and
twelve volumes are removed, all 281 independent cleanup checks passed, and eleven
restoration checks verified the original pool/queue, idle fleet and unchanged
production bundle hashes and Config A settings. The $200 operational reservation
is released. Original provider/operator receipts stay private; their hashes bind
the summarized cleanup and restoration observations.

Verify the public bytes and inventory with:

```sh
python3 docs/pqb-production-validation/verify-public.py
```

To independently recompute the public problem hashes, sampled canonical sighashes
and every emitted full-predicate verdict, use a clean checkout of
`https://github.com/Layr-Labs/quantum-safe-bitcoin-challenge` at
`eccdd09772edf14ab37fc63992b0626ad7ff2221`, and a Python environment with its pinned
native `coincurve==21.0.0` dependency:

```sh
python docs/pqb-production-validation/independent-native-crosscheck.py \
  /path/to/clean/upstream \
  docs/pqb-production-validation/native-accounting-audit.json \
  /path/to/fresh-recheck.json
```

The checker writes a new result file and records its native backend identity.
`verify-public.py` checks retained bytes and inventory; it does not rerun the GPU,
the curve checker or Core. Repeating the Core assembly/check uses the source-bound
`ops/pqb-serving/consensus.ts` and the retained exact build artifacts; these public
data alone do not provide a new native execution attestation.

The fixture uses a committed public test seed, nonexistent outpoints and an
OP_TRUE helper. This assessment covers the solved PQB script; helper-wallet
signatures, real UTXO/chain acceptance, miner policy/inclusion and broadcast remain
outside its scope. Legacy signatures do not bind prior-output amounts; production
chain and exact-spend checks retain that responsibility. Previous Config A
artifacts remain available for rollback but cannot spend PQB vaults or resume PQB
jobs; there is no separately qualified prior PQB release.
