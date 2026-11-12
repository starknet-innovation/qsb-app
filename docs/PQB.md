# PQB vaults

The browser's vault creation form and `vaults.create({ config: "PQB", ... })` in the SDK create PQB vaults. The CLI uses `qsb vault create --config PQB`. Config A remains the default. Both protocols use the same registration, one-deposit funding, encrypted backup, withdrawal approval and exact-submit routes. Neither a deposit nor its backup selects a solver release.

## Local custody and assembly

[`src/lib/pqb.ts`](../src/lib/pqb.ts) generates a fresh 32-byte seed locally. The pinned PQB generator derives its shared HORS table, menu signatures and ECDSA co-signature key from that seed. Recovery state is exactly `{ "config": "PQB", "seed": "..." }`; adoption rebuilds the real-puzzle script from it. The encrypted backup and passphrase stay with the user. The browser performs generation, recovery validation and assembly in its local Web Worker; the SDK and CLI run the same TypeScript in their Node process. Dropping references does not guarantee zeroization.

The public vault contains the script, its dummy-signature table and the three menus as curve points. Strict allowlists reject private or unknown public-state fields. Menu signature scalars and the seed never enter search requests. A signed withdrawal intentionally discloses 17 selected HORS preimages, three selected menu signatures, the ECDSA co-signature and its public key. The seed, private co-signature key and unrevealed witness material remain local. See [key custody](KEY-CUSTODY.md).

Before assembling a witness, the local client re-derives all three solved digests, checks strict DER and the SIGHASH_SINGLE exclusion, reconstructs the selected indices and compares the complete solution. Assembly uses version 1, helper input 0, vault input 1, and the approved single output. The PQB co-signature uses SIGHASH_ALL over this exact two-input transaction. The existing signing-backup binding, helper-wallet signature verification, amount/fee checks and offline Bitcoin Core interpreter remain in the submit path.

## Search and release selection

A deployment still serves exactly one `SOLVER_RELEASE_ID`. `/config` returns its `solverProtocol` as well as `solverReleaseId`; a withdrawal requires the served release's protocol and generator to match its vault. The job pins that descriptor. Config A cannot use a PQB release, and PQB cannot use a Config A release. Drain existing jobs before changing the served release or Batch job-definition revision.

The coordinator uses the same Step Functions and AWS Batch pipeline, reservations, unknown-submission reconciliation and GPU spend caps. Each pinning intent atomically advances a durable high-water mark before its paid submission. After an empty round, re-pinning starts beyond every submitted pinning unit, including parallel units that completed before the winning hit. Its CPU reference in `server/pqb-reference.ts` builds the public problem from the vault and approved manifest. It runs inside the coordinator bundle; Config A's Python reference remains in the separate reference Lambda. All deployment bundles are hashed in the build manifest.

| App job stage | Worker stage | Search |
| --- | --- | --- |
| `pinning` | `pinning` | 14 nSequence values per unit; every usable nLockTime |
| `round1` | `round0` | 8 picks from 109 live slots, partitioned by 7-pick prefixes |
| `round2` | `round1` | 9 picks from the remaining 101 slots, partitioned by 8-pick prefixes |

`contracts/pqb-ranked-v2.json` is the shared worker contract. The TypeScript partitioner checks its vectors and the complete coverage of both round spaces. Contract hashes are generated from those source files using the producer's Python canonical JSON; this preserves the invalid `1.0` test vector, which JavaScript would otherwise serialize as `1`. JavaScript sends integer-valued attempt numbers as integers on the worker wire.

The worker accepts only the eight PQB request fields, including `problemBase64` and `problemSha256`. It receives no sequence overrides or Config A parameter fields. The app binds every response to its manifest, release commit, worker stage, attempt and exact assigned range, and checks completed-unit trial accounting. Every returned PQB candidate is re-derived on the CPU through the canonical transaction and FindAndDelete path before a solution is selected. The full predicate excludes SIGHASH_SINGLE; hybrid key encodings are accepted where this PQB configuration permits them, under consensus rules. Miner acceptance is still checked on the final signed transaction.

Empty complete units advance contiguously. When an entire round is empty and its paid chunks have drained, the coordinator discards that pinning solution and continues with the next pinning unit. Verified alternatives from that completed pinning unit are not retained. A new search epoch prevents a superseded slot from being credited. GPU-time reservations survive re-pinning. An interrupted unit is not credited; an unknown paid submission requires operator reconciliation and is never automatically resubmitted.

