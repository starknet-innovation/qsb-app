# Fresh corrected offline Core qualification

`fresh-core-proof.py` creates a new, locally funded **offline regtest** fixture using disposable test-only keys. This is a solver qualification harness, not a test-chain application deployment. It cannot operate outside a network-disabled Docker container, starts its own unmodified Core child, requires its live PID before RPC, and exclusively locks its proof directory. It does not read user recovery material or use an existing app vault.

Mount the checked-out app at `/app` read-only, a **new empty** private directory at `/proof`, and a separately verified official Bitcoin Core distribution at `/bitcoin` read-only. Run a Python image by immutable digest with `--network none --read-only --tmpfs /tmp`. The command inside the container is:

```
python /app/ops/qualification/fresh-core-proof.py prepare
```

Keep the complete `/proof` directory local and excluded from Git. Its `recovery.json` and Core wallet are disposable local test material and must never be uploaded. Only `public-fixture.json` and `export-pinning.json` are public compute inputs. The exporter uses the corrected script and full production Config A predicates; no difficulty substitution or historical solution is used. A new UUID/directory is not a substitute for this fresh random fixture.

Search the exported pinning parameters using the qualified candidate image. Persist paid submission identities and range coverage before any submission. Store the CPU-verified pin as `solution.json` with `sequence` and `locktime`, then invoke `export-round1` and `export-round2` in the same isolated container. These commands independently recheck the pin and emit public `export-round1.json`/`export-round2.json` bound to the funded transaction context. The proof directory and original inputs must be preserved across bounded compute sessions; never repeat `prepare` to retry a range.

After both full-predicate subset searches succeed, add `round1` and `round2` arrays to `solution.json` in **CPU/HORS index order**, not raw reversed GPU order. Run `verify`. It rechecks all three puzzles with the CPU reference, checks both live fixture UTXOs, locally assembles the corrected witness, signs only the disposable wallet helper and passes the exact transaction to Core's `generateblock`. Core enforces all consensus predicates unchanged. A journal is written before mining; if interrupted, inspect that exact transaction/block locally instead of repeating verification blindly. An existing completion or attempt marker refuses replay.

`verified-withdrawal.json` is produced only after block inclusion. This proves a fresh full-predicate offline Core withdrawal, **not** external miner inclusion, Xverse signing, mainnet activation or post-quantum security. No image is qualified merely by fixture preparation. Record the exact solver image, binaries, range receipts, CPU verdicts and source revision with any eventual proof receipt.

## Compute planning

Each subset domain contains `C(150,9) = 82,947,113,349,100` candidates. Historical RTX4090 queue measurements of 2,704,928,748 ranks in 21.5073 seconds (round 1) and 12.8413 seconds (round 2) imply about 183.2 and 109.4 GPU-hours for complete respective domains **per pin**. Those are historical estimates, not measurements of the corrected image or another GPU model. Pinning, startup, restarts after exhausted subsets and provider failures add work. A bounded 25-minute test cannot promise a completed fresh proof. Measure corrected-image throughput first and obtain a concrete campaign cost/time budget before a long search; a prior per-job software cap is not a new spending authorization.
