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

## Native compile gate passed

[CI run 36040760736](https://github.com/starknet-innovation/qsb-app/actions/runs/36040760736), tested source commit `44018c1d78164797e8e47213e523aa262279ce33`, passed on native Linux x86_64. The repaired pinning binary SHA256 is `a1d882c5cf6ad4d97759462c3bf02166f34756eb727b8b03a8d9da12c7dbc08b` with CUDA 12.8.93. The explicit `-DQSB_C31=1` override was rejected. The same CI ran all twelve tests and 31,014 host predicate comparisons successfully. See [compiler receipt](pin-repair-compile.txt), [source receipt](pin-repair-source.json), and [host results](pin-repair-host.json). Report-only commits do not change the tested compiler inputs. This closes native compilation only; no GPU execution was performed.

## Bounded scheduling follow-up

The isolated adapter now requires exactly six arguments after the executable:
`params gpu sequence_start sequence_count locktime_start locktime_count`.
Numeric arguments are decimal-only. It rejects zero counts, sequence counts over
16, unsigned overflow, sequences without BIP68's disable bit, locktimes below
500000000 and starts not aligned to 256 (the selected SHA path's requirement).
The single selected device owns the whole range; benchmark interleaving and
optional easy/debug overrides are unavailable. Both scheduler branches use
64-bit offsets and clamp the final batch. The slotted branch drains every slot
before returning, including with sequence overlap enabled.

Local validation: 13 unit tests pass, including exact host enumeration of nine
boundary ranges and 13 invalid-input cases. The 31,014 host predicate comparisons
still pass. This is not native GPU coverage evidence. `QSB_RANGE_DRAINED` is a
scheduling receipt only, deliberately not eligibility for completed-range credit:
unchecked CUDA/OpenSSL/output errors and native boundary testing remain blockers.
The previous compile receipt applies to the previous source, not this change.

Both hit publishers now use checked directory creation, open, and
write/flush/close wrappers. Failed output terminates the process with exit 2.
Host tests exercise missing parents, a directory as output, an existing file
blocking the results directory, and successful exact output; Linux also tests
`/dev/full`. Fourteen unit tests pass locally (macOS skips unavailable
`/dev/full`). CUDA and OpenSSL error handling remain separate pending work.

## Checked public-point recovery

The host nomination gate now uses a shared, checked OpenSSL recovery helper.
Allocation, scalar arithmetic, point addition/inversion, compressed point
serialization and hashing failures terminate with exit 2. Infinity returns a
non-candidate without attempting affine serialization; doubling uses OpenSSL's
complete point operation. Host suffix bounds and SHA initialization/double-hash
returns are also checked. This repairs the nomination verifier, not the GPU's
exceptional-point coverage or all table-construction paths.

Sixteen local tests pass. The new helper matches independent Python affine
secp256k1 arithmetic and SHA-256 on 96 cases (both recovery signs, two scalar
multipliers, zero/order/wrap boundaries and deterministic public scalars).
Thirteen synthetic failed-check injections individually terminate before output.
These inject the checked condition, not actual OpenSSL allocator faults. The
existing 31,014 predicate comparisons still pass. Native compilation of this
changed source remains required; GPU curve coverage remains pending.

Bounded-only implementation `23b704c947abcac80963c3cd10c616d1fe59832c`
passed native CUDA compilation in Actions run 36041532564. It does not certify
these subsequent publication/recovery changes.

## Standalone CUDA error checks

The adapter now wraps the locked inventory of 41 previously unchecked standalone
CUDA calls, covering device selection/properties, allocations, table/parameter
uploads, initialization synchronization, tuning attributes, counter reset and
fallback readback. Each return is evaluated once and any non-success exits 2.
Existing assigned/conditional checks are preserved. A small scanner hides
comments/literals, rejects inventory drift, and does not wrap checked expressions;
the one unbraced tuning loop is explicitly braced before transformation.

Eighteen local tests pass. Host CUDA mocks verify evaluation once and no later
calls/output after each injected failure in a three-operation sequence. This is
not 41-site native fault injection: active-path GPU failure validation and the
helper-header CUDA calls remain to be audited. Table-construction OpenSSL checks,
GPU exceptional coverage, runtime integration and fresh proof are still pending.
