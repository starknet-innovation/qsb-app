# Execute the authorized one-instance experiment

This controller complements the image from merged PR #43. `prepare` creates an
SSM-only instance profile, an ingress-free security group, and narrowly scoped
cleanup roles. `arm` deploys the committed Lambda bytes and verifies a Scheduler
invocation at a fixed deadline 55 minutes later. The Lambda's IAM permission can
terminate only instances carrying this run's unique token. `launch` requires the
verified schedule, effective quota, a clean pushed controller commit, and no
previous launch intent. A guest timer uses the same absolute deadline. Neither
mechanism guarantees AWS control-plane latency, so the operator explicitly
terminates and verifies deletion as soon as the result is captured.

Use an external state file and run modes in order. Never delete state to relaunch.
AWS mutation retries are disabled. Any uncertain response requires reconciliation
by token before proceeding. Infrastructure creation failures also require manual
reconciliation from the saved resource prefix. `cleanup` verifies all recorded
volume IDs are absent before removing the guard. Save volume IDs immediately
after EC2 attaches the root disk.

Transfer the reviewed image and host.sh using SSH through Session Manager with
a disposable operator-local key and pinned host key. No inbound port is opened.
Check the image archive and host script hashes independently before execution.
The latest reviewed image runs twelve two-size synthetic probes, within the same
30-minute wrapper and single-instance budget; no full withdrawal is attempted.
The host script uses a durable one-shot marker to reject execution retries.

The controller commit and image build commit are separate identities. Record
both, the image digest, verified live price, AMI, raw outputs and final cloud
cleanup. This is a one-off experiment, not production activation.

If measured SSM throughput cannot fit the image inside the deadline, `transfer.py`
uses a fresh private encrypted S3 bucket with TLS required. The host role gains
GetObject on exactly the image object; it receives no bucket listing, writing,
application access, presigned URL or operator credentials. Check the trusted
archive hash after download. Delete the object and bucket during cleanup.
