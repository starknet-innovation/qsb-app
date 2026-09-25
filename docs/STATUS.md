# Validation status

## Current status, 25 September 2026

The plan of record is #8, and the first mainnet run is #22. Where this section and the 23 September research snapshot below differ, this section applies.

**Decisions** (by @adrienlacombe):
- GPU work runs on AWS Batch only. Runpod is neither the default nor a fallback.
- There is no test-chain phase. The first end-to-end run is a small mainnet deposit and withdrawal (#22). The offline consensus check from #20 replaces the regtest rehearsal (#21).
- The Step Functions coordinator is the single pipeline. #25 removed the supervised host, storage and dispatch resources from Terraform.
- Mainnet can be switched on only through the deploy-time Terraform variables `mainnet_enabled` and `exact_submit_enabled` (#48, #20), and both default to false. They are turned on only for a test session, with explicit approval each time. The approvals and switch changes go in the private deployment record, not in Git; #22 tracks them.
- The first withdrawal should use the optimized subset kernel (see **Solver** below).

**Deployed** (details in #22's pre-flight status):
- The lean app stack from #25.
- The AWS Batch GPU stack. It runs at most one On-Demand `g5.xlarge` (A10G) and scales to zero. Jobs have a 900-second limit, and a watchdog stops anything past 30 minutes. It runs the attested `aws-v0.1.0` release, built for sm86 from `qsb-solver`'s historical-baseline `worker/Dockerfile`.
- IAM: APP-ROLE-SANDBOX steps 2 and 3 passed live (`ops/iam-sandbox`, #65). The installed runtime boundary and deploy role match `main`.

**Solver:**
- The optimized sm86 candidate is qsb-solver#2. Its release gate is the native sm86 A10G checks of the repaired pinning (pinning, exceptions, curve and memory), plus a matched A10G performance check against `aws-v0.1.0`. The fresh regtest proof search is not required.
- Measured so far, on the same sm89 GPU (qsb-solver#2): about 76–81% higher round-one and 3–4% higher round-two subset throughput. Pinning is unchanged. Matched A10G numbers are pending.
- After it merges, the steps are a release from the tested image without rebuilding, enrollment in this repository, and a new job definition. Each needs explicit approval.
- A vault binds only its QSB configuration, and a withdrawal job pins the solver release that is deployed when the job is created (`src/lib/provenance.ts`). So a deposit can be made at any time, but create the withdrawal only after the optimized release is enrolled.

**Remaining for #22:**
- the deposit;
- the withdrawal and its search, which also confirms that Batch pulls the solver image by digest;
- local signing;
- exact-submit approval;
- inclusion;
- the evidence under `docs/`.

## Research snapshot, 23 September 2026

This snapshot presents research completed on 23 September 2026. It does not grant mainnet release approval.

### Evidence established in the private validation workspace

- A historical, actual Xverse-signed withdrawal was accepted by unmodified offline Bitcoin Core on regtest. That fixture is spent and is intentionally not included.
- Isolated optimized subset tests measured approximately 77% higher round-one throughput and 4–5% higher round-two throughput versus the historical production reference, on matched GPU comparisons. These are component measurements, not promised end-to-end cost savings.
- Native differential, arithmetic, range-boundary, memory, exceptional-point, output-error, and host-error tests have provided scoped evidence. Finite tests do not prove all curve inputs or absence of missed candidates.
- Isolated OCI queue execution and durable local-backend integration were exercised separately. These do not certify the deployed application as a whole.

See the [complete known mainnet readiness checklist](MAINNET-READINESS.md) for task-level acceptance criteria, dependencies and deployment requirements.

### Remaining release work, as of 23 September

- Final integrated source/image identity, deployment isolation, and permission review. A source manifest, in-process handoff, local host rehearsal, and local storage-cutover rehearsal now exist in this checkout. No production host is selected. Native binary hashes, OCI identities, regional IAM, and a fresh CPU-verified search do not. A source review of the ranked generic field path and a pin-scoped coverage ledger are now checked in this checkout. They are not a GPU rerun and do not enroll a native binary. In-memory coverage does not measure the HOLD solver binary recorded by `docs/source-build/20260924/solver-build-receipt.json`.
- Fresh full search with the optimized final runtime, new local wallet authorization, and unchanged Core validation of that exact result.
- Chain-correct external miner inclusion and independent confirmation. Source gates now reject a chain mismatch, spent-regtest reuse, a submit without an exact transaction, amount, and fee, and a preflight treated as inclusion. They do not fund, broadcast, or close this gate. Offline regtest acceptance is not external mining certification.
- Explicit authorization of the exact transaction, amount and fee before any mainnet broadcast.
- Production activation remains unapproved. Source gates now keep a decision record unapproved, separate feature enablement from spend authorization, define the operational caps and unknown-outcome reconciliation procedure, and refuse a local build as live configuration. The operator cost field is not the experimental USD ceiling. Vault USD 10000, fee USD 1000, and GPU USD 1000 are a fail-closed check that cannot run while `release.mainnetEnabled` and `broadcastAuthorized` are false. They do not deploy or enable mainnet.

GPU source builds now belong to [qsb-solver](https://github.com/starknet-innovation/qsb-solver); this repository retains the parked Linux supervisor closure. Historical GPU/withdrawal evidence does not certify new builds. New identities require publication, enrollment and validation; see [solver repository integration](SOLVER-REPOSITORY.md).

The [24 September clean-checkout source-build report](source-build/20260924/REPORT.md) records successful native CUDA, queue-image and reproducible supervisor builds, with exact output identities. This closes the external-build-input gap; release enrollment and fresh execution gates remain open.
