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

## Generic launch compatibility correction

Further effective-path inspection found two additional blockers: upstream main
refused all non-leaderboard layouts, and its FAST_TAIL finish used an H0-only
leading-zero shortcut before the repaired full-digest predicate. Both prevented
the earlier component repairs from establishing an app-compatible solver.

The isolated adapter now instantiates both existing launch specializations,
selects FAST_TAIL only for its exact geometry and uses the generic specialization
otherwise. It removes the H0-only nomination bypass, so all layouts reach the
full-digest DER predicate. `single_hash=1` is fixed to the application's existing
Config A worker convention: one SHA-256 of the recovered public key; the
transaction preimage remains double SHA-256. No easy/debug mode is accepted.
Source assertions check both launch sites, both generic instantiations, removal
of the H0 bypass and the fixed hash mode. Native compilation/GPU differential
validation of this newly reachable generic path are required; the earlier
compiled candidate was not runnable on app geometry and is not approved.

## Bounded parameter parsing

The replacement loader reads at most 264 bytes and accepts only exact records
with a supported 8–119-byte suffix. It decodes endian formats explicitly, checks
preimage/midstate block consistency, non-overlapping sequence versus
locktime/sighash fields, and all bounds before allocating. Read/close/allocation
failures reject the record. No file-controlled unbounded allocation remains in
this loader. Public curve/scalar validity still needs the subsequent checked
initialization path; accepting a record is not proof of its transaction binding.

Nineteen local tests pass, including all 219 truncations of a representative
record, ten malformed/oversized/trailing-data cases, three valid size/layout
boundaries with exact decoded fields, and missing input. Native CI remains
required for the final integrated source. Recovery-only commit af31798 passed
native CUDA compilation in Actions run 36041900102; later changes are separate.

## Public curve inputs before CUDA setup

A checked OpenSSL preflight now rejects zero/out-of-order scalars,
noncanonical field coordinates, off-curve points and infinity before CUDA device
selection or table construction. Nine additional cases cover generator/negative
generator, order boundaries and malformed coordinates; twenty tests pass locally.
This establishes input validity only. It does not certify table arithmetic or
remove the need to check allocations/operations inside upstream table builders.

## Table-builder OpenSSL checks

The locked host source now checks 162 calls to explicitly enumerated APIs with
zero/null failure returns. Return types and values are preserved and expressions
evaluate once; failures terminate before subsequent operations. Comparisons,
length-returning APIs, frees and already-checked modular inversions are not
rewritten. Five table-coordinate encodings use checked 32-byte padded writes
instead of unchecked variable-length output. This includes allocation checks
before dependent point/scalar operations in ladder/fallback/spot-check setup.

Twenty-two local tests pass. Transformation tests preserve comments/literals and
non-boolean API semantics; mocked allocation/arithmetic failures verify no later
operation or completion after failure and pointer identity on success. These are
not 162-site native fault-injection results. GPU table correctness, exceptional
coverage and final-build validation remain pending. The public-input version
b69629d passed native CI run 36042539454; this later change needs a new build.

## Native differential runner prepared

`scripts/yukon/native_pin.py` prepares eight unfunded public synthetic ranges for
one-/two-block SHA geometry, partial batches, sequence transitions and uint32
endpoints. It compiles both normal and separately traced binaries, checks the
normal drain count, and compares every trace hash with independent Python
secp256k1 plus hashlib. Missing, duplicate, extra and incorrect traces reject.
Predicates are unchanged in the trace binary; this is not a fresh withdrawal or
performance benchmark. Preparation succeeded locally; 24 local tests pass.
Native execution and final binary receipts are pending. No GPU allocated yet.

The native build workflow also executes eleven rejection paths in the actual
compiled binary, inside a network-disabled read-only container with temporary
scratch space. Malformed CLI/ranges, truncated/oversized/trailing parameter data
and zero curve constants must fail before CUDA access or a drain receipt. This
check is prepared for CI, not yet recorded as passing; it is not GPU execution.

## First native generic differential — passed 24 September

