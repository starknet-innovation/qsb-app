# Browser safety check

The `browser-safety` job in `.github/workflows/pull-request.yml` runs every
`tests/*.e2e.ts` spec on every pull request targeting `main`. It uses the exact
Playwright version in `package.json` and `package-lock.json`, installs Chromium,
and starts the application through `playwright.config.ts`'s `webServer`. CI does
not reuse an existing server and rejects focused (`test.only`) tests.

The suite includes local signing and backup reimport, deposit guards, recovery,
and the exact-transaction confirmation dialog. Wallet, provider and submission
calls use local stubs. The CI command additionally blocks new outbound IPv4 and
IPv6 connections, from both Chromium and the API server, while keeping loopback
available. It restores the rules before uploading failure artifacts. It receives
no secrets and never exercises a real miner or funded transaction.

Failures retain an HTML report, screenshots and traces for seven days in the
`browser-safety-failure` artifact. Fixtures use disposable synthetic recovery
material; never run this suite with real wallet backups or credentials.

Repository owner action: add **browser-safety** to the required status checks
alongside **typecheck-and-test** in the `main` branch protection/ruleset. This PR
does not change repository settings.

Local reproduction:

```sh
npm ci --ignore-scripts
npm run vendor
npx --no-install playwright install --with-deps chromium
CI=1 npm run test:e2e
```

Use a free localhost port 5173. The outbound firewall is a Linux CI safeguard;
local reproduction relies on the tests' stubs.

## Mutation evidence (2026-09-25)

All 28 specs passed locally in 30.7 seconds. A temporary mutation added a second
identical `/jobs/:id/submit` API call immediately after the approved POST in
`TransactionDialog.approveSigned`. Running just `explicit exact approval submits
once even with same-tick double click` failed at its request-count assertion:
**Expected: 1, Received: 2**. Playwright produced a trace, screenshot and report.
The mutation was removed; the same test then passed. No mutated application code
is included in this change, and both POSTs in the negative experiment were
intercepted by the test stub.
