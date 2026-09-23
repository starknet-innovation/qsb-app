## Deployment rule

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

## Research boundaries

Keep mainnet operations disabled until the documented release gates and exact transaction authorization are satisfied. Never upload wallet backups, passphrases, private recovery material, credentials, or operator runtime files. Do not treat historical replay, local Core acceptance, or component benchmarks as fresh end-to-end or external-miner certification.
