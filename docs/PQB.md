# PQB vaults

The browser's vault creation form creates PQB vaults. The SDK registers an externally generated public descriptor with `vaults.create({ name, descriptor })`, where `descriptor.config` is `"PQB"`; the CLI uses `qsb vault create --name <name> --descriptor <public-file>`. Both protocols use the same registration, one-deposit funding, withdrawal approval and exact-submit routes. Deposits are never bound to a solver release.

## Local custody and assembly

[`src/lib/pqb.ts`](../src/lib/pqb.ts) generates a fresh 32-byte seed locally. The pinned PQB generator derives its shared HORS table, menu signatures and ECDSA co-signature key from that seed. Recovery state is exactly `{ "config": "PQB", "seed": "..." }`, plus `"version"` for any construction after `v0` (see below); adoption rebuilds the real-puzzle script from it with that construction. The encrypted backup and passphrase stay with the user. The browser performs generation, recovery validation and assembly in its local Web Worker; the SDK and CLI receive only public descriptors and signed witness material from caller-owned external providers. The external manager holds seeds, wallet/private co-signature keys, recovery storage and credentials; the SDK never decrypts backups or imports a seed. Dropping references does not guarantee zeroization.

## Constructions

A vault's construction is the generator parameter set that turns its seed into a script. The vendored generator builds two:

| Construction | Generator commit | Table gadget | Where it is recorded |
| --- | --- | --- | --- |
| `v0` | `eccdd09` | stride-3: `D_j`, `F_j = 1`, `C_j` | No `version` field: every vault made before constructions were versioned |
| `v1` | `82c7cba` | pick2: `D_j`, `C_j` | `"version": "v1"` in recovery and public state. The PQB Ledger app builds this one. |

New vaults use `v1`, the latest. `v0` is never written out, so earlier backups and vault records keep their exact bytes. A vault's `configuration.generatorCommit` is its construction's commit. Both constructions have the same search stage shapes (menu sizes and widths, subset sizes, table size and key encodings; the menus themselves differ), so the search, problem builder and CPU reference don't depend on the construction beyond the vault's script. A PQB solver release naming either commit can search `v0` vaults. A `v1` vault also needs a kernel that searches its pick2 table, whose deletion boundaries are 21 bytes apart: the v0.2.0 release (with the `82c7cba` CUDA import) or a release naming `82c7cba`. v0.1.0 serves `v0` vaults only. Config A releases still need their exact generator. One seed gives the same HORS secrets and co-signature key under every construction, so registration refuses a PQB vault that pushes a HORS commitment another of the same wallet's registered PQB vaults pushes (`vault_secrets_reused`; not atomic with a concurrent registration), and the SDK checks the same before registering. Across wallets, the custody manager must prevent reuse.

The public vault contains the script, its dummy-signature table, the three menus as curve points and, after v0, its construction `version`. Strict allowlists reject private or unknown public-state fields. The ordered dummy-signature table must match the table pushes in the actual locking script, in the construction's gadget layout; reordered or mutated entries are refused at registration and public problem construction. Menu signature scalars and the seed never enter search requests. A signed withdrawal intentionally discloses 17 selected HORS preimages, three selected menu signatures, the ECDSA co-signature and its public key. The seed, private co-signature key and unrevealed witness material remain local. See [key custody](KEY-CUSTODY.md).

