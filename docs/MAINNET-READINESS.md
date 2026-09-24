# Mainnet readiness checklist

**Status: NOT READY. Mainnet activation and transaction broadcast are not authorized.**

Updated 24 September 2026. This is the public release checklist, distilled from the local validation record. It intentionally excludes operational identifiers, credentials, wallet material, signed transactions and private evidence locations.

The repository is a curated research snapshot. Some integration work and evidence described here exists only in the working research environment. Publication of this repository does not mean those components are deployed or reproducible from this checkout. An unchecked item below requires evidence, review and an explicit status update; a passing nearby test does not close it.

## What has already been established

| Area | Evidence obtained | What that does not establish |
| --- | --- | --- |
| Historical wallet withdrawal | An actual Xverse-signed transaction was accepted by unmodified offline Bitcoin Core on regtest. | A fresh withdrawal using the final optimized runtime, or external miner inclusion. The historical fixture is spent. |
| Subset performance | Matched isolated GPU comparisons measured approximately 77% higher round-one throughput and 4–5% higher round-two throughput than the historical reference. | End-to-end latency, a customer price reduction, or all-workload gains. |
| Native solver | Scoped differential, arithmetic, curve, DER, range, memory, hit-capacity, exceptional-point, CUDA/OpenSSL error and output-publication checks; independent scoped source reviews. | Exhaustive mathematical correctness, certification of arbitrary compiler flags, or validation of later changed binaries. |
| Queue/runtime | Bounded actual GPU/OCI queue execution and cancellation/drain tests; immutable package identities recorded locally. | A complete fresh pinning-to-both-subsets search through the final application and runtime. |
| Durable coordination | Local database transactions, concurrent claims, uncertain submissions, restart recovery, publication and session/replacement handoff tests. Some tests use actual Linux processes and CPU verification. | Production AWS permissions, complete production migration, or live-provider facts where tests supplied simulated responses. |
| Browser/API | Backup encryption, one-time intent handling, wallet-lifetime guards, existing-job selection, authenticated route and configuration tests. | Successful final deployed UI/API/runtime composition; browser tests mock wallet, chain or QSB operations where stated. |
| Public checkout | `vitest run` in this checkout reported 28 files and 235 tests, and `tsc --noEmit` passed, after pinned dependency preparation. The parent checkout `1c34f60` reported 26 files and 217 tests. The initial public export recorded 134. | Browser/GPU tests, deployment, or a fresh withdrawal reproduced from this public checkout. |

## 1. Complete and freeze the distributable release

**Status: source build paths added; release enrollment remains open.** The [optimized worker](../worker/optimized/README.md) and [Linux supervisor distribution](../supervised/runtime/README.md) now build from repository source. This removes the private archive/precompiled solver input requirement. It does not certify the new artifacts or automatically reconcile historical image/CPU/runtime identities.

- [x] Package the complete reviewed API, dispatcher, runtime, CPU verifier and evidence-reader dependency closure without reads from a developer work directory. Evidence: `release/source-manifest.json`, rebuilt by `npm run package:release` after `npm run vendor`. The closure follows relative imports of enrolled modules and includes `package.json`, `package-lock.json`, and `tsconfig.json`. `tests/release-package.test.ts` copies that closure into a temp tree, rejects extra files, and rechecks hashes. Paths outside this checkout are rejected. This is a source closure, not an OCI image.
- [x] Define compatible pinning and subset releases explicitly. A subset-only optimization must not be treated as a replacement for the entire solver pipeline. Evidence: the manifest pairs historical pinning with the historical subset selected by `worker/Dockerfile`. `research/optimized-subset` stays `selectedByWorkerDockerfile: false` and `replacesSolverPipeline: false`.
- [ ] Record source commit, build inputs, compiler flags, dependency versions, native binary hashes and OCI index/platform-manifest identities. Distinguish source hashes, image config IDs and registry manifests.
- [x] Verify that package contents match the enrolled identities and that modified wrappers cannot inherit certification from an unchanged native executable. Evidence: `verifyPackageTree` fails when a packaged wrapper byte changes. `certifyWrapper` returns `wrapper-changed` when the wrapper changes and the presented native hash does not, and `native-not-enrolled` while native executable hashes are null. No native executable is certified by this checkout.
- [ ] Make the relevant regression tests and sanitized evidence reproducible from the release checkout. Clearly identify any evidence that remains private or externally dependent.
- [ ] Complete independent final integration review and close concrete findings against the exact frozen artifacts.

