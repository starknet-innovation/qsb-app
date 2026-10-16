# Corrected-script fresh withdrawal campaign

Status: **prepared, not authorized to run**. The fresh fixture is funded only in a network-disabled local Core regtest instance; pinning and both subset puzzles remain unsolved. The bounded native qualification run is not a completed search or withdrawal. This plan does not enroll an image, enable mainnet, authorize provider submissions or extend the completed bounded test's spending authorization.

## Bind the campaign before starting

Use one fresh fixture prepared by [the offline harness](README.md), preserving its local Core data, recovery state, exact manifest, public script hash and parameter hashes. Never fund a replacement or reuse a historical solution to shorten the search. Upload only the expressly public fixture/parameter files; the local test recovery and wallet never leave the host.

Freeze the solver source commit, immutable image digest, build flags, CPU-reference identity and binary hashes into the campaign journal. The current native subset binary SHA256 is `673ad624ae1ceba184ed7219abf81641507412134c7bdc4224e3fc9defc5df15`; pinning is `cd70b2c2a7bcf129a9259c494413d5b2995368361e294e7bd284380d58df7a62`. Source-built executable checks do not replace final-image/queue identity validation. Any changed final binary needs its applicable gates rerun.

## Measurements and uncertainty

The bounded corrected-input NVIDIA A10G receipt has SHA256 `6a0c007192905103800084538c46a8b44eae9c5353c09b07331b0c25bd7ce9cb` (`corrected-native.json`, plan hash `1a71aef260042dce7cc819ba9e922e053df1cdaba9657bd6e8b3146d01a7c6ad`). It reports three alternating candidate/baseline samples per round. Each candidate sample processes **268,435,456 ranks** from rank zero, with unchanged predicates and no hits:

| Round | Candidate process wall times | Median | Ranks / median wall second |
| --- | --- | --- | --- |
| 1 | 6.5169, 6.5320, 6.5523 s | 6.5320 s | 41.10 million |
| 2 | 3.8092, 3.8235, 3.8487 s | 3.8235 s | 70.21 million |

These short process wall times include startup/table setup and are **not sustained kernel throughput**. All samples reuse one rank interval; repetitions count as timing samples, not additional unique coverage. The boundary and CPU/GPU differential samples qualify bounded behavior, not an entire domain. The bounded pinning smokes do not establish sustained pinning throughput or expected time to a valid pin.

Each subset domain is `C(150,9) = 82,947,113,349,100` ranks. Mechanically repeating the measured small-process work at the median rates gives this planning scenario:

| Work | Extrapolated single-GPU hours | Compute at $1.123/hour |
| --- | ---: | ---: |
| Entire round-1 domain for one pin | 560.7 | $629.63 |
| Entire round-2 domain for that pin | 328.2 | $368.56 |
| Both domains for that pin | 888.9 | $998.18 |

Formula: `domain / sampleRanks × medianSeconds / 3600`. This is neither a completion-time estimate nor a guaranteed upper cost bound. Longer chunks may amortize startup; throttling, failures and different fixture alignment may worsen rates. The price is the preflight quote for Linux shared `g5.xlarge` in `eu-west-1`; revalidate it before any new allocation. EBS, transfer, control-plane costs and billable idle time are excluded from the table.

A complete subset domain can contain no valid solution. Exhausting either required domain may require a new pin and new subset context; previous-pin coverage cannot be credited to it. Success can also occur before domain exhaustion. No validated success-probability model or confidence bound is established, so do not describe half a domain as the expected work or these figures as a guaranteed budget. Pinning, retries after reconciled provider failures, and pin restarts are additional. A 25-minute single-GPU window covers only about 0.074% of round 1 or 0.127% of round 2 at the short-sample rates, excluding pinning.

## Proposed staged authorization

Request approval for an initial **24 aggregate GPU-hour campaign cap**, **one GPU at a time**, with a corresponding **$26.96 compute ceiling at the quoted rate**. This is a bounded search attempt, not a promise to finish. Keep the cap inclusive of the calibration phase and billed GPU startup/idle time; reserve time for shutdown before admitting a new chunk. Establish a separate explicit storage/control-plane cap before launch; the compute figure is not an all-in bill. The old application per-job limit does not authorize this campaign.

1. Within the first **one aggregate GPU-hour**, measure repeated longer ranges on the fresh public context: several rank counts, alternating order and separate startup/sustained slopes. Measure pinning as well as both subset stages; subset calibration uses a declared parameter context and cannot claim a solved pin. Pinning/subset probes not matching the eventual verified context do not receive proof coverage credit. Check final-image transport identity and CPU verification. Stop if measurements, exact range accounting or runtime identity are inconsistent.
2. Spend the remaining approved envelope on genuine pinning until a valid hit is CPU verified. Export both subset parameter sets from that exact pin and fresh manifest. Search round 1 then round 2, stopping each stage only on a CPU-verified hit or exact exhaustion. Preserve completed ranges and all submission identities across bounded worker leases. Do not lower predicates to meet the time cap.
3. At the cap, cancel/drain known active work, reconcile uncertain outcomes, delete allocated compute and preserve the fixture and journal. Report measured rates, unique verified coverage, pin/solution state, actual billed/estimated cost and a revised next envelope. Extending the cap or increasing concurrency requires a new concrete authorization; do not automatically provision another campaign.
4. If all three puzzles solve within the envelope, drain siblings first, then run the local `verify` command. It signs the disposable helper and asks unmodified Core to mine the exact withdrawal into the offline chain. Save block/transaction proof and a reproducible manifest binding it to the solver, CPU reference and source. This remains offline consensus evidence; external-miner inclusion and actual user-wallet signing are separate gates.

Use explicit per-allocation deletion deadlines and an independent watchdog. Never blindly resubmit a paid intent or credit aggregate provider counters as range completion. Deterministic errors fail closed; unknown outcomes block replacement until reconciled. Stop on budget exhaustion, ownership loss, missing heartbeat, CPU disagreement, output overflow, parameter/image mismatch or unavailable durable accounting. No production service or completed proof endpoint is restarted by this plan.
