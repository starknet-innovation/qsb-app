# Validation status

This snapshot presents research completed on 23 September 2026. It does not grant mainnet release approval.

## Evidence established in the private validation workspace

- A historical, actual Xverse-signed withdrawal was accepted by unmodified offline Bitcoin Core on regtest. That fixture is spent and is intentionally not included.
- Isolated optimized subset tests measured approximately 77% higher round-one throughput and 4–5% higher round-two throughput versus the historical production reference, on matched GPU comparisons. These are component measurements, not promised end-to-end cost savings.
- Native differential, arithmetic, range-boundary, memory, exceptional-point, output-error, and host-error tests have provided scoped evidence. Finite tests do not prove all curve inputs or absence of missed candidates.
- Isolated OCI queue execution and durable local-backend integration were exercised separately. These do not certify the deployed application as a whole.

See the [complete known mainnet readiness checklist](MAINNET-READINESS.md) for task-level acceptance criteria, dependencies and deployment requirements.

## Remaining release work

- Final integrated source/image identity, deployment isolation, and permission review. A source manifest, in-process handoff, local host rehearsal, and local storage-cutover rehearsal now exist in this checkout. No production host is selected. Native binary hashes, OCI identities, regional IAM, and a fresh CPU-verified search do not. A source review of the ranked generic field path and a pin-scoped coverage ledger are now checked in this checkout. They are not a GPU rerun and do not enroll a native binary. In-memory coverage does not measure the HOLD solver binary recorded by `docs/source-build/20260924/solver-build-receipt.json`.
- Fresh full search with the optimized final runtime, new local wallet authorization, and unchanged Core validation of that exact result.
- Chain-correct external miner inclusion and independent confirmation. Offline regtest acceptance is not external mining certification.
- Explicit authorization of the exact transaction, amount and fee before any mainnet broadcast.

The repository now includes source build paths for the optimized worker and complete imported Linux supervisor closure. Raw historical evidence is not fully exported, and historical GPU/withdrawal evidence is not reproduced by a source build. New build identities require enrollment and validation; see [source build instructions](../worker/optimized/README.md).

The [24 September clean-checkout source-build report](source-build/20260924/REPORT.md) records successful native CUDA, queue-image and reproducible supervisor builds, with exact output identities. This closes the external-build-input gap; release enrollment and fresh execution gates remain open.