**Acceptance evidence:** a source-controlled release manifest, reproducible build instructions, artifact identity checks, scoped review conclusions, and a clean committed release tree. The public snapshot's placeholder historical image location is not a deployable release reference.

## 2. Finish the application-to-runtime integration

**Status: partial.** Creation, admission, durable coordination, current-state resolution and process ownership have separate scoped tests. Their final joined path remains a release gate.

- [x] Implement the source connection from authenticated job creation through an atomic outbox, SQS and durable dispatch/admission/host claims. [Implementation and test limits](../supervised/README.md). A queued response remains distinct from a running search.
- [ ] Validate that final connection on the enrolled Linux deployment, including credential provisioning, watchdogs, process failure/restart and runtime/table/image identity alignment. Local synthetic composition does not close this gate.
- [ ] Atomically claim invocation and launch authority before starting a process. Bind owner, request, revision, phase, reservations, capability, configuration and release identity. The in-process `claimLaunch` helper persists those bindings before `launchOwnedProcess` and does not close this enrolled-host item.
- [ ] Preserve uncertain launch outcomes and late provider IDs without an automatic duplicate paid submission. The in-process tests cover an acknowledgement timeout and one late provider id. They do not close this item for the enrolled host.
- [ ] Finish the host bridge with bounded acknowledgement, immutable inputs, owned process identity and durable terminal evidence. `localAckStarter` can record a local pid. That is not a GPU search and does not close this item.
- [ ] Exercise the packaged positive solved-state API path with the actual enrolled readers, including resumed sessions and replaced resources; rejection-only tests are insufficient. In-process fixtures label solver, chain, and CPU facts as simulated.
- [ ] Verify the full route from stored request through search, CPU-verified solution, sibling drain, signing-bundle export and the current browser recovery screen.
- [ ] Recheck wrong-chain rejection, capability revocation, duplicate requests, wallet changes and existing-job guards in the final composition. In-process `tests/runtime-handoff.test.ts` covers a `testnet4` service guard, a non-mainnet request body, a different wallet session, an idempotency conflict, a second job for the same vault, and `enabled: false` on the capability row. Those tests use `createApp(store, { inProcessHandoff: true })` and do not close this enrolled-host item.

**Acceptance evidence:** joined success and failure/restart scenarios against the actual packaged components and durable backend. Label simulated chain/provider/solver facts explicitly. A process acknowledgement must never count as search success, and a verified hit must never count as whole-range coverage.

Terraform now defines a dormant supervised host and supporting storage, queue, IAM, backup and cleanup resources; see [runtime infrastructure](../terraform/runtime/README.md). Definition of those resources does not close the installation, application-connection or actual-host validation gates below.

The source package and in-process handoff in this branch are reproducible from this checkout. They do not freeze a native release, enroll the optimized supervisor, or authorize mainnet. Do not build `worker/Dockerfile` as the experimental runtime. The experimental build paths are `npm run build:optimized` and `npm run build:runtime`. `broadcastAuthorized` and `release.mainnetEnabled` stay false.

## 3. Select and validate the production execution host

**Status: open for production; isolated native installation passed.** The [24 September x86_64 host validation](runtime-installation/20260924-linux-validation.md) passed pinned installation, encrypted dummy credential delivery and Unix-socket watchdog tests. The host was stopped after evidence collection. Real credential/endpoint enrollment, production configuration alignment and a full provider-backed lifecycle remain open. Local process-identity recovery and a labeled lifecycle rehearsal also run on this checkout's machine. No production host is selected, no image is enrolled, and no runtime credential is provisioned. Local container and process tests do not certify a selected deployment host.

