# PQB vaults

The browser's vault creation form and `vaults.create({ config: "PQB", ... })` in the SDK create PQB vaults. The CLI uses `qsb vault create --config PQB`. Config A remains the default. Both protocols use the same registration, one-deposit funding, encrypted backup, withdrawal approval and exact-submit routes. Neither a deposit nor its backup selects a solver release.

## Local custody and assembly

[`src/lib/pqb.ts`](../src/lib/pqb.ts) generates a fresh 32-byte seed locally. The pinned PQB generator derives its shared HORS table, menu signatures and ECDSA co-signature key from that seed. Recovery state is exactly `{ "config": "PQB", "seed": "..." }`; adoption rebuilds the real-puzzle script from it. The encrypted backup and passphrase stay with the user. The browser runs this TypeScript in its own process; the SDK and CLI run it in their Node process. Dropping references does not guarantee zeroization.

The public vault contains the script, its dummy-signature table and the three menus as curve points. Strict allowlists reject private or unknown public-state fields. Menu signature scalars and the seed never enter search requests. A signed withdrawal intentionally discloses 17 selected HORS preimages, three selected menu signatures, the ECDSA co-signature and its public key. The seed, private co-signature key and unrevealed witness material remain local. See [key custody](KEY-CUSTODY.md).

Before assembling a witness, the local client re-derives all three solved digests, checks strict DER and the SIGHASH_SINGLE exclusion, reconstructs the selected indices and compares the complete solution. Assembly uses version 1, helper input 0, vault input 1, and the approved single output. The PQB co-signature uses SIGHASH_ALL over this exact two-input transaction. The existing signing-backup binding, helper-wallet signature verification, amount/fee checks and offline Bitcoin Core interpreter remain in the submit path.

## Search and release selection

A deployment still serves exactly one `SOLVER_RELEASE_ID`. `/config` returns its `solverProtocol` as well as `solverReleaseId`; a withdrawal requires the served release's protocol and generator to match its vault. The job pins that descriptor. Config A cannot use a PQB release, and PQB cannot use a Config A release. Drain existing jobs before changing the served release or Batch job-definition revision.

The coordinator uses the same Step Functions and AWS Batch pipeline, reservations, unknown-submission reconciliation and GPU spend caps. Its CPU reference in `server/pqb-reference.ts` builds the public problem from the vault and approved manifest. It runs inside the coordinator bundle; Config A's Python reference remains in the separate reference Lambda. All deployment bundles are hashed in the build manifest.

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

The worker proposed in [qsb-solver #18](https://github.com/starknet-innovation/qsb-solver/pull/18) is a HOLD candidate. There is no enrolled PQB descriptor. Merging source in that repository does not enroll or serve an image here. Enrollment requires a published, attested, schema-3 `solver.json` naming `pqb-v1`, the pinned generator, `pqb-ranked-v2` and the exact shared-contract hash. Verify and copy the descriptor verbatim through the [normal enrollment process](SOLVER-REPOSITORY.md#enrolling-a-release), then select it explicitly at deployment. A changed contract or worker wire format needs a matching app change and fresh checks.

`tests/fixtures/pqb-reference.json` contains only public synthetic data that has never held funds. It was generated by the pinned independent Python reference for the app's two-input layout. Regenerate it from a clean checkout at the provenance commit:

```sh
python3 scripts/pqb-reference-fixture.py /path/to/fireblocks-labs/pqb
npm test -- tests/pqb.test.ts tests/pqb-protocol.test.ts
```

These checks cover exact script bytes, public problem bytes, sighashes and trial digests on all stages, strict predicates, co-signature construction and coordinator state transitions. Coordinator positive-hit tests stub the CPU verdicts. They do not constitute a full solve, native GPU execution, Bitcoin Core acceptance of a solved PQB withdrawal, miner acceptance or an end-to-end spend. No mainnet switch is enabled by this support.
