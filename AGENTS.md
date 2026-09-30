## Decisions already made

Don't reopen these in code or PRs.

- **One pipeline.** The Step Functions coordinator is the single mainnet pipeline (#9). The supervised stacks (the in-process handoff and the deployed Lambda → queue → host path) were removed under #23. QSB deploys on mainnet only.
- **Solver release.** Solver images are built and attested in `starknet-innovation/qsb-solver` and enrolled verbatim as descriptors in `src/lib/releases` (#15, #35). Never edit an enrolled descriptor; keep `qsb-config-a-ranked-v2.json` byte-identical. A withdrawal pins the release the deployment serves (`SOLVER_RELEASE_ID`) when it's created. A deposit is never bound to one solver.
- **GPUs on AWS Batch.** Runpod is neither the default nor a fallback.
- **One deposit per vault.** Never offer a way to deposit into an existing vault (#16). Payments to a vault's script from outside the app are never spent, and the app offers no way to recover them (#27).
- **No test chains.** Testing happens on mainnet with small deposits (#22). Before submit, an offline consensus check runs Bitcoin Core's script interpreter on the exact signed transaction (#20).

## Keep

These are the funds-safety invariants:

- Keys, passphrases and one-time material stay on the user's machine (browser, SDK or CLI) and never reach any request body, except the HORS preimages a signed withdrawal reveals by design.
- Job creation writes outpoint reservations atomically (`attribute_not_exists`).
- A paid provider submission is never resubmitted. An unknown outcome is reconciled by an operator.
- The CPU re-checks every GPU hit.
- The exact-spend check binds the inputs, the single output's script, the amount and the fee.
- The GPU spend caps stay in place.

## Avoid

- **Gates that can only stay false.** Instead, add one real code path behind one explicit switch.
- **Hand-pinned self-hashes, digest literals and new duplicate copies of source files.** Derive values from the source of truth instead.
- **Library code that nothing calls, and work on parked components.**
- **History in docs.** Docs describe the current state: no superseded snapshots, notes about what a merged PR changed, or descriptions of removed code. History lives in git and the issues.

## Reviews and merges

- **Review before opening.** Before opening a PR, have a new subagent review the whole diff against `main` from scratch. Give it the diff and this file, not the session's reasoning. It checks the diff for correctness and against every rule in this file. Fix what it finds and review again with another new subagent until one finds nothing, then open the PR.
- **Copilot review.** Request a Copilot review when you open the PR and again after each push (`gh pr edit <n> --add-reviewer @copilot`). Reply on each finding's thread with the commit that fixes it, or why no change is needed, then resolve the thread. Answer findings that appear only in the review body in one PR comment.
- **Docs.** Every PR updates the docs its change affects, in the same PR: the README files and `docs/`. If it changes who holds a key, passphrase or credential, or what the service receives, update `docs/KEY-CUSTODY.md`, edit `docs/key-custody.html` to match, and re-render `docs/key-custody.png` with the command at the top of that file. If you can't run a browser, still update the text and say in the PR description that the diagram is out of date.
- **Merging.** A PR is merged, closing its issue if it has one, only when all of these hold:
  - Copilot's latest review is of the head commit and finds zero defects (a finding answered with why no change is needed isn't one);
  - if it closes an issue, every acceptance item in that issue is met;
  - it targets `main`;
  - CI passes;
  - no review thread is unresolved.
- **Mainnet switch.** Any change that turns on `mainnet_enabled`, `exact_submit_enabled`, `QSB_MAINNET_ENABLED`, `QSB_EXACT_SUBMIT_ENABLED`, `release.mainnetEnabled` or `broadcastAuthorized` (including changing an off default) needs the user's explicit approval before it's merged.

## Deployment rule

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

## Research boundaries

The mainnet switches change only with the user's explicit approval (see **Mainnet switch**). The user must authorize the exact transaction, amount and fee before any mainnet submit. Never upload wallet backups, passphrases, private recovery material, credentials, or operator runtime files. Don't present replays, local Core acceptance or component benchmarks as end-to-end evidence.