- [ ] Select a host compatible with the reviewed Linux process-ownership, private credential channel, persistent evidence and owned CPU-container requirements.
- [ ] Validate exact runtime paths, immutable preloaded images, execution architecture, restricted child-container permissions and the Docker/host privilege boundary.
- [x] Preserve process/engine identity across recovery. Loss of a local process or directory is not proof that remote GPU work stopped. Evidence: `recordLocalLoss` / `applyLocalLoss` keep `providerId`, `providerOutcome`, `providerSubmissions`, and the bound evidence-directory identity when the local pid is gone or the directory is replaced or missing. `remoteWorkStopProven` stays false, and `submitProviderOnce` is not called again. Terminal evidence already in the store is kept. `tests/host-requirements.test.ts` also kills a real local OS process in `rehearseLocalLifecycle`. This does not prove remote GPU work stopped and does not select a production host.
- [ ] Protect runtime/configuration mounts and evidence directories against replacement or tampering; resolver checks do not replace host permissions.
- [ ] Provision runtime credentials privately through the approved channel. Never place them in browser requests, public configuration, source, logs or issues.
- [ ] Run a real lifecycle check on the selected host, including forced interruption, recovery, deadline handling and evidence availability after shutdown.

**Acceptance evidence:** reviewed host configuration and an actual owned-lifecycle record on that configuration. The current short-lived historical Lambda deployment cannot be assumed to host the longer Linux-owned runtime unchanged; API hosting and search execution may require separate components.

### Public checkout progress (23 September 2026)

`probeLocalHost`, `acceptCredentialReference`, and `rehearseLocalLifecycle` are source-controlled rehearsals. `productionHostSelected` and `certifiesProductionHost` stay false. `release.mainnetEnabled` and `broadcastAuthorized` stay false.

Still open:

- **3.1** Select a Linux host that can own the search process, keep a private credential channel, persist an evidence directory, and run the CPU verifier as an owned container. Record that choice outside this repository. Do not reuse the historical Lambda as that host.
- **3.2** The isolated host record is [the 24 September x86_64 validation](runtime-installation/20260924-linux-validation.md). That host is stopped and is not a selected production host. On a selected host, verify runtime paths and preload the immutable image from `npm run build:optimized` (`worker/optimized/Dockerfile`) and the supervisor from `npm run build:runtime` (`supervised/runtime`). The historical `worker/Dockerfile` is the baseline image and is not that profile. Record architecture plus the image config, index, and registry manifest digests. Keep the child unprivileged and do not mount the Docker socket. The historical `000000000000` ECR reference is not that image. No digest is invented here.
- **3.4** Set host mount permissions on the runtime configuration and evidence directories. `compareDirectoryIdentity` can see a replaced or missing rehearsal directory, and `acceptHostPermissionClaim` rejects resolver and path-string claims, but those checks do not replace host permissions.
- **3.5** Put the runtime secret in the operator secret store and pass only its reference. `acceptCredentialReference` accepts a reference and resolves no secret. Do not place the value in a browser request, public configuration, source, log, or issue.
- **3.6** Repeat forced interruption, recovery, deadline handling, and post-shutdown evidence checks on the selected host and retain that record. The local rehearsal in `tests/host-requirements.test.ts` does not.

## 4. Establish durable storage authority and safe cutover

**Status: local transaction/migration preparation tested; production enforcement remains open.** In-process writer exclusion, supplied-row inventory, permission separation, memory-store migration, and rollback refusal are rehearsed here. Regional IAM and a complete production inventory are not.

- [ ] Complete the inventory of existing commitments, reservations, jobs, provider identities and releases. A partial public exclusion list is not global freshness proof.
- [ ] Technically exclude conflicting legacy writers before enabling the new canonical reservation authority. A frontend flag, capability marker or paused workflow is insufficient.
- [ ] Review separate API, runtime and operator permissions, including required database transactions and evidence access.
- [ ] Validate migration and concurrency against the selected real regional backend and permissions. DynamoDB Local does not certify IAM behavior or a production cutover.
- [x] Preserve one-time commitments, original requests, completed coverage, unknown submissions and cleanup history across migration/restarts. Evidence: `importSnapshot` copies a MemoryStore snapshot into an empty MemoryStore and `preservationFailures` is empty after a second export/import. Consumed commitments, request hashes, `wholeRangeCovered: false`, uncertain provider submissions, cleanup history, reservations, and unclassified rows are retained. Inventory and preservation also keep a `searching` job with no `runpodId`, and a `JOB#` row's top-level `validation.active`, `validation.cancel`, `validation.interrupted`, and positive `validation.completed` counter. A nested `job.validation` object remains a compatibility fallback. `tests/storage-authority.test.ts`. This is not a regional migration; see 4.4.
- [ ] Define a rollback procedure that cannot revive conflicting writers, release consumed commitments or duplicate paid work. The in-process dry-run `rollbackCanonicalAcceptance` sets `canonicalAccepting: false`, leaves `legacyExcluded: true`, and sets `awsLegacyWriterDenied: false`. `localRollbackCoverage().deniesLegacyWriterInAws` stays false. Deleting the authority row or setting `legacyExcluded: false` throws `RollbackWouldReviveWriters`. That dry-run does not deny `dynamodb:PutItem` or `dynamodb:TransactWriteItems` for a deployed legacy writer. The account deny remains 4.2. `tests/storage-authority.test.ts`.