Source commit `39a5dc9e1aff46be74d0d8282ce8987200a470cb` was tested on one
secure RTX 4090 with CUDA 12.8.93. Both normal and separately traced binaries
compiled and ran all eight synthetic ranges: 12-/75-byte suffixes, 1/129/257
locktime counts, two consecutive sequences and the final uint32 boundaries.
All **3,600 public-key hashes** matched independent Python curve arithmetic and
hashlib, without missing/duplicate/extra trace records. All eight normal runs
reported the expected drained candidate count. A two-sequence 257-locktime
normal run passed compute-sanitizer memcheck with **zero errors**.

Normal binary: `fcd5fd1af515c583b0d7cc32384f2acc3dd1bfaf062774a9bc3e6f869afb751a`.
Trace binary: `6dcec0e481ff4c49f0f1d1d98932473020922a50b18b3540a36535e5572e15b0`.
All 17 staged source/header hashes were checked against the adaptation manifest
after retrieval. Public receipts and exact trace logs are in `native-generic/`.
CI run 36043210294 also passed compilation and all eleven real-binary rejection
paths without a GPU. Twenty-four local tests passed.

The temporary pod was deleted at 18:46:57 UTC, before its 19:13:30 deletion
watchdog; a fresh provider listing showed zero pods. Approximate elapsed compute
was $0.03, excluding storage and provider rounding. No funded outpoint, wallet,
private recovery material, proof endpoint or transaction was used.

**Limits:** these are synthetic generic-path cases with scalar multiplier 1 and
recovery point G. They do not cover the specialized FAST_TAIL layout, multiple
GPU batches, all exceptional points, full device overflow/fault injection or
representative throughput. Trace and normal binaries are distinct. This is not
a fresh withdrawal, release approval or external-miner evidence. Those remaining
gates must use the final source/binary and genuine transaction bindings.

## Exceptional denominator handoff prepared

Source review confirmed that upstream marks zero-denominator active lanes unusable
and silently drops them in the finish stage. The isolated adapter now appends a
bounded marker after the collective for each such lane. The marker preserves its
index/sequence/locktime and goes through the existing checked CPU gate, which
recomputes the public transaction hash and both recovery signs using OpenSSL.
Bit 31 distinguishes this handoff; Config A uses no second hash choice. The host
gate is now locked on, and overflow still fails closed rather than crediting an
incomplete range. This introduces no alternate success predicate.

Two additional synthetic cases construct public R=+P and R=-P from a known
synthetic message hash with scalar multiplier 7. These exercise the actual
zero-denominator detector, with one doubling and one infinity branch each,
without solving a SHA preimage or accessing any wallet. The diagnostic build
records CPU fallback hashes/infinity as well as GPU hashes. Twenty-five host
tests pass; native execution of this changed binary is pending. Previous native
results remain bound to the pre-handoff binary and are not release evidence for
this change. Specialized geometry and multi-batch gates also remain pending.

The next native plan additionally covers the exact specialized 9995-byte layout
with a public 155-block prefix, two consecutive sequences and partial batches.
It tests both scalar multiplier 1 / point G and order-minus-one / point 3G.
A checked host OpenSSL midstate exporter is independently checked by padding
complete messages and comparing with hashlib; 26 host tests pass. The oracle
hashes the entire prefix+suffix rather than trusting the exported midstate.
These newly prepared specialized cases have not yet run on a GPU.

## Expanded native gate — passed 24 September

Commit `73f2493b5c145642d0b7b088ca46f1da00cffa5b` compiled and passed all twelve
normal/trace cases on a secure RTX 4090, CUDA 12.8.93. This rechecks the prior
generic cases on the changed binary and adds both exact FAST_TAIL layouts and
both constructed exceptional denominator cases. **4,634 finite hashes and two
infinity outcomes** match the independent CPU oracle, with exact trace records.
The raw runner's `matchedHashes` field counts all outcomes, including infinity;
the cleanup receipt separates them explicitly.

The normal binary completed the 8,388,609-candidate two-batch smoke with the exact
drain count. This checks scheduling/completion, not every hash in that large
range. The normal exceptional case passed memcheck with zero errors.
All 17 staged source/header hashes matched the source manifest after retrieval.
Normal binary SHA256: `88cf46c45a63972e31af5f1c835a3b4088d6ea76af4b69e7bb0d7227d1562263`.
Trace binary SHA256: `35e5dddea0bd035c856dcaf285a0f012a9928bdb290d8f22341f9aa87578ae9d`.
Public receipts and transcripts are in `native-expanded/`; prior evidence remains
unchanged. The test pod was deleted at 18:54:48 UTC, zero pods confirmed and the
watchdog terminated before its deadline. Approximate compute $0.034 excluding
disk/rounding. No fixture, wallet, broadcast or production deployment was used.

