# Supervised dispatcher connection

Implemented application path:

`authenticated create → atomic JOB + outbox → scheduled publisher → FIFO SQS → one-shot host consumer → dispatch/admission/host claim → sealed Linux supervisor`

`dispatch/routes.ts` retains authenticated owner, public transaction/chain checks, reservation authority and capability fencing. The browser cannot supply a command or launch a process. The Lambda entry installs this route with `SUPERVISED_EXECUTION_ENABLED=false` by default. Legacy routes retain their existing default behavior.

Job creation and its notification commit together. The publisher waits for an operator-created `OWNER#<owner>/DISPATCH_CONFIG#<jobId>` row with version >=1, enabled=true, matching immutable jobHash and validated runtime config. That row has no browser/API write route; existing broad API database IAM is not a separate security boundary against compromised application code. Queue messages contain only owner, job ID and creation hash. They are hints, not authorization.

The publisher records a sent receipt before deleting pending notification. Lost SQS acknowledgements can cause delivery duplicates, not direct GPU submissions. The consumer rereads job, capability, reservations and configuration; atomically claims the invocation plus ticket binding before its one-shot launch callback. The host rereads and fences admission/authority before its own durable spawn claim. Unknown outcomes block relaunch. Duplicate invocation delivery adds an explicit `SYSTEM#QSB_DISPATCH_RECONCILE` record; it does **not** automatically restart a possibly running or never-started process. Operators must reconcile that record and provider/host evidence before choosing a successor. DLQ redrive is not paid-work authorization.

Build with `node supervised/build.mjs`. This creates `dist/dispatcher.cjs`, `host.py` and a file-hash manifest. `node terraform/scripts/build.mjs` incorporates these artifacts into the clean-commit release manifest and optional runtime S3 release objects. The publisher Lambda and schedule are included in Terraform but disabled. No automatic runtime installation, activation or paid work occurs.

The consumer runs once, handles at most one queue message, waits for its owned host child, and never reuses a credential pipe. It expects protected `/etc/qsb/host.json`, `/source`, `/evidence`, and a fresh inherited FIFO on fd 3. `dispatch/qsb-dispatch.service` is an inactive unit template, **not a complete credential broker**: ordinary systemctl start cannot supply that descriptor. Do not enable an unattended restart loop. No key belongs in SQS, user data, Terraform state, argv or logs. The process environment passed to the sealed host excludes inherited secrets and uses its host role for AWS access.

## Validation and remaining live gate

Local tests compose the actual public create, dispatch, admission and host-claim functions with synthetic unfunded public metadata. They exercise competing consumers, lost launch acknowledgement, configuration/capability changes, outbox transaction failure, queue acknowledgement loss, restart replay, publication crash and dormant-ticket fairness. Chain validation and the process-launch acknowledgement are mocked in that composed test; it is not consensus, real Linux process-launch or AWS certification. Host tests cover immutable evidence, registry bounds, private-pipe single use, process identity parsing and output limits.

This finishes the source connection, not a deployable mainnet activation:

- The historical sealed runtime distribution is not installed by this package. It still pins `eu-west-1` and `QsbYukonIsolated*`, whereas Terraform's generic app table has a different name. A reviewed successor must align these identities; silently renaming a live table would be unsafe.
- The sanitized service archive deliberately uses an unenrolled image registry. Actual immutable image/CPU/runtime identities, private FIFO provisioning and watchdog socket enrollment remain required. The periodic cleanup Lambda does not replace the runtime's watchdog protocol.
- Successful launch and crash/restart behavior of this final composed package on the intended Linux host must be demonstrated before activation. Child exit is not provider drain or search completion.
- Verified result publication/evidence export, full fresh optimized proof and external miner gates remain on the mainnet readiness checklist.

Historical spent proofs and disabled endpoints are untouched. No transaction broadcasting is provided by this dispatcher.