**Acceptance evidence:** complete inventory, reviewed permissions/exclusion controls, migration reconciliation, concurrency tests and rollback rehearsal. Never infer drain or completion from aggregate provider counters alone.

### Public checkout progress (23 September 2026)

`npm run inventory:storage -- snapshot.json` inventories a caller-supplied row export. `globalFreshness` is always false. `assessMigrationBackend("dynamodb-local")` refuses IAM and production-cutover certification.

Still open:

- **4.1** Export the selected regional table without secrets and inventory that file. A partial public exclusion list, including any export from this checkout, is not global freshness proof.
- **4.2** Deny the already deployed legacy writer roles `dynamodb:PutItem` and `dynamodb:TransactWriteItems` before enabling canonical acceptance in that account. This checkout rejects a frontend flag, capability marker, and paused workflow. A reservation transaction that does not write the authority row also conditions on that key being absent, so creating the authority row conflicts with an in-flight legacy write. That still does not stop an old binary whose transactions omit the condition. After `rollbackCanonicalAcceptance` sets `acceptanceStopped: true`, `canonicalAccepting` cannot be set back to true. The pre-acceptance reconciling fence also uses `canonicalAccepting: false` and is reversible. `localRollbackCoverage` records that this dry-run does not perform that AWS deny.
- **4.3** The source model in `permissionModel` separates API, runtime, and operator data, secret, and evidence actions, and canonical reservation writes use a transaction. `productionIamReviewed` and `livePermissionsVerified` stay false. Review the real roles against that model.
- **4.4** Re-run migration and the authority-generation concurrency check with the selected region's IAM. DynamoDB Local does not certify that behavior. MemoryStore concurrency in `tests/storage-authority.test.ts` is only a rehearsal.

## 5. Close final solver and coverage review

**Status: substantial scoped checks and reviews completed; final release acceptance remains open.**

- [ ] Review the arithmetic assumptions and admitted representations for the exact selected generic path, including guarded field helpers, normalization, inversion and point recovery. Record remaining algorithm assumptions explicitly.
- [ ] Confirm complete range partitioning and coverage accounting across batches, retries, pin changes, both subset rounds and session replacement. Coverage from a prior pin must not transfer to a new pin.
- [ ] Preserve exact exceptional-point handling, true DER/hash predicates, host-error checks and output-publication checks in the final build.
- [ ] Ensure deterministic failures and unsupported geometry stop without range credit. The current bounded hit output fails closed beyond its supported capacity; it is not unlimited output support.
- [ ] Tie applicable native tests and independent reviews to the final source/binary. Rerun affected gates after changes rather than attributing predecessor evidence to new bytes.

**Acceptance evidence:** final source-bound review, native regression evidence with stated coverage, and explicit disposition of limitations. Repeating finite vectors cannot establish universal arithmetic correctness. Candidate verification alone cannot detect a solver that silently omitted a valid candidate.

## 6. Run a fresh optimized end-to-end withdrawal

**Status: NOT COMPLETE for the final integrated optimized release.**

- [ ] Create a new browser-generated public request and fresh commitments for a separate disposable proof. Never restart or respend historical completed fixtures.
- [ ] Select a chain-correct proof runner and exact release enrollment. A mainnet-only service configuration must not be relabeled as a regtest runner.
- [ ] Verify request/fixture freshness against the available inventory, retaining the limits of that inventory.
- [ ] Provision only explicitly authorized bounded compute with zero minimum idle workers, a cost/deadline bound and independently functioning cleanup watchdogs.
- [ ] Perform a fresh search with the final pinning/subset/runtime composition. Known-solution replay, synthetic no-hit ranges and mocked success are not substitutes.
- [ ] Independently CPU-verify all solutions and confirm sibling jobs have reached terminal states and the provider queue has drained.
- [ ] Export a public signing bundle bound to the original browser vault, exact request, inputs, outputs, amount and fee.
- [ ] Have the user unlock locally and approve the exact Xverse signature. Only public request/result files leave the browser; backup and passphrase remain private.
- [ ] Validate the exact signed bytes with unmodified Core in the matching controlled chain context and preserve the result.