These constructed public-point cases exercise the actual GPU denominator
detector and CPU doubling/infinity handoff; they are not naturally discovered
SHA-preimage solutions. Broader arithmetic, real hit/overflow and native fault
injection, matched throughput, release integration and fresh withdrawal gates
remain. The normal two-batch smoke is not exhaustive large-range differential
coverage, and the trace binary is not the production binary.

## Native capacity and checked-CUDA faults — passed 24 September

Commit `8f9d3237edec9884665c5d5ee9f0fdd70c408e57` adds separate diagnostic
builds and leaves all 17 normal solver source/header files byte-identical.
One secure RTX 4090 ran six forced-nomination cases: 1/63/64 drained, while
65/1024/1025 exited 2 with the exact over-capacity count and no drain marker.
The 1025 case passed compute-sanitizer with zero errors. Forced nominations
are not real DER solutions; the unchanged exact CPU gate still controls output.
This validates rejection and bounded writes, not support for publishing >64 hits.

The separate CUDA diagnostic preserves real calls, then substitutes an error
return at a selected ordinal. All **33 reached calls** independently exited 2
at the selected ordinal without subsequent checked calls or range completion.
These include allocation, upload, table setup, stream attributes and synchronization.
This is synthetic error-return injection after real calls, not induced hardware
failure, coverage of every static CUDA call, or injection into the separately
checked asynchronous slot/readback helpers. Those distinctions remain material.

The unchanged-source normal binary was rebuilt and completed a one-candidate
zero-hit smoke. Its SHA256 is
`1de2aea958cb32dd1db658abd659fb2ffaef82b8b031b28f2fbe829bbf88f204`;
it is not byte-identical to the previous build and is not substituted into any
release. Prior expanded differential evidence remains bound to its own binary.
The two diagnostic hashes and exact transcripts are in `native-faults/`.
No diagnostic environment controls were added to normal solver source.

All 28 local harness tests passed before native execution. The pod was deleted
at 19:01:50 UTC and zero pods confirmed; its deletion watchdog was terminated.
Approximate elapsed compute was $0.0312 excluding storage/provider rounding.
An initial creation returned HTTP 500; a fresh empty pod list was reconciled
before the single successful creation retry. No paid solver submission retry,
fixture spend, proof restart, production deployment or broadcast occurred.

The candidate remains HOLD. Broader arithmetic and asynchronous failure coverage,
representative matched performance, release/runtime integration, independent
review and fresh full withdrawal remain outstanding.

## Native asynchronous error propagation — passed 24 September

Commit `92bb6f0` adds a separate diagnostic build wrapping asynchronous CUDA
expressions in the main source and the unchanged slot-readback / priority-lane
helpers. Its baseline drains two sequences with one candidate each. All **31
reached call ordinals** independently fail closed when a synthetic error is
substituted after the real CUDA call: each stops before later instrumented calls
and emits no range-drained marker. Cases include pinned allocation, stream/event
creation, both root dependency directions, counter reset, compact result transfer,
completion event recording and final event synchronization. Both sequences are
covered. Exact site inventory, exit codes and transcripts are in `native-async/`.

The diagnostic binary SHA256 is
`65ccbed5aaba11196deee70bab43a8244b91eeb51d5947e499a4a30db4fe3cd6`.
Normal solver source is unchanged. These are injected return errors after real
calls, not real hardware failures or all compile-time modes. This small case does
not prove every multi-batch reuse path, valid-hit publication, or cleanup-failure
behavior. It complements rather than replaces the earlier checked-CUDA and
capacity diagnostics. Thirty local tests passed before execution.

The secure RTX 4090 pod was deleted at 19:06:05 UTC, zero pods confirmed, and its
watchdog terminated. Approximate elapsed compute $0.0255 excludes storage and
provider rounding. No funded fixture, wallet, spent proof, production deployment
or broadcast was involved. Remaining principal gates are broader arithmetic,
matched throughput, explicit release/runtime integration, independent review and
a fresh complete withdrawal; the PR remains HOLD.
