## Current goal and plan

The goal is a working mainnet withdrawal without production-grade hardening. Tracking issue #8 is the plan. Its steps are separate issues, done in order.

- **Pick work only from #8.** Open one PR per plan step and put `Closes #N` in the PR body.
- **Check the step's dependencies first.** Don't start a step while any of them is still open.
- **Meet the issue exactly.** Satisfy every Scope and Acceptance item, including any added in the issue's comments.
- **Don't open off-plan PRs.** #26 and #29 were closed for being off-plan. If a change seems necessary but isn't in the plan, say so in a comment on #8 instead of opening a PR.

## Decisions already made

Don't reopen these in code or PRs.

- **One pipeline.** The Step Functions coordinator is the single mainnet pipeline (#9). The supervised stacks (the in-process handoff and the deployed Lambda → queue → host path) are parked. Don't change them, except to remove them under #23.
- **Solver release.** The historical worker is built from `worker/Dockerfile` in `starknet-innovation/qsb-solver`; its attested image digest and repository commit are enrolled in a new descriptor in `src/lib/releases` (#15, #35). Keep `qsb-config-a-ranked-v2.json` byte-identical. The solver is chosen at withdrawal, from the releases compatible with the vault's protocol. A deposit is never bound to one solver.
- **One deposit per vault.** Never offer a way to deposit into an existing vault. Payments to a vault's script from outside the app are flagged and never spent (#16, #27).
- **No test chains.** The first end-to-end run is on mainnet with a small deposit (#22). Before submit, an offline consensus check runs Bitcoin Core's script interpreter on the exact signed transaction (#20).

## Keep

These are the funds-safety invariants:

- Keys, passphrases and one-time material stay in the browser.
- Job creation writes outpoint reservations atomically (`attribute_not_exists`).
- A paid provider submission is never resubmitted. An unknown outcome is reconciled by an operator.
- The CPU re-checks every GPU hit.
- The exact-spend check binds the inputs, the single output's script, the amount and the fee.
- The GPU spend caps stay in place.

## Avoid

- **Gates that can only stay false.** Instead, add one real code path behind one explicit switch.
- **Hand-pinned self-hashes, digest literals and new duplicate copies of source files.** Derive values from the source of truth instead.
- **Library code that nothing calls, and work on parked components.**

## Reviews and merges

- **Automatic review.** Every PR on a `cursor/` branch is reviewed automatically. Review threads can't be replied to from here, so address findings with new commits and one PR comment that lists what changed.
- **Merging.** A PR is merged, and its issue closed, only when all of these hold:
  - the review finds zero defects;
  - the PR implements a plan step with every acceptance item met;
  - it targets `main`;
  - CI passes;
  - no review threads are open.
- **Mainnet switch.** Any change that turns on `release.mainnetEnabled` or `broadcastAuthorized`, or that implements #22, needs the user's explicit approval before it's merged.

## Deployment rule

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

## Research boundaries

Keep mainnet operations disabled until #22 is reached with the user's explicit approval. The user must authorize the exact transaction, amount and fee before any mainnet submit. Never upload wallet backups, passphrases, private recovery material, credentials, or operator runtime files. Do not treat historical replay, local Core acceptance, or component benchmarks as fresh end-to-end or external-miner certification.
