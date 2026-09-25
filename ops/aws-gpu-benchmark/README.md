# Isolated AWS A10G benchmark

This benchmark answers whether the current optimized subset source runs correctly
on A10G and measures fixed-range wall-clock throughput. It does not activate the
application, submit a transaction, enroll a solver release, or establish the cost
of a complete search/withdrawal.

The source is verified against a benchmark manifest generated from a clean Git
checkout by `manifest.py`. The receipt records the commit and deviations from
the historical `worker/optimized/source-lock.json`; current main includes ranked
range failure checks absent from that lock. Build flags come from the historical
lock, with only the CUDA target changed from sm89 to sm86. The production
Dockerfile, lock, descriptors and solver flags remain unchanged. The resulting
binary has its own receipt and `BENCHMARK_ONLY` status. Build on native Linux
without a GPU using `aws-gpu-benchmark-build.yml` (no AWS credentials). The same
recipe supports CUDA_ARCH=89 for a later matched comparison.

The fixture uses public deterministic seed 20260925, invented funding outpoints,
and no funded wallet. Private intermediate setup material is confined to a
temporary directory and discarded. Only public parameters are packaged. A
first-stage GPU SHA audit compares results with OpenSSL; the subset runs use
both rounds, three alternating repetitions of each fixed size (2^26 and 2^30
ranks), a 120-second per-process timeout, and CPU verification of any candidates.
The 12 probes plus the 120-second SHA audit have at most 26 minutes of process
timeouts, inside the independent 30-minute host wrapper. Completion requires
the native range summary to report the exact count; a timeout earns no throughput
credit. Raw rates include process startup and initialization. `model.py` fits each round
using the median wall time at each size: slope = (large time - small time) /
(large ranks - small ranks); intercept = small time - slope * small ranks. It
reports the startup intercept, reciprocal steady rate, and **extrapolated**
2^34-rank attempt time = intercept + slope * 2^34. Compute-only cost is that time
multiplied by the operator's verified current hourly USD price / 3600, supplied
as `--hourly-usd`. There is no hardcoded AWS/Runpod price or cost comparison.

Missing/duplicate probes, nonfinite/nonpositive observations, nonpositive slopes
or negative startup intercepts refuse the model and publish no cost. A probe
failure/timeout leaves only a `running` partial report, with no model. An invalid
fit leaves `invalid-model`, never `completed`. Extrapolation is not a measurement
of a full attempt, full search, bill or withdrawal; startup means per-process
initialization, not EC2 boot. Boot, setup, idle, EBS and transfer remain separate.
No observed candidates would mean candidate verification was not exercised.

## Authorized initial experiment

- Account/profile: operator supplies `snf`; region `eu-west-1`.
- One On-Demand `g5.xlarge`, one A10G, x86_64. No Spot retries or fallback types.
- Four G/VT vCPUs are sufficient; wait for the approved quota and recheck the
  effective quota before attempting a launch.
- Maximum one instance; target termination within 60 minutes including setup.
  Boot shutdown is armed for 55 minutes after boot. An independent schedule
  requests termination during minute 59 after launch. AWS scheduling, guest boot
  and termination latency mean this is **not a guaranteed hard billing ceiling**.
- Launch requires current price verification, clean pushed source, a matching
  successful build artifact, the reviewed instance profile and operator access
  to create and verify cleanup immediately after launch. Do not do setup first.
- The dedicated instance role has exactly `instance-policy.json` as inline policy
  `qsb-benchmark-session-only`, with no attached policies. The launcher checks
  this before paying for an instance. It permits only SSM instance registration
  and Session Manager channels, explicitly denying every other AWS action.
  SSM uses temporary AWS role credentials; the host is not literally credential
  free. No application/provider/static credentials, artifact S3 grants, database,
  wallet data or GitHub token are installed. The offline container receives no
  host credential files/environment or metadata networking.
- No inbound ports; SSM access only. IMDSv2 required. Encrypted temporary EBS
  deleted on termination. Pin the selected GPU AMI ID and artifact checksums.
- Run the container with `--gpus all --network none --read-only --cap-drop ALL`
  and writable `/tmp` and `/results`. Set the host wrapper timeout to 30 minutes.
  Upload results before shutdown; independently verify EC2 termination and disk
  deletion. A timeout or CUDA failure is a failed probe, not a completed range.

## Ordered launch and cleanup procedure

This PR does not launch anything. Following these steps requires separate launch
authorization. Do not use the application's GitHub deployment role. An operator
prepares a dedicated EC2-trusted instance profile containing only the checked-in
SSM policy, a reviewed SSM-agent GPU AMI, subnet and ingress-free security group.
Use a current SSM agent supporting `ssmmessages`; this minimal profile does not
support legacy `ec2messages`, S3 session logs, Patch Manager or artifact downloads.
Transfer the public image/results through the operator-controlled SSM session;
no presigned credential URLs or cloud credentials enter the container.