## Source, enrollment and evidence

[`src/pqb-core/provenance.json`](../src/pqb-core/provenance.json) pins the Fireblocks source and lists the imported generator/reference files. There is one adapted function: `spend.ts` accepts the caller's transaction and vault input index. The MIT license and upstream notices accompany the source, frontend distribution and SDK package. CUDA and solver images remain in qsb-solver.

The [TLS-fixed PQB release](https://github.com/starknet-innovation/qsb-solver/releases/tag/pqb-aws-sm86-v0.1.0) is enrolled verbatim as `src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json`. Its schema-3 descriptor names `pqb-v1`, the pinned generator, `pqb-ranked-v2`, the exact shared-contract hash, merged solver source `cfd99e3844698f59679e4c15cf567db2976b9ffc` and the immutable GHCR digest. The [normal verification commands](SOLVER-REPOSITORY.md#enrolling-a-release) check the original signed build provenance from both the registry and GitHub API and compare the enrolled descriptor with the published asset. Existing descriptors remain byte-identical. Enrollment does not select an image, configure Batch, deploy infrastructure or enable a mainnet switch.

The [replacement assessment](https://github.com/starknet-innovation/qsb-solver/blob/7694d68d34092ee4aa3c58f3220011bbfff75a1b/docs/pqb/2026-11-12-tls-replacement.md) establishes applicability of retained A10G native evidence through a complete comparison of both signed image archives: all 11,044 filesystem paths, compute executables, handler, partitioner, package versions, compiler receipt, runtime libraries and loader cache match. The transport semantic change explicitly selects the system S3 CA store. Fresh installed checks reject 16 bad chains and 14 live compromised-key hosts, accept valid controls and pass real S3 PUT/GET/immutable duplicate rejection. All 20 unfixed Critical matches remain visible, with the supported TLS path mitigated and the other exploit preconditions outside this workload. No global Python fix is claimed.

**No new GPU execution or timing measurement is claimed for the replacement.** The original three largest native units and 39 small-case invocations retain their original source/image/archive identities. The replacement's actual installed wrapper was replayed with those retained grinder transcripts through the independent CPU consumer; that replay mocks the grinder and grants no work credit. Nine fresh hardware requests failed before allocation; cleanup was independently reconciled. Mutable apt/pip resolution means this is an exact archived-artifact release, not a promise of bit-identical rebuilding.

The [complete public transport assessment](https://github.com/starknet-innovation/qsb-solver/blob/e41580065d68579d7b7f0be0d2991942a5ea93db/docs/pqb/2026-11-11-public-transport-solve.md) provides separate evidence for one synthetic three-stage solve through the actual Batch/S3 and CPU modules: 118 completed units, 16 emitted hits and three full hits, independently checked with pinned upstream native libsecp256k1. Its older image retains its original identity. Final-image native qualification exercised the installed handler in isolated Docker; neither assessment validates the served Step Functions solve, solved-spend Core/miner checks or an end-to-end withdrawal.

Completed units must satisfy the producer qualification harness's statistical gate-count bound: with `mean = trials / 2^24`, `abs(gateHits - mean) <= 6 * sqrt(mean) + 6`. This detects grossly incomplete or anomalous work; it does not prove complete enumeration. Interrupted and failed units receive no completion credit.

Before serving PQB, complete deployment-specific runtime verification, including a public synthetic solve through Step Functions and the immutable Batch job-definition revision. A deployment serves one protocol: selecting PQB prevents new Config A withdrawals there. Keep the previous QSB descriptor and deployment manifest for rollback, but they cannot resume a PQB job or spend a PQB vault; drain/reconcile paid jobs before switching. There is no qualified previous PQB release to fall back to.

`tests/fixtures/pqb-reference.json` contains only public synthetic data that has never held funds. It was generated by the pinned independent Python reference for the app's two-input layout. Regenerate it from a clean checkout at the provenance commit:

```sh
python3 scripts/pqb-reference-fixture.py /path/to/fireblocks-labs/pqb
npm test -- tests/pqb.test.ts tests/pqb-protocol.test.ts
```

These checks cover exact script bytes, public problem bytes, sighashes and trial digests on all stages, strict predicates, co-signature construction and coordinator state transitions. Coordinator positive-hit tests stub the CPU verdicts. They do not constitute a full solve, native GPU execution, Bitcoin Core acceptance of a solved PQB withdrawal, miner acceptance or an end-to-end spend. No mainnet switch is enabled by this support.
