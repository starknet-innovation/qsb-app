import { test, expect, type Page } from "@playwright/test";
// App-level status and vault rows with a mocked wallet and API. Nothing signs or broadcasts.
async function mount(page: Page, switches: { operationsEnabled: boolean; exactSubmitEnabled: boolean }) {
  await page.addInitScript((switches) => {
    const address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const vault = (id: string, name: string, status: string, value?: string) => ({
      id, name, status, createdAt: "2026-09-30T09:00:00.000Z", network: "mainnet", config: "A",
      scriptHex: "51".repeat(100), scriptHash: "aa".repeat(32), publicStateJson: "{}", paymentAddress: address,
      ...(value ? { funding: { txid: "1a".repeat(32), vout: 0, value } } : {}),
    });
    const vaults = [
      vault("aaaaaaaa-1111-4111-8111-111111111111", "Savings", "confirmed", "100000"),
      vault("bbbbbbbb-2222-4222-8222-222222222222", "Travel fund", "submitted", "50000"),
      vault("cccccccc-3333-4333-8333-333333333333", "Emergency", "unfunded"),
    ];
    const jobs = [{
      id: "e1e1e1e1-5555-4555-8555-555555555555", vaultId: vaults[0].id, owner: address, status: "awaiting_authorization",
      stage: "verification", computeSeconds: 5400, attempt: 1, revision: 1, manifestHash: "ab".repeat(32),
      createdAt: "2026-09-30T09:00:00.000Z", updatedAt: "2026-09-30T09:00:00.000Z",
      manifest: { destination: address, outputValue: "92083", fee: "9366" },
    }];
    Object.assign(window, { appFixture: { address, vaults, jobs, switches }, apiCalls: [] });
  }, switches);
  await page.route("**/src/lib/api.ts*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
import { release } from "/src/lib/model.ts";
export function readSessionEpoch(){return 0;} export function readSessionToken(){return '';}
export function clearSession(){} export async function authenticate(){}
export async function api(path){
  const f = window.appFixture; window.apiCalls.push(path);
  if (path==='/config') return {...release, network:'mainnet', ...f.switches};
  if (path==='/vaults') return {vaults:f.vaults, resendable:[]};
  if (path==='/jobs') return {jobs:f.jobs};
  const m = /^\\/vaults\\/([^/]+)\\/funding$/.exec(path);
  if (m) {
    const v=f.vaults.find(x=>x.id===m[1]);
    if (f.failFunding) throw Error('CHAIN_UNAVAILABLE');
    if (f.reorg && v.status==='confirmed') return {vault:{...v, status:'submitted'}, status:{confirmed:false}, strayPayments:null};
    const stray = v.status==='confirmed' ? {vaultId:v.id, count:1, sats:'546', outputs:[{txid:'5e'.repeat(32), vout:1, value:'546'}]} : null;
    return {vault:v, status:{confirmed:v.status==='confirmed'}, strayPayments:stray};
  }
  throw Error('Unexpected API '+path);
}`,
    }),
  );
  await page.route("**/src/lib/wallet.ts*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
export async function connectWallet(){return {address:window.appFixture.address, publicKey:'02'+'11'.repeat(32), type:'p2wpkh'};}
export async function signMessage(){return '';}
export async function signPsbt(){throw Error('No signing in this test');}`,
    }),
  );
}