1. Verify quota, one-instance capacity, current hourly compute price, pushed clean
   commit and downloaded build checksums. Prepare a private JSON launch config
   with `account`, `region` (`eu-west-1`), `ami`, `subnet`, `securityGroup`, and
   `instanceProfile`. It contains identifiers, no credentials. The AMI must have
   one x86_64 EBS root device; the launch requests encrypted 80-GiB gp3 storage
   with deletion on termination. Keep the config and receipt outside Git.
2. When authorized, run:

   ```sh
   python3 ops/aws-gpu-benchmark/launch.py --profile snf \
     --config /private/path/benchmark-launch.json \
     --receipt /private/path/benchmark-launch-receipt.json --execute
   ```

   It persists a client-token intent before the single `run-instances` request,
   sets `InstanceInitiatedShutdownBehavior=terminate`, and supplies boot user data
   whose first action is `shutdown -h +55` (immediate shutdown if arming fails).
   IMDSv2 is required with hop limit 1. There is no setup in user data.
   A failed/uncertain launch is not retried: reconcile the persisted client token.
3. Immediately after receiving the exact instance ID, the same controller checks
   the shutdown behavior and user data, creates a new Scheduler execution role
   granting only `ec2:TerminateInstances` on that instance ARN, and reads the
   policy back. Trust is restricted to Scheduler in this account/default group.
   It creates `at(launch+59 minutes)` rounded down to the minute, UTC, window OFF,
   target `arn:aws:scheduler:::aws-sdk:ec2:terminateInstances`, input containing
   only that instance ID, no retries, and delete-after-completion. It reads and
   compares time, state, window, target, role and input. Enrollment taking more
   than two minutes or any mismatch/error triggers immediate exact-instance
   termination and fails before setup. AWS subprocess calls are bounded to 20s.
   If termination fails too, the receipt retains the ID for urgent reconciliation.
4. Only after `cleanup-enrolled`, use SSM to verify
   `test -f /run/qsb-shutdown-armed` and `shutdown --show` on the host. If either
   fails, immediately terminate from the independent operator session. The
   launcher does not claim that checking user data proves the boot script ran.
   Then load the verified image and run under the host timeout:

   ```sh
   timeout --signal=TERM --kill-after=10s 30m docker run --rm --gpus all \
     --network none --read-only --cap-drop ALL \
     --tmpfs /tmp:rw,nosuid,nodev --mount type=bind,src=/results,dst=/results \
     qsb-aws-benchmark:sm86 --hourly-usd VERIFIED_LIVE_HOURLY_USD
   ```

   Use a fresh empty `/results`. Do not mount home directories, Docker sockets,
   credentials or `/var/run` into the container. Capture public results before
   teardown. A timed-out process never earns a completed-range result.
5. On completion or any failure, explicitly run `aws ec2 terminate-instances
   --instance-ids INSTANCE_ID` with the same profile/region, then `aws ec2 wait
   instance-terminated --instance-ids INSTANCE_ID`. Query the recorded attached
   volume IDs with `describe-volumes` until they are absent. Verify termination
   independently even after the guest or Scheduler reports success. Delete any
   remaining schedule and the exact cleanup inline policy/role **after** confirmed
   termination; failed enrollment may leave those IAM resources for reconciliation.
   Do not remove the independent schedule while the instance can still bill.

A controller crash between launch and schedule enrollment remains bounded only
by guest boot/shutdown, which itself can fail. Keep independent operator oversight;
these two mechanisms reduce exposure but cannot guarantee a precise billing cap.
Local tests inject AWS calls; actual IAM/SSM/boot/Scheduler delivery is untested.

Verified against official AWS documentation on 25 September 2026:
[RunInstances fields](https://docs.aws.amazon.com/cli/latest/reference/ec2/run-instances.html),
[shutdown termination](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Using_ChangingInstanceInitiatedShutdownBehavior.html),
[Scheduler universal targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html),
[one-time schedules and 60-second precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html),
[CreateSchedule](https://docs.aws.amazon.com/cli/latest/reference/scheduler/create-schedule.html),
[Scheduler role trust](https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html),
and [Session Manager instance permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-instance-profile.html).

The quota request itself is not a launch. Do not expand the GitHub application
role to EC2/Batch for this isolated experiment. Any subsequent Batch migration
requires a scoped IAM and Terraform change after evaluating this result.

## Comparison evidence

Keep the source commit, full build receipt, image checksum, driver/GPU identity,
fixture hashes, raw range logs, CPU-check results and wall times. Compare AWS and
Runpod using identical public fixtures, ranges and source, while recording the
architecture-specific binary identities. Include startup, storage and transfer
costs when estimating economics. Do not compare an A10G subset microbenchmark to
an unrelated historical GPU's end-to-end latency.
