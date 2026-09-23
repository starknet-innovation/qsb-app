# Validation status

This snapshot presents research completed on 23 September 2026. It does not grant mainnet release approval.

## Evidence established in the private validation workspace

- A historical, actual Xverse-signed withdrawal was accepted by unmodified offline Bitcoin Core on regtest. That fixture is spent and is intentionally not included.
- Isolated optimized subset tests measured approximately 77% higher round-one throughput and 4–5% higher round-two throughput versus the historical production reference, on matched GPU comparisons. These are component measurements, not promised end-to-end cost savings.
- Native differential, arithmetic, range-boundary, memory, exceptional-point, output-error, and host-error tests have provided scoped evidence. Finite tests do not prove all curve inputs or absence of missed candidates.
- Isolated OCI queue execution and durable local-backend integration were exercised separately. These do not certify the deployed application as a whole.

See the [complete known mainnet readiness checklist](MAINNET-READINESS.md) for task-level acceptance criteria, dependencies and deployment requirements.

## Remaining release work

- Final integrated source/image identity, deployment isolation and permission review.
- Fresh full search with the optimized final runtime, new local wallet authorization, and unchanged Core validation of that exact result.
- Chain-correct external miner inclusion and independent confirmation. Offline regtest acceptance is not external mining certification.
- Explicit authorization of the exact transaction, amount and fee before any mainnet broadcast.

The public export contains selected source, not all raw evidence or the full experimental operational runtime. Evidence stated above has not been reproduced from this export. Unit/build checks recorded in PUBLICATION.md apply only to this snapshot.
