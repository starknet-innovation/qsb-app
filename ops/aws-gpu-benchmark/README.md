# Isolated AWS A10G benchmark

This benchmark answers whether the current optimized subset source runs correctly
on A10G and measures fixed-range wall-clock throughput. It does not activate the
application, submit a transaction, enroll a solver release, or establish the cost
of a complete search/withdrawal.

The source remains verified against `worker/optimized/source-lock.json`. Only
the benchmark build's CUDA target changes from sm89 to sm86. The production
Dockerfile, lock, descriptors and solver flags remain unchanged. The resulting
binary has its own receipt and `BENCHMARK_ONLY` status. Build on native Linux
without a GPU using `aws-gpu-benchmark-build.yml` (no AWS credentials). The same
recipe supports CUDA_ARCH=89 for a later matched comparison.

The fixture uses public deterministic seed 20260925, invented funding outpoints,
and no funded wallet. Private intermediate setup material is confined to a
temporary directory and discarded. Only public parameters are packaged. A
first-stage GPU SHA audit compares results with OpenSSL; the subset runs use
both rounds, three repetitions each, 2^24 ranks per repetition, a 180-second
per-process timeout, and CPU verification of any candidates. Completion requires
the native range summary to report the exact count; a timeout earns no throughput
credit. Rates include process startup and initialization. No observed candidates
would mean candidate verification was not exercised.

## Authorized initial experiment

- Account/profile: operator supplies `snf`; region `eu-west-1`.
- One On-Demand `g5.xlarge`, one A10G, x86_64. No Spot retries or fallback types.
- Four G/VT vCPUs are sufficient; wait for the approved quota and recheck the
  effective quota before attempting a launch.
- Maximum one instance and 60 minutes from launch to termination, including setup.
- Launch requires current price verification, clean pushed source, a matching
  successful build artifact, and an independent AWS-side termination schedule.
- Use an instance role restricted to the benchmark artifact/result prefix; no
  application database, provider secret, wallet data, or GitHub token access.
- No inbound ports; SSM access only. IMDSv2 required. Encrypted temporary EBS
  deleted on termination. Pin the selected GPU AMI ID and artifact checksums.
- Run the container with `--gpus all --network none --read-only --cap-drop ALL`
  and writable `/tmp` and `/results`. Set the host wrapper timeout to 30 minutes.
  Upload results before shutdown; independently verify EC2 termination and disk
  deletion. A timeout or CUDA failure is a failed probe, not a completed range.

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
