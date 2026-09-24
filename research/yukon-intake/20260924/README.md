# Latest Yukon intake, 24 September 2026 — HOLD

For the successor pinning adaptation and its remaining application-use blockers, see the current [release gate checklist](RELEASE-GATES.md). The intake findings below describe the original upstream snapshot.

This is a reproducible intake and rejection record, **not a solver upgrade**. The demo/coordinator release, historical descriptors, optimized candidate, signing commitments and production vendor sources are unchanged. No new performance or price claim is made.

## Provenance

- Pinning: [7e95c40c99e57bded233ce57c7f453fbde9fd21c](https://github.com/Layr-Labs/quantum-safe-bitcoin-challenge/commit/7e95c40c99e57bded233ce57c7f453fbde9fd21c), promoted submission `871963fd-82c8-4c08-99f5-46d4b13f3fce`.
- Subset: [9ac2515450446dbadbe061e98ebfc317c36d4999](https://github.com/Layr-Labs/quantum-safe-bitcoin-challenge/commit/9ac2515450446dbadbe061e98ebfc317c36d4999), promoted submission `7aef224a-e3ff-43f9-9877-50cdbda3f653`.

Fresh `yukon submissions eigenlabs/quantum-safe-bitcoin-challenge/{pinning,subset} --all` rows match both promotion IDs/commit prefixes. Immutable GitHub commit messages bind the full submission IDs. The checker independently downloads both immutable trees and confirms every subset candidate file is identical between the latest tip and the subset promotion. GitHub main alone is not promotion evidence. The snapshot is time-bounded; it does not claim to track future promotions.

[upstream-lock.json](upstream-lock.json) records archive SHA256, promotion rows, commit metadata, full-track tree hashes and 34 active compiler inputs. [benchmark.json](benchmark.json) is the inspected upstream schema-v2 manifest. Upstream setup, benchmark scripts and included executables are never run.

## Validation findings

1. **Different predicate.** Compiling the locked pinning predicate functions on the host gives `DER=1, benchmark=0` for a valid 32-byte DER+sighash test vector, and `DER=0, benchmark=1` for all-zero bytes. Both byte and word benchmark predicates agree. Raw benchmark performance cannot be used as production DER throughput; the host publication gate also needs review. This is an actual-source host test, not GPU execution or a fresh withdrawal.
2. **Incomplete hit publication.** The active pinning source contains `if (count > 64) count = 64;` in slot readback. The application must reject overflow or preserve all candidates before granting complete-range credit. This is source evidence, not an injected device overflow test.
3. **Speculative arithmetic remains enabled.** `QSB_C31=1` precedes the `GPUMath.h` include; that header defaults `QSB_SHORT_CARRY=1` and describes lost-hit exposure. Checking returned nominations cannot recover omitted candidates. The upstream probability estimates are not independently certified here. No new reachable missed-hit example is claimed.
4. **Old detector failure was misclassified.** Its recursive `*.cu` scan also found 22 archived pinning experiments. Several have one search loop, while the active `pinning.cu` still has the two loops expected by the old adapter. Intake now stages only explicitly locked active compiler inputs. The old production adapter is unchanged; this check does not certify a new bounded scheduler.
5. **Subset is unchanged.** There is no new promoted subset implementation to adopt. Earlier SC3/SC4 concerns are not erased by a newer shared-branch pinning commit. No previously blocked repair is retried.

See [result.json](result.json) for the executed local checks. Ten unit tests exercise archive/path/type rejection, changed/missing source rejection, predicate extraction rejection and exclusion of archived experiments from the active lock.

## Reproduce

With Python 3 and a C++ compiler, from the repository root:

```sh
python3 -m unittest discover -s scripts/yukon -p 'test_*.py'
python3 scripts/yukon/validate.py --out /tmp/yukon-intake-new
```

Choose a new output directory: prior evidence is never overwritten. Both immutable archives are downloaded over verified HTTPS and bounded in size. The tip archive and all active sources are hash checked before predicate compilation. `--archive` can supply a previously downloaded tip archive; subset provenance still downloads its immutable commit.

On native Linux x86_64 with Docker, compile both locked upstream entrypoints:

```sh
docker build -f scripts/yukon/Dockerfile.compile -t qsb-yukon-intake:compile /tmp/yukon-intake-new
docker run --rm --network none --read-only qsb-yukon-intake:compile
```

The [CI workflow](../../../.github/workflows/yukon-intake.yml) runs these gates and exports compiler/binary identities. This is default upstream benchmark compilation, with `-O3 -arch=sm_89 -std=c++17`; it does not execute those binaries or adapt their predicates. Apt packages are not snapshot-locked, so record the receipt per build.

## Before application use

Review a separate exact-predicate, bounded-range adaptation with complete arithmetic and overflow handling; validate native differential/arithmetic/DER/coverage/memory behavior; compare production throughput on matched hardware; enroll a fresh release and run a fresh full proof. A compilation pass closes only compilation. These source blockers are enough to withhold adoption, so no GPU was allocated for a misleading leaderboard replay. No deployment, funding, signing or broadcast occurred.

The first working-demo path remains the coordinator release work in issue #15. This research PR must not silently substitute a subset-only or speculative benchmark solver for that release. Upstream source licenses remain with the fetched candidates; this PR ships provenance and local validation tooling, not third-party binaries.

## Native compilation result

[CI run 36039392902](https://github.com/starknet-innovation/qsb-app/actions/runs/36039392902) passed on source commit `069506f` (native Linux x86_64). Both default upstream entrypoints compiled successfully with CUDA 12.8.93; all ten intake tests and the live immutable-tree/predicate checks passed. The [compiler receipt](compile-receipt.txt) records the two binary hashes and compiler/OpenSSL package versions. Subsequent report-only changes do not alter those tested compiler inputs. No GPU execution occurred; the adoption blockers above remain unresolved.

## Follow-up isolated repair

[Pinning repair](PINNING-REPAIR.md) adds a source-hash-checked successor experiment for the predicate, overflow and identified arithmetic flags. The original findings and artifacts above remain unchanged. The chronological report records subsequent scheduling, error-handling, native and runtime validation. It remains HOLD for the open gates in the [current checklist](RELEASE-GATES.md).