const PENDING = "/vaults/bbbbbbbb-2222-4222-8222-222222222222/funding";
test("status follows the server switches and vault rows only offer what can happen", async ({ page }) => {
  await page.clock.install();
  await mount(page, { operationsEnabled: true, exactSubmitEnabled: true });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Deposits and withdrawals on" })).toBeVisible();
  // Until a wallet is connected there's one way forward.
  await expect(page.getByRole("button", { name: "Create vault", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();

  const pending = page.locator(".vault-row", { hasText: "Travel fund" });
  await expect(pending.getByRole("button", { name: "Waiting for confirmation" })).toBeDisabled();
  await expect(pending.getByRole("button", { name: /Withdraw/ })).toHaveCount(0);
  await expect(page.locator(".vault-row", { hasText: "Emergency" }).getByRole("button", { name: /Deposit/ })).toBeEnabled();
  // A funded vault is checked too: that's where the server flags a payment outside its deposit.
  await expect(page.locator(".vault-row", { hasText: "Savings" })).toContainText("reached this vault outside its one deposit");
  // A funded vault can also be checked by hand.
  await page.locator(".vault-row", { hasText: "Savings" }).getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".vault-row", { hasText: "Savings" })).toContainText("Checked. The payments outside the deposit are shown above.");
  // A deposit that has only just turned pending isn't checked: a first submission may still
  // be in flight. Once it has been pending for five minutes, it's checked without a click.
  expect(await page.evaluate(() => (window as any).apiCalls)).not.toContain(PENDING);
  await expect(pending).not.toContainText("last checked");
  await page.clock.fastForward("02:05");
  expect(await page.evaluate(() => (window as any).apiCalls)).not.toContain(PENDING);
  await page.clock.fastForward("03:05");
  await expect(pending).toContainText("last checked");
  expect(await page.evaluate(() => (window as any).apiCalls)).toContain(PENDING);
  await expect(page.getByText("Savings: your withdrawal is ready to authorize.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Activity.*1 ready to authorize/ })).toBeVisible();

  // The address opens a menu; disconnecting is a separate, labelled choice.
  await page.getByRole("button", { name: /bc1qw50/ }).click();
  await expect(page.getByRole("menuitem", { name: "Copy address" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Savings" })).toBeVisible();
  await page.getByRole("button", { name: /bc1qw50/ }).click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Wallet disconnected");
});

for (const [switches, label] of [
  [{ operationsEnabled: true, exactSubmitEnabled: false }, "Submission to MARA off"],
  [{ operationsEnabled: false, exactSubmitEnabled: true }, "Deposits and withdrawals off"],
] as const)
  test(`status reads "${label}" from the server switches`, async ({ page }) => {
    await mount(page, switches);
    // A page link opens that page directly.
    await page.goto("/#/activity");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: label }).click();
    await expect(page.getByRole("dialog")).toContainText(`${label}.`);
    await expect(page.getByRole("dialog")).not.toContainText("Deposits and withdrawals on");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    // A new deposit can't be submitted in this state, so Deposit explains why instead.
    await page.getByRole("link", { name: "My vaults", exact: true }).click();
    await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();
    await page.locator(".vault-row", { hasText: "Emergency" }).getByRole("button", { name: /Deposit/ }).click();
    await expect(page.getByRole("dialog")).toContainText(`${label}.`);
    await expect(page.getByRole("dialog")).not.toContainText("Unlock your backup");
  });

test("two tabs share one chain check a minute and its result", async ({ page }) => {
  await page.context().clock.install();
  const second = await page.context().newPage();
  for (const tab of [page, second]) await mount(tab, { operationsEnabled: true, exactSubmitEnabled: true });
  const pendingChecks = async () =>
    (await Promise.all([page, second].map((tab) => tab.evaluate(() => (window as any).apiCalls as string[]))))
      .flat()
      .filter((path) => path === PENDING).length;
  for (const tab of [page, second]) {
    await tab.goto("/");
    await tab.getByRole("button", { name: "Connect Xverse", exact: true }).click();
    await expect(tab.locator(".vault-row", { hasText: "Travel fund" })).toBeVisible();
  }
  // Both tabs are due to check the pending deposit; only one does, and both show the result.
  await page.context().clock.fastForward("05:05");
  await expect.poll(pendingChecks).toBe(1);
  // The next refresh, well inside the minute, reads the shared result without checking again.
  await page.context().clock.fastForward("00:16");
  for (const tab of [page, second])
    await expect(tab.locator(".vault-row", { hasText: "Travel fund" })).toContainText("last checked");
  expect(await pendingChecks()).toBe(1);
});

test("a deposit made again after a refusal waits the full time before it's checked", async ({ page }) => {
  await page.clock.install();
  await mount(page, { operationsEnabled: true, exactSubmitEnabled: true });
  const pendingChecks = () => page.evaluate((path) => ((window as any).apiCalls as string[]).filter((p) => p === path).length, PENDING);
  const setStatus = (status: string) =>
    page.evaluate((status) => { (window as any).appFixture.vaults[1].status = status; }, status);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();
  await page.clock.fastForward("05:05");
  await expect.poll(pendingChecks).toBe(1);
  // MARA refuses the first deposit: the vault is unfunded again, then the user deposits again.
  await setStatus("unfunded");
  await page.clock.fastForward("00:16");
  await expect(page.locator(".vault-row", { hasText: "Travel fund" })).toContainText("Not funded");
  await setStatus("submitted");
  await page.clock.fastForward("00:16");
  await expect(page.locator(".vault-row", { hasText: "Travel fund" })).toContainText("Deposit pending");
  await page.clock.fastForward("01:05");
  expect(await pendingChecks()).toBe(1);
  await page.clock.fastForward("04:05");
  await expect.poll(pendingChecks).toBe(2);
  // A new deposit this tab never saw refused (the tab was asleep, say) has a new txid, so it
  // waits the full time too.
  await page.evaluate(() => {
    const vault = (window as any).appFixture.vaults[1];
    vault.funding = { ...vault.funding, txid: "9f".repeat(32) };
  });
  await page.clock.fastForward("00:16");
  await page.clock.fastForward("01:05");
  expect(await pendingChecks()).toBe(2);
  await page.clock.fastForward("04:05");
  await expect.poll(pendingChecks).toBe(3);
});

test("a funded vault shows a failed check, and a check that finds its confirmation lost says so", async ({ page }) => {
  await mount(page, { operationsEnabled: true, exactSubmitEnabled: true });
  await page.addInitScript(() => { (window as any).appFixture.failFunding = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();
  const savings = page.locator(".vault-row", { hasText: "Savings" });
  await expect(savings).toContainText("Deposit confirmed · last check failed");
  await page.evaluate(() => {
    const f = (window as any).appFixture;
    f.failFunding = false;
    f.reorg = true;
  });
  await savings.getByRole("button", { name: "Check now" }).click();
  await expect(savings.getByRole("alert")).toContainText("no longer confirmed on the chain");
  await expect(savings).toContainText("Deposit pending");
});
