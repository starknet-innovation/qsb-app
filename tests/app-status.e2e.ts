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
  if (m) { const v=f.vaults.find(x=>x.id===m[1]); return {vault:v, status:{confirmed:false}}; }
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

test("status follows the server switches and vault rows only offer what can happen", async ({ page }) => {
  await mount(page, { operationsEnabled: true, exactSubmitEnabled: true });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Deposits and withdrawals on" })).toBeVisible();
  // Until a wallet is connected there's one way forward.
  await expect(page.getByRole("button", { name: "Create vault", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();

  const pending = page.locator(".vault-row", { hasText: "Travel fund" });
  await expect(pending.getByRole("button", { name: "Waiting for confirmation" })).toBeDisabled();
  await expect(pending.getByRole("button", { name: /Withdraw/ })).toHaveCount(0);
  // The pending deposit is checked on the chain without a click.
  await expect(pending).toContainText("last checked");
  expect(await page.evaluate(() => (window as any).apiCalls)).toContain(
    "/vaults/bbbbbbbb-2222-4222-8222-222222222222/funding",
  );
  await expect(page.locator(".vault-row", { hasText: "Emergency" }).getByRole("button", { name: /Deposit/ })).toBeEnabled();
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
  });

test("two tabs share one chain check a minute and its result", async ({ page }) => {
  const second = await page.context().newPage();
  for (const tab of [page, second]) await mount(tab, { operationsEnabled: true, exactSubmitEnabled: true });
  const fundingCalls = async () =>
    (await Promise.all([page, second].map((tab) => tab.evaluate(() => (window as any).apiCalls as string[]))))
      .flat()
      .filter((path) => path.endsWith("/funding")).length;
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Xverse", exact: true }).click();
  await expect(page.locator(".vault-row", { hasText: "Travel fund" })).toContainText("last checked");
  await second.goto("/");
  await second.getByRole("button", { name: "Connect Xverse", exact: true }).click();
  // The second tab shows the first tab's check instead of making its own.
  await expect(second.locator(".vault-row", { hasText: "Travel fund" })).toContainText("last checked");
  expect(await fundingCalls()).toBe(1);
});
