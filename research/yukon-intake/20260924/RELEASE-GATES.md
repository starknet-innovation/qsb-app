# PR #30 release gates — HOLD

Current audit: 24 September 2026, after source commit `1c839f487b3eb5c1cb0a2ea692f3d21408220439`.
This is the current gate checklist. [PINNING-REPAIR.md](PINNING-REPAIR.md) preserves the chronological experiments, including earlier blockers subsequently addressed. Those earlier paragraphs are not the current status.

The candidate is an isolated **pinning** adaptation. It does not replace the application's default solver, certify the unchanged upstream subset, or authorize a production deployment. The frozen GPU binary is `88cf46c45a63972e31af5f1c835a3b4088d6ea76af4b69e7bb0d7227d1562263`.

## Evidence already established

| Gate | Evidence and limit |
| --- | --- |
| Immutable intake | [Source lock](upstream-lock.json) binds promoted commits and active inputs. This is a dated snapshot, not certification of later submissions. |
| Finite native correctness | [Detailed report](PINNING-REPAIR.md) records DER, curve/hash differential, boundaries, overflow, CUDA fault injection and sampled memory checks. Finite tests do not establish correctness for all curve inputs. |
| Matched component performance | [Performance evidence](performance/) records alternating same-GPU comparisons with the historical baseline. This is pinning throughput, not full withdrawal cost or user pricing. |
| Real GPU queue execution | [Remote receipt](runtime/remote-queue/receipt.json) and [CPU binding](runtime/remote-queue/verified-0.json) establish one unfunded zero-hit range through the immutable OCI image and Runpod queue. |
| Durable claims and recovery | [Submission tests](runtime/submission-route/dynamodb-local.json), [receive tests](runtime/release-route/dynamodb-local.json) and [restart evidence](runtime/route-restart/verified.json) exercise DynamoDB Local with conditional transactions and restart preservation. They do not certify a deployed AWS coordinator. |
| Positive CPU route and sibling drain | [Composed replay](runtime/terminal-reconciliation/positive-route.json) uses actual CPU verification and subset export, with MemoryStore and synthetic provider observations. It is a historical known-solution replay, not a new GPU discovery or withdrawal. |
| Fresh bounded search | [Campaign result](runtime/fresh-campaign/result.json): 38 complete outputs, 756,716,800,608 reported candidate pairs, zero hits, no unresolved attempts. [CPU receipts](runtime/fresh-campaign/verified.json) check context/parameter/result binding; they do not independently enumerate all those hashes. Pod deletion and disabled proof endpoints were confirmed. |

## Open gates and concrete closure criteria

| Gate | What is still needed | Next action / dependency |
| --- | --- | --- |
| Independent final review and broader arithmetic assessment | An independent reviewer must examine the exact adapter, effective arithmetic paths, runtime identity checks and evidence; document residual coverage limits and resolve findings. Author self-review and CI are not independent approval. | Reviewer choice is pending. Prepare review against the frozen binary/source and current PR, without retrying the previously blocked subset repair. |
| Fresh positive GPU hit | A newly discovered hit from the real predicate must pass the exact-source CPU verifier and release-bound publication. Zero-hit search and historical replay do not close this gate. | [Continuation](runtime/fresh-campaign/continuation-prepared.json) contains only the 62 unattempted requests, after rechecking the 38 completed outputs. A cumulative GPU spending limit is pending; no continuation has launched. A larger budget does not guarantee a hit. |
| Strict serverless startup capacity | Establish and verify a supported configuration that respects the authorized worker allocation during startup, including extra initializing records. | [Capacity investigation](STARTUP-CAPACITY.md) remains open. Do not set `startupCapacityValidated` from documentation alone or substitute the successful single-pod test as queue evidence. No provider message is authorized. |
| Live composed release-aware lifecycle | Exercise exact release enrollment, durable intent before submission, provider ID attachment, CPU-verified receive, sibling terminal reconciliation and drain, and subset handoff in one isolated live run. Preserve uncertainty across failure/restart and grant no coverage for a hit alone. | Local composition and remote queue compute passed separately. Live composition still needs a constrained provider path and explicit isolated enrollment; keep production defaults disabled. |
| Fresh final-build full withdrawal | On a new fixture, preserve commitments and input/output bindings through fresh search, user-approved signing and unmodified Core acceptance of the exact transaction. | A synthetic unfunded pinning campaign cannot close this gate. Both earlier funded fixtures are spent and must never be reused. Complete the integration gates before a new end-to-end campaign. |
| External miner inclusion | Use a chain-correct funded fixture and independently confirm inclusion of the exact signed transaction. | Prior regtest bytes returned `missing-inputs` from Testnet4 Teststream; do not repeat that preflight. Installed Xverse Testnet4 support is unestablished. Mainnet requires concrete transaction, amount and fee authorization; none is granted here. |

## Release boundary

The PR stays draft/HOLD. No production enrollment, default activation, merge, pricing change or mainnet transaction is authorized by these receipts. Commit and push reviewed source before any deployment, then verify its identity at the target. Keep private credentials and recovery material outside the repository and validation artifacts.

Testnet4 is a risk-reduction path, not a Bitcoin requirement that every application use it first. It does not remove any exact-signature, consensus, infrastructure or miner-validation obligation. A direct mainnet plan would need separate concrete authorization.

The historical proof endpoints remain disabled. Future bounded GPU work needs a fresh resource and watchdog, at most one test GPU, a live price announcement and verified deletion within 30 minutes. Continue only unattempted work after reconciliation; never retry an uncertain paid submission.
