# PQB v0.2.0 consumer qualification

Production serves the enrolled PQB v0.2.0 descriptor through permanent London
Batch revision 16. Revision 12 retains v0.1.0 for rollback. The API, coordinator,
stored deployment configuration and GitHub release selection agree.

The public synthetic solve ran through the isolated qsb-app Step Functions,
Batch and S3 pipeline on two Virginia g5.xlarge A10Gs. Workflow elapsed time,
including continuations, was 23,992.126 seconds (6h 39m 52s). The final job reached
awaiting_authorization. The independent audit checked 103 successful native
units and 14 emitted candidates, including three full hits. Three superseded
jobs complete the 106-job inventory, which includes the one-unit preflight.

The CPU result, independent upstream cross-check and offline Core checks passed.
Core accepted the assembled synthetic transaction and rejected all 12 mutations.
The public OP_TRUE helper and nonexistent outpoints limit this evidence to the
public solve and script interpreter. Wallet signing, chain/UTXO and miner
acceptance require their own evidence.

The permanent London revision completed its native preflight in 492.888 seconds.
Both campaigns passed independent cleanup. Hosts whose EC2 records had expired
were reconciled through retained terminal observations or CloudTrail termination
events, fresh EC2 absence and recorded-volume deletion. Collector interruption
and authentication expiry receipts remain in the external campaign archive.

assessment.json records the immutable descriptor, source identities, costs,
cleanup outcome and applicability. The public requests/results and native audit
are gzip archives. Other JSON files preserve the public fixture, final job, CPU
check, independent check and consensus results. Verify their bytes using
sha256-manifest.json.

The cumulative EC2 estimate is $26.42, including prior attempts, reserved idle
time through expiry and the London preflight. It excludes ancillary services
and taxes. The London estimate conservatively ends at independently verified
cleanup. These receipts establish qualification of their recorded binaries and
workloads. A complete-solve speedup over v0.1.0 requires a matched comparison.
