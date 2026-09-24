# Fixed Linux host bridge

`createHostLauncher(store, credentialFd)` returns the one-shot launch callback for an existing durable invocation. It reads the current application job, admission, capability, input reservations and trusted host registry; claims `V5_HOST_LAUNCH` atomically before spawning. No uploaded command, path or credential is accepted.

A launcher consumes exactly one privately supplied FIFO assignment. It never reads its bytes. The FIFO inode/device must still match at launch. New jobs require new independently owned credential pipes and launcher instances. Request data is snapshotted before asynchronous work. Protected read-only `/source` and code mounts, an owned `/evidence` mount, and the reviewed Linux binaries remain mandatory host assumptions.

The host registry retains the explicit `eu-west-1`, `QsbYukonIsolated*` table and historical sealed distribution manifest restrictions. The public service archive's deliberately unenrolled registry placeholder is incompatible with a real deployment until reviewed enrollment is supplied. This bridge does not silently rewrite those identities or install the sealed distribution. Terraform's generic table naming alone does not satisfy the guard.

The wrapper reports an actual owned Linux PID/start-time/process-group identity. The parent validates `/proc` without splitting the command name on spaces. Identity acknowledgement has a 10-second deadline. Timeout preserves an unknown outcome and leaves observers attached for late evidence; it never launches a replacement. Total child output is capped at 16 KiB. Terminal child evidence means that direct child was reaped, never provider cleanup, full process-tree drain or completed search. Independent enrolled GPU cleanup watchdogs remain required.

The source successor fixes invalid registry version acceptance and partial immutable-claim comparisons from the research draft. Evidence attaches only to the complete unchanged claim. Paths and code need protection from privileged replacement; source hashes alone do not provide OS isolation.

Run `npx tsx supervised/host/test.ts` and `npx tsc --noEmit -p supervised/host/tsconfig.json`. Local controls cover invalid registry bounds, exact evidence binding/idempotency, late terminal evidence after unknown acknowledgement, one-use pipe assignment, `/proc` command names and aggregate output limits. They do not launch the actual Linux host, access cloud services or certify the full final stack. Live host composition and final deployment authorization remain separate gates.
