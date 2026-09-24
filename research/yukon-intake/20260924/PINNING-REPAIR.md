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

## Explicit runtime adapter prepared

`scripts/yukon/pin_runtime.py` adds an isolated pinning-only protocol rather than
changing the historical worker's CLI or release identity. Its caller supplies an
enrolled expected binary hash; request and installed bytes must both match it.
The request includes parameter integrity, public manifest/request identity and
explicit checked range bounds. Execution uses a fresh directory, process-group
timeout and a restricted environment. A successful exit alone is insufficient:
the exact single drained-count marker is required, and returned candidate records
must parse exactly and fall within the requested range without duplicates.
Malformed or excessive output rejects. Failed/interrupted work returns no hits.

All results remain `HOLD`, `verified=false`, `rangeCreditEligible=false`. This
adapter does not CPU-verify puzzle hits, publish durable credit, enroll a release,
attest remote hardware, or make the candidate selectable by the app. These are
remaining integration requirements, not claims satisfied by a response hash.

Thirty-four local tests pass, including actual stub subprocess success/failure,
missing marker, binary mismatch and process-group timeout. The stub is not GPU
solver evidence. CI now additionally prepares a valid synthetic public parameter
record and runs the actual compiled solver through this adapter without a GPU;
that new CI result is pending. Successful GPU runtime integration still remains.

## Independent public reference binding prepared

`pin_reference.py` now binds runtime output back to the full public transaction
context. The manifest fingerprint, request/result identities, exact parameter
re-export and every candidate's range/shape must agree before verification. Each
candidate is converted to the existing CPU handler's newline-delimited format;
that handler reconstructs the transaction sighash and checks recoverability, not
only DER syntax. Unreproduced candidates reject; reproduced DER-only unusable
candidates remain explicitly distinct from verified hits. No durable credit or
signing authority is granted by this layer.

The six existing CPU reference Python files are hash-pinned in
`pin_reference_lock.json`. Each export/verification runs in a fresh isolated
interpreter, with no inherited provider credentials, avoiding the handler's
process-global cwd mutation. Hash checks are local integrity checks, not remote
execution attestation. The caller must still enroll trusted binary identity.

Thirty-seven local tests pass. New tests use synthetic nonexistent outpoints,
public commitments with no recovery preimages, and a full generated public
script: real parameter export binds correctly; a changed destination, altered
result identity and an actual negative CPU candidate reject. These are fresh
public synthetic contexts, not funded withdrawals or positive-hit proof. Initial
test fixtures reused a nonce signature in all three stages and were correctly
rejected by the reference; the fixtures now use distinct public signatures.
Positive candidate/release/durable integration and successful GPU execution
through the adapter remain pending. Production worker and CPU sources are unchanged.