Before assembling a witness, the local client re-derives all three solved digests, checks strict DER and the SIGHASH_SINGLE exclusion, reconstructs the selected indices and compares the complete solution. Assembly uses version 1, helper input 0, vault input 1, and the approved single output. The PQB co-signature uses SIGHASH_ALL over this exact two-input transaction. The browser binds its signing backup before helper signing. The SDK requires an external shared durable journal: an exact intent before paid work, public template/solution before disclosure, and returned assembly bytes before helper signing. The external manager independently enforces one-time use before releasing material. The SDK verifies the returned witness stack, hashes and every signature, then verifies the helper-wallet signature and exact spend. The service runs its offline Bitcoin Core interpreter on the final signed bytes. See the [external custody contract](../sdk/README.md#pqb-external-custody).

## Search and release selection

A deployment still serves exactly one `SOLVER_RELEASE_ID`. `/config` returns its `solverProtocol` as well as `solverReleaseId`; a withdrawal requires the served release's protocol and generator to match its vault. The job pins that descriptor. Config A cannot use a PQB release, and PQB cannot use a Config A release. Drain existing jobs before changing the served release or Batch job-definition revision.

The coordinator uses the same Step Functions and AWS Batch pipeline, reservations, unknown-submission reconciliation and GPU spend caps. Each pinning intent atomically advances a durable high-water mark before its paid submission. After an empty round, re-pinning starts beyond every submitted pinning unit, including parallel units that completed before the winning hit. Its CPU reference in `server/pqb-reference.ts` builds the public problem from the vault and approved manifest. It runs inside the coordinator bundle; Config A's Python reference remains in the separate reference Lambda. All deployment bundles are hashed in the build manifest.

| App job stage | Worker stage | Search |
| --- | --- | --- |
| `pinning` | `pinning` | 14 nSequence values per unit; every usable nLockTime |
| `round1` | `round0` | 8 picks from 109 live slots, partitioned by 7-pick prefixes |
| `round2` | `round1` | 9 picks from the remaining 101 slots, partitioned by 8-pick prefixes |

`contracts/pqb-ranked-v2.json` is the shared worker contract. The TypeScript partitioner checks its vectors and the complete coverage of both round spaces. Contract hashes are generated from those source files using the producer's Python canonical JSON; this preserves the invalid `1.0` test vector, which JavaScript would otherwise serialize as `1`. JavaScript sends integer-valued attempt numbers as integers on the worker wire.

The worker accepts only the eight PQB request fields, including `problemBase64` and `problemSha256`. It receives no sequence overrides or Config A parameter fields. The app binds every response to its manifest, release commit, worker stage, attempt and exact assigned range, and checks completed-unit trial accounting. Every returned PQB candidate is re-derived on the CPU through the canonical transaction and FindAndDelete path before a solution is selected. The full predicate excludes SIGHASH_SINGLE for every construction. Upstream lets `v1` stages whose puzzle check ends in an empty-key OP_CHECKSIG accept that class too; the CPU here still refuses it, which may drop a valid hit but never accepts an invalid one. Hybrid key encodings are accepted where this PQB configuration permits them, under consensus rules. Miner acceptance is still checked on the final signed transaction.

Empty complete units advance contiguously. When an entire round is empty and its paid chunks have drained, the coordinator discards that pinning solution and continues with the next pinning unit. Verified alternatives from that completed pinning unit are not retained. A new search epoch prevents a superseded slot from being credited. GPU-time reservations survive re-pinning. An interrupted unit is not credited; an unknown paid submission requires operator reconciliation and is never automatically resubmitted.

## Source, enrollment and evidence

[`src/pqb-core/provenance.json`](../src/pqb-core/provenance.json) pins the Fireblocks source and lists the imported generator/reference files. It lists two adaptations: `spend.ts` accepts the caller's transaction and vault input index, and `configs.json` adds construction `v0` with `eccdd09`'s parameters, whose scripts this generator rebuilds byte for byte. Upstream `v1` is unchanged. `constructions` names the commit of each construction. The MIT license and upstream notices accompany the source, frontend distribution and SDK package. CUDA and solver images remain in qsb-solver.

The [sm86 v0.2.0 release](https://github.com/starknet-innovation/qsb-solver/releases/tag/pqb-aws-sm86-v0.2.0) uses the Fireblocks `82c7cba` CUDA import. It passed 14 native cases before each of three full A10G ranges. The consumer independently checked the one emitted partial candidate. A served full solve for this digest remains unmeasured. [Native qualification and matched timings](https://github.com/starknet-innovation/qsb-solver/blob/8a308d4063ef892b946ee6bb991bc0feaaccb525/docs/pqb/ASSESSMENT.md)

The [TLS-fixed PQB release](https://github.com/starknet-innovation/qsb-solver/releases/tag/pqb-aws-sm86-v0.1.0) is enrolled verbatim as `src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json`. Its schema-3 descriptor names `pqb-v1`, the pinned generator, `pqb-ranked-v2`, the exact shared-contract hash, merged solver source `cfd99e3844698f59679e4c15cf567db2976b9ffc` and the immutable GHCR digest. The [normal verification commands](SOLVER-REPOSITORY.md#enrolling-a-release) check the original signed build provenance from both the registry and GitHub API and compare the enrolled descriptor with the published asset. Existing descriptors remain byte-identical. Enrollment does not select an image, configure Batch, deploy infrastructure or enable a mainnet switch.

The [replacement assessment](https://github.com/starknet-innovation/qsb-solver/blob/7694d68d34092ee4aa3c58f3220011bbfff75a1b/docs/pqb/2026-11-12-tls-replacement.md) establishes applicability of retained A10G native evidence through a complete comparison of both signed image archives: all 11,044 filesystem paths, compute executables, handler, partitioner, package versions, compiler receipt, runtime libraries and loader cache match. The transport semantic change explicitly selects the system S3 CA store. Fresh installed checks reject 16 bad chains and 14 live compromised-key hosts, accept valid controls and pass real S3 PUT/GET/immutable duplicate rejection. All 20 unfixed Critical matches remain visible, with the supported TLS path mitigated and the other exploit preconditions outside this workload. No global Python fix is claimed.

The [consumer-workflow qualifications](PQB-SERVING-VALIDATION.md) pass native, independent CPU and offline Core validation. The production-account London assessment completed its preflight and full public synthetic solve through Step Functions and the real Batch/S3 consumer on the temporary four-slot `g5.4xlarge` A10G profile in existing subnets. Its audit checked 103 completed units, fourteen emitted candidates and three full solutions; eight superseded cancellations receive no completion or hit credit. All thirteen offline Core checks passed. The [public evidence and replay commands](pqb-production-validation/README.md) bind the exact source, image, artifacts and measured boundaries. Cleanup and restoration of the original production pool are independently verified, alongside unchanged production bundle hashes and Config A settings; the reservation is released. Independent Ireland A10G evidence remains separately recorded. Production PQB deployment and hardware selection require their own reviewed adoption decision.

The [complete public transport assessment](https://github.com/starknet-innovation/qsb-solver/blob/e41580065d68579d7b7f0be0d2991942a5ea93db/docs/pqb/2026-11-11-public-transport-solve.md) is a distinct measurement through Batch/S3 and CPU modules, with 118 completed units, 16 emitted hits and three full hits independently checked with pinned upstream native libsecp256k1. Its image and receipts retain their own identities. Neither measurement is evidence of miner acceptance or an end-to-end withdrawal. Mutable apt/pip resolution means the release binds an exact archived artifact, without promising bit-identical rebuilding.

Completed units must satisfy the producer qualification harness's statistical gate-count bound: with `mean = trials / 2^24`, `abs(gateHits - mean) <= 6 * sqrt(mean) + 6`. This detects grossly incomplete or anomalous work; it does not prove complete enumeration. Interrupted and failed units receive no completion credit.

Before serving PQB, complete deployment-specific runtime verification, including a public synthetic solve through Step Functions and the immutable Batch job-definition revision. A deployment serves one protocol: selecting PQB prevents new Config A withdrawals there. Keep the previous QSB descriptor and deployment manifest for rollback, but they cannot resume a PQB job or spend a PQB vault; drain/reconcile paid jobs before switching. For PQB v0.2.0, retain the v0.1.0 descriptor and its deployment manifest for rollback.

The [public serving harness](../ops/pqb-serving/README.md) prepares this assessment without allocating hardware. An optional isolated A10G (`g5.4xlarge`) queue and pool require externally installed, expiring operator permissions and a validation-role-only runtime-boundary supplement. The controller verifies both before execution. The validation provider keeps the coordinator within four GPUs, adds a queue/startup age watchdog, records instance/volume identities, and verifies isolated capacity cleanup before removing its independent deadline guards. The production queue and pool remain unchanged. The preparation and each execution receipt have distinct source identities; use the sealed assessment for native evidence.

The scoped queue-creation grant must authorize both the queue and its referenced compute environment. Partial-deployment collection checks unresolved IAM role absence through the existing metadata-only role; it never treats access denial as deletion evidence.

`tests/fixtures/pqb-reference.json` (`v0`) and `tests/fixtures/pqb-reference-v1.json` (`v1`) contain only public synthetic data that has never held funds. Each was generated by the independent Python reference at that construction's commit, for the app's two-input layout. Regenerate one from a clean checkout of the commit its construction names:

```sh
python3 scripts/pqb-reference-fixture.py /path/to/fireblocks-labs/pqb v1
npm test -- tests/pqb.test.ts tests/pqb-construction.test.ts tests/pqb-protocol.test.ts
```

These checks cover exact script bytes, public problem bytes, sighashes and trial digests on all stages, strict predicates, co-signature construction and coordinator state transitions. Coordinator positive-hit tests stub the CPU verdicts. They do not constitute a full solve, native GPU execution, Bitcoin Core acceptance of a solved PQB withdrawal, miner acceptance or an end-to-end spend. No mainnet switch is enabled by this support.

The serving harness also supports an explicitly authorized isolated SNF account in Ireland or London.
It runs the same public workflow and native transport with campaign-owned infrastructure
and scoped workload roles. Such receipts qualify that isolated account/hardware;
they do not establish readiness of the production app account or select its release.

The Batch job definition must bind exactly one `QSB_JOB_BUCKET` to the consumer’s
configured artifact bucket. The consumer checks this before uploading public input
or preparing a paid submission. SNF bootstrap sets that binding; request-specific
input keys and hashes remain ordinary submission overrides.

The operational collector paces log reads and routes explicitly reviewed reads
to a separate SDK client with at most five total attempts for transient failures.
Mutations, including journal callbacks, retain a one-attempt client. Real SDK
loopback tests cover dropped connections, throttling, exhaustion and a lost
mutation reply. Collection failure still pauses and drains work for reconciliation.

An explicitly authorized maintenance assessment can temporarily replace the idle
London `qsb-gpu` compute environment at its existing ARN to test the larger A10G
profile in the two existing subnets. The journaled controller retains and restores
the original configuration and refuses active work or hosts. Only the dedicated
public-validation coordinator opts into the alternative profile; production
hardware checks and release selection stay unchanged. See the
[maintenance procedure](../ops/pqb-serving/README.md#authorized-replacement-of-an-idle-original-pool).

The current larger-host profile is one A10G per `g5.4xlarge`, at most four
validation slots within 64 vCPUs. A fresh shared-pool campaign freezes six hours
and a $200 reservation before any submission; its deadline cannot be extended.

The committed watcher deduplicates job IDs across Batch status snapshots, retains
terminal instance receipts and reports stopped campaigns explicitly. Its readiness
check is required before submission; see the
[watcher procedure](../ops/pqb-serving/README.md#committed-campaign-watcher).