**Acceptance evidence:** one coherent fresh request-to-search-to-signature-to-Core record for the final release, with no bypassed puzzle checks, no reused fixture and reconciled resource cleanup. Local regtest success closes this controlled proof gate, not the external miner gate below.

## 7. Establish chain-correct external miner inclusion

**Status: NOT COMPLETE.** The earlier regtest transaction sent to a Testnet4 preflight returned missing inputs; that known chain mismatch is not a useful test to repeat.

- [ ] Select a supported external chain and verify wallet, transaction builder, chain provider and miner endpoint agree on it.
- [ ] Create a separate chain-correct fixture and fresh commitments; do not reuse a spent regtest transaction or ask the user to fund an unsupported wallet/app configuration.
- [ ] Obtain concrete authorization for any funding or spend, including the exact transaction, amount and fee before a mainnet broadcast.
- [ ] Complete the relevant fresh search/signing flow and submit through the intended miner transport.
- [ ] Confirm inclusion of the exact transaction independently from chain data and preserve the block/transaction evidence.

**Acceptance evidence:** matching network and input facts, exact authorized signed transaction, miner transport result and independent block confirmation. A successful HTTP response or mempool preflight alone is not inclusion.

Testnet4 is an optional risk-reduction path, **not a mandatory Bitcoin prerequisite**. Direct mainnet testing is a separate explicitly authorized decision; it does not waive the applicable technical gates or authorize an arbitrary transaction. Installed Xverse Testnet4 compatibility has not been established by the existing evidence.

## 8. Review and activate the production release

**Status: NOT APPROVED.** Publishing research source is not deployment or activation.

- [ ] Close the applicable technical gates above and retain a concise independent release decision with limitations and evidence links.
- [ ] Define operational concurrency/cost caps, deadlines, cleanup, alerts, incident handling and safe stop/rollback procedures. Preserve unknown paid outcomes for reconciliation rather than retrying blindly.
- [ ] Regress backup download/reimport, one-time commitments, wallet-change guards and exact signing-intent display on the intended deployed UI/API.
- [ ] Commit and push every deployment change before deployment. Verify deployed source matches the recorded clean commit, including package/image/configuration bindings.
- [ ] Verify actual deployed routes, capabilities, identities and permissions; local builds and source flags are not live-configuration evidence.
- [ ] Enable mainnet functionality only through an explicit reviewed activation. Do not equate enabling a feature with authorization to spend.
- [ ] Require separate exact-transaction authorization for every proposed mainnet spend.

**Acceptance evidence:** pushed release commit, immutable artifact/configuration record, deployment verification, operational runbook and explicit activation decision. No current document grants that decision.

## Recommended work order and dependencies

1. Finish reproducible packaging, host bridge and positive/resumed signing-handoff integration.
2. Freeze and review the joined release; validate the intended host and durable authority/cutover design.
3. Run the new controlled optimized full proof and obtain the user's local exact signature.
4. Run the separately authorized chain-correct external miner proof.
5. Complete production deployment review and explicit activation.

Some source review, host preparation, permissions design and test work can proceed in parallel. A controlled proof does not need production migration to be performed first, but it does need its own reviewed isolated configuration and authority.

The operator supplies configuration, compute, database, watchdogs and private runtime authentication. The user supplies only the new public browser request, local signing approval/public result, and any required exact spend authorization. No step requires sharing a backup, passphrase or recovery secret.

## Evidence and status maintenance

For each closed checkbox, record the relevant source commit/artifact identity, test or review, result, limitations and reviewer. Preserve historical failures and distinguish synthetic data, known-solution replay, fresh search, local Core acceptance and external inclusion.

This checklist captures the currently known release work, not a guarantee that testing cannot reveal another blocker. Add new findings instead of weakening acceptance criteria. Selected upstream notices and licensing boundaries remain in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); the original application license decision is separate from technical mainnet readiness.
