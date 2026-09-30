# Browser safety check

The `browser-safety` job in `.github/workflows/pull-request.yml` runs every
`tests/*.e2e.ts` spec on every pull request targeting `main`. It uses the exact
Playwright version in `package.json` and `package-lock.json`, installs Chromium,
and starts the application through `playwright.config.ts`'s `webServer`. CI does
not reuse an existing server and rejects focused (`test.only`) tests.

The suite includes local signing and backup reimport, deposit guards, recovery,
and the exact-transaction confirmation dialog. Wallet, provider and submission
calls use local stubs. Chromium uses a non-listening loopback proxy for external
origins (bypassing localhost), so optional fonts fail promptly without DNS
timeouts. The CI command additionally blocks new outbound IPv4 and
IPv6 connections, from both Chromium and the API server, while keeping loopback
available. It restores the rules before uploading failure artifacts. It receives
no secrets and never exercises a real miner or funded transaction.

Failures retain an HTML report, screenshots and traces for seven days in the
`browser-safety-failure` artifact. Fixtures use disposable synthetic recovery
material; never run this suite with real wallet backups or credentials.

None of the pull-request checks (**typecheck**, **unit-tests**, **terraform**,
**terraform-selected-solver** and **browser-safety**) is a required status check on
`main` today; making them required is a repository setting for the owner.

Local reproduction:

```sh
npm ci --ignore-scripts
npm run vendor
npx --no-install playwright install --with-deps chromium
CI=1 npm run test:e2e
```

Use a free localhost port 5173. The outbound firewall is a Linux CI safeguard;
local reproduction also has the browser proxy guard and the tests' stubs.
