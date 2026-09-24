# Isolated pinning repair — HOLD

This successor experiment addresses three intake findings in the pinned `7e95c40` pinning source. It does not modify the original snapshot, the application's worker, any release descriptor, or the subset candidate. It does not retry the previously blocked subset repair.

## Changes

- A shared host/device DER predicate replaces the byte and word GPU benchmark predicates **and** the OpenSSL host publication predicate. Changing only the device predicates would leave the host discarding real hits.
- All four host clipping sites now fail with `QSB_RANGE_INCOMPLETE` and nonzero return when a count exceeds 64. This rejects an unsupported range; it does not produce unlimited output or authorize automatic retries.
- Ten identified shortcuts/dependent paths are forced off before upstream headers are included: `QSB_C31`, `QSB_SHORT_CARRY`, `QSB_CARRY62`, `QSB_FIELD_SC`, `QSB_SAS_Z9SUB_ALL`, `QSB_MUL_FOLD8_CUT`, `QSB_SQR_FOLD8_CUT`, `QSB_X3_TAIL`, `QSB_NEG_Y_MAC`, `QSB_PARITY_WINDOW`. Conflicting compiler overrides produce an error. These flags isolate known shortcuts; they do **not** prove complete arithmetic correctness or clear the other algorithms in this newer solver.

`adapt_pin.py` verifies all original active input hashes, patches only exact known contexts, preserves the source snapshot and writes a separate source-hash receipt. Output must be a new directory. It copies no subset files.

## Executed host checks

- 10,338 vectors, including all 256 mutations of each byte of a valid DER encoding, varying integer lengths/sighash bytes, zero bytes and deterministic hashes: 31,014 shared-host/GPU-byte/GPU-word predicate outputs match the application's independent Python DER reference when compiled on the host.
- Capacity values 0/1/63/64 succeed; 65/1024/UINT32_MAX reject with a visible incomplete-range error.
- Twelve local tests pass, including the existing intake rejection suite and changed patch-context rejection.
- Source checks bind the host publication call and all four overflow sites. These are not native error-injection tests of a running GPU range.

The CI workflow compiles the changed CUDA solver on native Linux and tests rejection of `-DQSB_C31=1`. Its artifact contains new source and binary identities. The original default upstream compilation evidence remains separately preserved.

## Reproduce

After intake stages `/tmp/yukon-intake-new/source`:

```sh
python3 scripts/yukon/adapt_pin.py --source /tmp/yukon-intake-new/source --out /tmp/yukon-pin-repair-new
python3 scripts/yukon/test_pin_repair.py /tmp/yukon-pin-repair-new/pinning/pinning.cu
python3 -m unittest discover -s scripts/yukon -p 'test_*.py'
docker build -f scripts/yukon/Dockerfile.pin-repair -t qsb-yukon-pin-repair:compile /tmp/yukon-pin-repair-new
docker run --rm --network none --read-only qsb-yukon-pin-repair:compile
```

## Remaining blockers

The upstream scheduler is still unbounded. A reviewed bounded-range adapter, coverage accounting, exact exceptional-point behavior and checked CUDA/OpenSSL/file-output errors remain required before a real application run. The host gate can still conflate an OpenSSL failure with no hit; this change does not close that issue. GLV/isomorphic-coordinate/parity assumptions require independent native differential tests. Real device overflow, memory checks, both recovery branches, production throughput and a fresh final-build withdrawal remain unverified.

There is no GPU result or speedup claim from these host tests. Do not run this benchmark-derived executable as an application worker, enroll it as an approved release, or deploy it. No paid GPU resource, fixture or network transaction is used by this gate.

The initial native build rejected enabling negative-Y MAC and parity-window optimizations while disabling their required carry shortcuts. Their existing fallback paths are now explicitly selected too; no upstream compiler guard was removed. The failed run is retained as [36040427216](https://github.com/starknet-innovation/qsb-app/actions/runs/36040427216).