Actual-binary runtime CI subsequently passed at source `c675be1`, run
[36046055724](https://github.com/starknet-innovation/qsb-app/actions/runs/36046055724).
The compiled Linux solver ran through the new adapter with synthetic valid public
parameters in a read-only, network-disabled container without a GPU. It returned
`failed`, no candidates and no verification/credit eligibility as required.
Receipt: `runtime/no-gpu-ci.json`. This closes the no-GPU failure boundary only;
it does not replace a successful GPU runtime or CPU positive-hit test.

## GPU runtime attempt — infrastructure failure, not a passed gate

Source `ac9f0cc` prepared two unfunded full-script contexts (SegWit/Taproot
output layouts), 514 candidates each, using frozen previously tested binary
`88cf46c4…`. Secure RTX 4090 creation returned explicit HTTP 400 no capacity;
a fresh listing confirmed no allocation. A community RTX 4090 at $0.34/hour
was then created. The adapter returned failure on its first request. Independent
`torch.cuda.init()` also failed with CUDA unknown error; the binary's shared
libraries resolved. Successful GPU runtime execution remains **unverified**.
The second request did not run. This is not a solver correctness counterexample.

Public inputs, hashes and infrastructure error evidence are preserved under
`runtime/infrastructure-attempt/`. The pod was deleted at 19:13:36 UTC and zero
pods confirmed, with its watchdog terminated. Approximate elapsed compute $0.008
excludes disk/provider rounding. No search was submitted to any proof endpoint,
no funded fixture was used and no transaction was assembled or broadcast.

The execution harness originally raised before preserving the failed output;
it now writes an explicitly incomplete partial receipt before rejecting, with a
subprocess regression check. It never writes a successful receipt on failure.
Future attempts should preflight CUDA health before invoking the frozen solver.
The attempted gate must be retried on healthy capacity; prior bounded native
checks and CPU bindings do not substitute for that gate.

## Successful GPU runtime and CPU binding — passed 24 September

The next secure RTX 4090 passed CUDA initialization and a small device operation
before any solver invocation. Runtime source `af42f4e` executed the **unchanged
frozen binary `88cf46c4…`** against the two previously prepared unfunded public
contexts. Each range covers two sequences and 257 locktimes (514 candidates),
with SegWit or Taproot output scripts. Both returned exact `range-drained`
results, zero candidates, and the expected binary/parameter/manifest/range identity.
Local pinned CPU re-export independently reproduced both parameter files and
accepted their bindings. All transferred input files matched after retrieval.
Receipts: `runtime/native-success/`. The previous infrastructure failure is retained.

End-to-end invocation wall times were 1.171 and 1.173 seconds, including startup;
these tiny ranges are **not throughput measurements or a performance claim**.
No positive hit was returned, so no candidate-verification success is inferred.
This closes the bounded successful GPU runtime plus reference-binding gate,
not fresh search, durable coordinator, OCI queue deployment, positive-hit,
full withdrawal or external-miner validation. Eligibility remains false/HOLD.

The pod was deleted at 19:15:57 UTC, zero pods confirmed and its watchdog
terminated. Approximate elapsed compute $0.0121 excludes disk/provider rounding.
No funded fixture, signing material, proof endpoint or production release changed.

## Matched pinning performance — measured 24 September

One healthy secure RTX 4090 ran the frozen historical application DER baseline
`186d6875…` and frozen repaired candidate `88cf46c4…`, with identical unfunded
full-script parameters. Runner commits `f7b1653` and `8c48202` are pushed before
execution. Baseline binary/source hashes, public requests, every stdout/stderr,
raw timing and cleanup receipts are preserved in `performance/`. This identifies
a historical reference build, not an assertion about the currently deployed image.

The first 24 interleaved samples used 2^27 and 2^29 candidates with three paired
slopes per solver/layout to separate startup from sustained work. Median slope
estimates favored the candidate by 30.23% / 27.89%, but short timing differences
were noisy and do not describe complete work-unit speedup.

A second comparison used **complete production-sized pinning work units**:
16 sequences × 1,244,600,000 locktimes = 19,913,600,000 candidates per run,
three alternating baseline/candidate pairs per layout (12 runs). Process wall
time includes initialization, sequence transitions, search, readback and exit.

| Output layout | Baseline median | Candidate median | Wall time reduction | Throughput gain |
| --- | ---: | ---: | ---: | ---: |
| SegWit | 30.3250 s | 26.5813 s | 12.35% | 14.08% |
| Taproot | 31.3468 s | 27.5561 s | 12.09% | 13.76% |

The full-unit result is the practical measurement for these fixtures; do not
substitute the larger short-range slope estimate. All runs exited successfully,
with exact candidate drain markers and baseline reported counts matching the
reviewed bounded-loop contract. No hit files were emitted. Timed execution is
not exhaustive hash correctness, a positive-hit test or proof that baseline
error handling meets candidate requirements. Both use actual DER predicates;
no easy mode or lowered difficulty was enabled.

This demonstrates a useful **pinning component** improvement on this GPU and
these two parameter sets. It is not a total withdrawal cost reduction, provider
bill, universal hardware gain or certified production price change. Broader
arithmetic, positive-hit integration, durable release integration, independent
review and fresh full withdrawal remain required; the candidate stays HOLD.

The pod was deleted at 19:27:03 UTC before its 19:47:14 watchdog; zero pods were
confirmed and the watchdog terminated. Approximate elapsed compute $0.1087
excludes disk/provider rounding. No production deployment, spent-fixture search,
private recovery material or broadcast was involved.

## Public-context preflight and verifier domain

The isolated `pin_reference.execute` handoff now snapshots public request/context,
re-exports and binds parameters **before compute**, executes the pinned runtime,
and invokes reference verification only for a drained result. Failed/interrupted
runs retain their status with no reference verdict or range credit. No provider,
durable backend or production routing is introduced.

Review found a concrete interface mismatch: the low-level native research
adapter accepts uint32 locktimes, while the hash-pinned application CPU handler
accepts only locktimes through **1,744,600,000 inclusive**. The integrated handoff
now rejects a range whose final candidate exceeds that bound, both before compute
and during result verification. The standalone native adapter retains its broader
arithmetic research domain; those tests do not establish application acceptance.
No production CPU source, lock, GPU source or frozen binary was changed.

Validation: all **43 local tests passed**. New tests exercise the last supported
candidate, the first unsupported candidate, context rejection before compute,
failed/interrupted handoff and successful empty-result binding. CPU export and
binding are real; compute is mocked in these new handoff tests. Earlier native
runtime evidence remains separately scoped; this is not a new GPU execution,
positive-hit, durable-credit or fresh withdrawal proof.

## Positive CPU binding replay

`check_pin_reference_replay.py` replays only the historical public pin solution
through the new reference binding. It does not invoke the GPU or search any
range, and does not assemble, broadcast or spend the already-spent fixture.
The runtime envelope is synthetic and its binary identity is an explicitly
labelled sentinel, not an attestation to a tested solver. The historical public
bundle remains outside this PR; only a public hash/verdict receipt is published
in `runtime/reference-positive/receipt.json`.

The full-transaction CPU reference reproduced the solution as `valid:true`,
with exact sequence/locktime binding. Changing output value and fee while keeping
amounts balanced, and updating both envelope manifest hashes, was rejected
because re-exported parameters differed. This exercises the positive reference
branch and transaction-context substitution defense. The CPU reference tries
both recovery signs independently; the synthetic recid field is not GPU parity
evidence. No complete range credit is issued.

A positive result produced by the new normal GPU binary and passed through this
handoff remains pending, as do durable integration and fresh end-to-end proof.

## Exact-source CPU loader regression

Runtime integration review identified a source-attestation gap in the new research
reference adapter: it hashed six `.py` files but then used ordinary imports, which
could execute matching-timestamp cached bytecode instead of those checked bytes.
The adapter now reads and verifies the exact six-file source set, rejects
preloaded reference modules, and compiles those saved bytes in dependency order
inside its fresh child. Production reference sources and their lock are unchanged.

The disposable-directory regression constructs an alternative `handler` bytecode
cache with a valid source timestamp/size header. An ordinary isolated Python
import demonstrably uses that cache. The repaired child ignores it and exports
real parameters from the pinned source. Changed source and symlinked source both
reject. All **45 local tests pass**. The positive historical CPU replay was rerun
as a loader regression and is saved under `runtime/source-loader/`; it remains
CPU-only, with no solver invocation or fixture spend.

This closes the demonstrated bytecode-cache substitution path, not filesystem
immutability or full runtime enrollment. The trusted launcher, adapter/lock
identity, immutable installation, queue/durable fencing and independent review
remain release requirements. No claim is made that source hashes alone establish
an attested host or provider image.

## Public-state reconstruction before parameter export

The research CPU adapter previously relied on the legacy handler's field/config
checks. Those checks did not reconstruct the vault script or enforce consistency
between public signature scalars, encoded signatures and commitments. Integration
now applies the existing owned runtime's `validate_public_state` invariants before
export/verification, using the already exact-source-loaded CPU modules. The
validation function was carried from the committed
`supervised/runtime/layout/owned-runtime/cpu/registry.py` validator, with explicit
integer geometry checks added; no production runtime source or lock was changed.

Checks cover exact public fields, supported geometry, commitment dimensions and
lengths, unique recoverable dummy signatures, scalar/DER signature consistency,
round signature shape, exact script reconstruction and script/opcode bounds.
Extra recovery-secret fields reject; no private material is read. This is public
structural/reference validation, not a consensus certificate or authorization.

All **46 local tests passed**, including eight malformed-state cases (script,
commitment, pin scalar, round scalar, duplicate dummy, boolean geometry, extra
private-field name with an empty value, and short commitment row). They reject
before the compute callback. Positive CPU historical replay still passes; its
separate regression receipt is in `runtime/state-reconstruction/`. No GPU work,
fixture spend or deployment occurred. Durable release integration remains open.

## Indexed Store publication integration

`scripts/yukon/pin_store.ts` connects the research result/reference contract to the
application `Store` transaction interface and the existing indexed pin inventory.
It binds the completed provider ID, frozen request, expected binary, public context,
CPU verdict, owner and revision. Scope/intent updates plus conditions on the
provider identity index and global ID claim occur in one atomic transaction.
Candidates move the scope to draining; empty results do not grant range credit.
Duplicate publication, pause/revision races and changed identities fail closed.

Seven tests pass using the actual application `MemoryStore` and existing
`PinInventoryV3.reserve/submit/attach` path. The transport and CPU verifier are
mocked in these transaction tests. Coverage includes two racing publishers, repeat
delivery, pause and index/global-claim changes during verification, mismatched
provider/range/context, stale owner/revision, inconsistent decisions and verifier
failure. Typecheck passes. No database service, paid submission or GPU was used.

This is an **unenrolled research integration**, not a replacement controller.
`research_result_verified` is deliberately not an accepted production handoff
state: it retains evidence without authorizing subset launch. The trusted CPU
callback still needs fixed-launcher enrollment, and successful checks here do not
certify DynamoDB service behavior. Next gates are the composed real CPU runner,
real isolated backend, sibling drain/owned handoff and release-aware queue routing.
Existing production controller/runtime artifacts and release selection are
unchanged. No claim is made that the durable integration blocker is fully closed.

## Real CPU runner composed with Store publication

`pin_verifier.ts` provides a fixed fresh-process verifier callback for the research
Store bridge. Its checked-in lock pins the Python CLI, runtime contract, reference
adapter and CPU source lock. The child compiles checked runtime/reference bytes;
the reference child independently compiles its six checked CPU sources. Public
input cannot select a command, path or interpreter. Launcher configuration is
trusted operator configuration. The runner limits input/output size, strips the
environment to PATH, uses isolated Python and kills its process group on timeout
or excessive output. This does not establish an immutable or attested host.

**11 TypeScript tests pass**, including the prior Store races plus real-process
CPU composition: a generated unfunded public context exports/rebinds successfully,
a false candidate is rejected without a durable mutation, and pause fencing
survives successful CPU verification. Each of four adapter artifacts rejects both
changed bytes and same-byte symlinks before launch. All **46 Python tests** and
TypeScript typecheck pass. Provider transport remains mocked; this is MemoryStore,
not DynamoDB service certification, positive GPU-hit evidence or a fresh proof.

The runner and publisher are research-only and unselected by application routing.
No live release/image registry, cloud resources, completed proofs or production
runtime source was changed. Remaining composed gates include a real isolated
backend and drain/handoff integration under an explicitly enrolled release.

## Actual DynamoDB Local publication gate

The same ten Store-publication tests now pass through the unchanged application
`DynamoStore` against official DynamoDB Local 3.3.1 over loopback HTTP. This
exercises actual conditional puts, queries and multi-row transactions, including
scope/intent CAS and condition-only provider-index/global-ID checks. Three cases
compose the real fresh-process CPU runner. Transport remains synthetic; positive
candidate publication in the transaction-race cases uses mocked CPU verdicts.

Evidence: `runtime/dynamodb-local/receipt.json`, containing per-test results and
test-source hash. The cached official image is pinned by recorded digest. Tests
opt in only with `QSB_PIN_TEST_DYNAMODB=http://127.0.0.1:<port>` matching
`AWS_ENDPOINT_URL_DYNAMODB`, region `us-east-1`, both credential fields set to the
public dummy value `qsbLocalDummy`, and no session token. They create isolated
random tables and delete them afterward. Ordinary test runs remain MemoryStore.
The first setup used a hyphenated dummy access-key name, which DynamoDB Local
rejected; no publication test progressed. The corrected alphanumeric dummy key
passed all ten cases. This was not an AWS regional credential or service failure.

Post-test ListTables returned an empty array; the disposable container was
removed and its absence checked. The existing unrelated local container was
untouched. MemoryStore/runner tests were rerun (11 pass), and typecheck passes.
No AWS regional resource, GPU, deployed release or fixture was touched. This
closes the local database API gate, not regional IAM/availability, crash/restart
durability or full enrolled lifecycle validation. Drain/handoff, release routing
and fresh GPU/end-to-end gates remain required.

## Abrupt database restart and fresh-process reconciliation

`check_pin_restart.ts` seeded a real local DynamoStore with a published research
candidate and a separate uncertain submission (mock transport throws after the
durable submission claim). After both records were acknowledged, DynamoDB Local
was killed with SIGKILL (exit 137), restarted on the same disposable persistent
volume, and checked by a new Node process. It compared both rows against their
pre-restart canonical hashes before attempting any mutation.

Both rows survived unchanged. Repeated publication rejected before invoking CPU
verification; retrying the uncertain submission rejected before its send callback.
The reconciled late provider ID then attached to the original intent via the
existing indexed identity protocol, and another submission attempt still rejected.
There were **zero provider callback calls after restart**. This tests uncertainty
preservation and duplicate prevention, not recovery by blind retry.

`runtime/dynamodb-restart/receipt.json` records the database stop/start observations,
result assertions, checker hash and cleanup. The test table was deleted; container
and volume were removed and container absence checked. Standalone checker typecheck
passes. The checker only accepts a loopback endpoint and fixed public dummy
credentials. CPU verdict and transport in this specific restart test are mocked;
the preceding real CPU/DynamoDB composition remains separate evidence. This closes
the tested local abrupt-restart case, not regional AWS guarantees, all crash points,
provider drain, enrolled release routing or fresh GPU/full-withdrawal proof.

## Drained pin to subset-parameter handoff

The fixed CPU runner now supports a separate handoff operation. It re-verifies
the exact public pin against the reconstructed full transaction, then independently
exports round1 and round2 parameters for that pin. The Store handoff requires
current owner/revision, a bound winning receipt, terminal evidence for every
submitted sibling, no uncertain/reserved work, and a fresh trusted endpoint
observation with zero queued/in-progress jobs and min/max workers zero. Exported
parameters must have canonical base64 and matching SHA256. A scope CAS fences
pause/new inventory mutations while the CPU and provider adapters run.

All inventory writers must follow the existing indexed protocol and increment
SCOPE.version; arbitrary raw database writes are outside that ownership contract.
The resulting state is `research_subset_prepared`, with dispatch authorization
false and release HOLD. It is not accepted by the production launcher and does
not select a new solver or start subset work.

Validation: **15 TypeScript tests and typecheck pass**, and all **46 Python tests
pass**. Four new state-machine tests cover single-use preparation, unresolved
siblings, busy/stale/wrong-endpoint drain, a pause during handoff and corrupt
parameter hashes. The same **14 Store cases pass against actual DynamoDB Local**;
provider observations and handoff CPU replies in those four cases are mocked.
Tables were deleted, then the disposable database container was removed and its
absence checked. Existing containers were untouched.

Separately, the real fixed Node/Python runner re-verified the historical public
pin and exported both real parameter sets, while an invalid pin rejected.
`runtime/drain-handoff/positive-cpu-replay.json` records hashes/sizes only; this
was CPU-only replay, with no GPU search or fixture spend. The Python adapter
closure lock was refreshed for the new operation; the frozen GPU binary and CPU
reference sources remain unchanged. Live provider drain, complete composed
positive-GPU handoff, immutable release enrollment/routing and fresh end-to-end
proof are still pending. The tests do not certify those broader gates.

## Frozen pin runtime image package and offline entrypoints

`package_pin_runtime.py` produces a new directory from an explicit eleven-file
public closure and only the previously tested frozen `88cf46c4…` binary. It rejects
another binary, symlinks and overwriting an existing package. It copies one checked
binary snapshot and verifies the six CPU source hashes before packaging. The binary
is supplied explicitly from native test evidence, not committed to Git; source
compilation and its distinct output identity remain the earlier build workflow.

The pinned CUDA runtime base, manifest and one-request `pin_worker.py` entrypoint
support compute, public CPU verification and pin handoff. Each process checks its
closure; these checks are consistency controls, not remote image attestation.
The manifest remains HOLD/dispatch-disabled with no invented registry digest.
No provider queue handler or application default is changed.

The local amd64 image built successfully; exact OCI index, amd64 manifest and
config digests are recorded separately in `runtime/image/build.json`. It was
**not pushed or enrolled**. Nine actual image cases ran with `--network none`,
read-only root and tmpfs: frozen binary no-GPU failure, real public parameter
binding, six malformed/negative cases, and historical positive CPU handoff.
No-GPU compute reports failed with no candidates/credit. The positive case only
regenerated public subset parameters; it did not search or spend the historical
fixture. All test containers exited and were removed. The local image is retained.

All **48 Python tests pass**, including packaging whitelist/hash/overwrite tests.
This closes local assembly and offline entrypoint checks, not GPU success inside
this image, provider queue transport, remote enrollment or fresh proof. Earlier
native GPU tests are not silently promoted into certification of this new image.

## Compute-only queue image and coordinator decoder

`pin_queue.py` binds provider job ID, runtime-manifest hash and canonical input
hash around a fresh one-request runtime child. Only bound compute is accepted.
The child environment excludes provider credentials, output files have kernel
size limits, and timeout/error cleanup kills and reaps its process group. Limits
are set inside the fresh interpreter, avoiding `preexec_fn` in a threaded SDK
worker. A non-drained/failed runtime result raises a job error, never success.

The packager now emits separate `runtime` and `queue` Docker targets (select
`--target runtime` or `--target queue` explicitly). Queue source, unchanged existing
hash-locked dependencies and the runtime manifest have a separate binding. The
new decoder checks queue protocol, provider ID, runtime manifest, submitted input
hash and output/request fields before producing the Store publication envelope.
It does not accept historical solver output as the new release or enroll itself.

All **51 Python tests**, **16 TypeScript integration tests**, and typecheck pass.
Queue tests use real child processes for credential exclusion, failure, malformed
output, timeout and output-limit checks, and reject artifact/manifest mismatch
before launch. The decoder rejects changed transport/result bindings.

The local amd64 queue image built with the existing hash-pinned Runpod SDK 1.7.13
and passed pip check. `runtime/queue/` records distinct OCI index/manifest/config
identities. Actual installed SDK import and main-entry handler registration were
checked offline/read-only with networking disabled. SDK startup was intercepted;
the registered handler rejected no-GPU compute and wrong manifest as expected.
This proves registration/failure handling, **not remote queue polling or GPU
success**. No credentials, paid resources, image push, enrollment or production
routing were used. Test containers were removed; the local image remains available
for the next explicitly bounded remote validation gate.
