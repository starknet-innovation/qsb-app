# PQB public consumer-workflow qualifications

## London production-account validation

The [checksummed London evidence](pqb-production-validation/README.md) qualifies
the enrolled TLS-fixed image through the real Step Functions coordinator and
immutable Batch/S3 consumer on the temporary four-slot `g5.4xlarge` A10G profile in
the two existing production subnets. Native consumer/controller and offline
checker source is `266de4a4bf5e603f8bc85a46aaa91b5cedefcc4f`. No IAM or networking
change was needed.

The native audit checked 103 completed units: one preflight plus 102 solve units
(23 pinning, 43 round 1, 36 round 2). Eight superseded cancellations receive no
completion or hit credit. Independent pinned upstream native checking reproduced
all fourteen emitted-candidate verdicts and all three full solutions. The exact
solved public transaction passed the Core interpreter and all twelve negative
mutations were rejected.

The full pipeline took 13,013.448 seconds across its root workflow and two
continuations, including queue/startup, transport, compute, coordinator CPU checks
and polling. This single first-verified solve provides no matched performance
comparison or exhaustive domain-coverage proof.

Estimated VM compute is $28.92; the retained termination-observation bound is
$31.65. Including both interrupted London runs gives $38.86 estimated VM compute
and a $47.42 conservative bound. Other service charges are excluded and provider
billing was not queried. All 281 independent cleanup checks passed: twelve
recorded hosts and twelve volumes are removed and dedicated campaign resources
are absent. Eleven restoration checks verified the original `g5.xlarge`/`BEST_FIT`
pool and queue, zero fleet demand/hosts and unchanged production bundle hashes and
Config A settings. The operational reservation is released. Original provider
receipts remain private, with hashes in the public assessment.

This receipt applies to the temporary London validation profile and its recorded
consumer bundles. Serving PQB requires a reviewed deployment and hardware
selection; production continues to serve Config A.

## Independent Ireland qualification

The enrolled TLS-fixed PQB image passed its native preflight and complete public
synthetic solve through the actual Step Functions coordinator and AWS Batch/S3
consumer on isolated Ireland A10G infrastructure. Independent CPU verification and
all thirteen offline Core checks passed. Temporary campaign resources are removed,
cleanup independently verified and the operational reservation released.

The [producer assessment and checksummed public evidence](https://github.com/starknet-innovation/qsb-solver/blob/2f1b729a49b4e40d97909a1d0751fea3a74b62ad/docs/pqb/2026-11-13-serving-validation.md)
retain every public request/successful response, candidate verdict and Core input,
plus exact identities, timings, estimated costs and cleanup scope. Private operator
configuration and original provider receipts remain outside Git.

| Identity | Qualified value |
|---|---|
| Descriptor | `pqb-ranked-v2-cfd99e384469-edce7a14b554` |
| Canonical image digest | `sha256:edce7a14b5548a079f8ebf1e866c533cb14573328cf739a6647b150cca08756e` |
| Producer source | `cfd99e3844698f59679e4c15cf567db2976b9ffc` |
| Native consumer/controller | `16a842a11811b0ecc036ee9b15291360275d755e` |
| Corrected offline checker | `a3b28bfea190bf606cebed4dd7e73bfb69654d28` |
| Coordinator ZIP SHA-256 | `59816f3a0c21e2b2c4f0cf8f0aaa4eb4252a8bf5e31a7b1e866a9b8fc6b7eff2` |
| API ZIP SHA-256 | `1d23ffc6f4545fd3d1b330e0a0be6b3d5ef694a6deb03bb6dba48dd1d0ee9c35` |
| Runtime | `g5.xlarge`, one A10G, driver `580.178.04`, `eu-west-1` |

The preflight completed one full pinning unit. The full solve completed 108 units
(23 pinning, 46 round 1, 39 round 2); 39 coordinated cancellations receive no work
credit. The sealed audit checked all 109 successful units across both phases, all
15 emitted candidates and all three full solutions. The pinned upstream native
CPU backend independently reproduced every full-predicate verdict.

The full workflow took 3,953.614 seconds from its start to terminal success,
including queue/startup, transport, coordinator CPU checking and polling. This one
synthetic run is neither a matched performance comparison nor a cost distribution.
It does not prove exhaustive domain coverage.

The Core component assessment accepted the exact solved public transaction and
rejected twelve mutations. Its corrected locator uses the final PQB signature/key
stack pair and lock HASH160, permitting other DER signatures earlier in the
witness. Explicit retained verification requires sealed native evidence,
independently verified cleanup, unchanged application/build/fixture source, all 28
original packaged artifact hashes, the byte-identical transaction and identical
Core binary/library/container. Native execution and offline postprocessing keep
their separate source identities.

Estimated VM compute for the successful campaign is $18.73; the conservative
termination-observation bound is $22.44. Including the three stopped SNF campaigns,
the conservative VM bound is $26.09. EBS, IPv4, storage/registry, service, logging
and network charges are excluded. Provider billing was not queried. All twenty
recorded hosts are terminated or reconciled absent and all twenty volumes are
deleted. The immutable registry mirror and untouched pre-existing network are
intentionally retained.

The production-account validation harness can select an administrator-provisioned
subnet in a new zone for its isolated pool. It freezes and verifies that subnet's
shared VPC, public routing and ACL identity before use. The production queue and
pool keep their existing subnets. Subnet creation/removal and expiring IAM grants
remain administrator-managed; the controller cannot broaden its own permissions.

Production continues to select Config A with its existing coordinator bundle.
These Ireland receipts qualify the isolated SNF account; London has the separate
validation above. Selecting PQB requires
its own reviewed deployment decision. The previous Config A descriptor/image and
deployment stay available for rollback; they cannot spend PQB vaults or resume PQB
jobs. There is no separately qualified prior PQB release for that purpose.

The test uses nonexistent public outpoints and an OP_TRUE helper. It does not test
a helper-wallet signature, real UTXO/chain acceptance, miner policy/inclusion or
broadcast. Legacy signatures do not bind prior-output amounts; production chain
and exact-spend checks remain required. No funded output or wallet material enters
the campaign. No mainnet switch changes as part of qualification.
