import { test, expect, type Page } from "@playwright/test";

// The wallet's confirmed outputs, as the deposit and withdrawal dialogs list them. Each read of
// /payment-utxos takes the next answer from window.outputReads: a list, "fail", or "hold" (until
// window.releaseOutputs() is called with a list).
async function open(page: Page, reads: unknown[]) {
  await page.route("**/src/lib/qsb.ts*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `export async function validateRecovery(){return window.fundingFixture.vault.scriptHash;} export function lockQsb(){} export async function assembleQsb(){throw Error('unused');}`,
    }),
  );
  await page.route("**/src/lib/api.ts*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
      export function readSessionEpoch(){return 0;} export function readSessionToken(){return '';}
      export function clearSession(){} export function authenticate(){}
      export async function api(path){
        const f=window.fundingFixture;
        if(path==='/config')return {network:'mainnet',operationsEnabled:true,exactSubmitEnabled:true};
        if(path==='/rates')return {submit_fee_rate:1};
        if(path==='/payment-utxos'){
          window.outputCalls=(window.outputCalls||0)+1;
          const next=window.outputReads.shift();
          if(next==='fail')throw Error('CHAIN_DOWN');
          if(next==='hold')return new Promise(resolve=>{window.releaseOutputs=list=>resolve({utxos:list.map(()=>f.point)});});
          return {utxos:next.map(()=>f.point)};
        }
        throw Error('Unexpected API '+path);
      }`,
    }),
  );
  await page.route("**/src/lib/wallet.ts*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: "export async function signPsbt(){throw Error('unused');} export async function connectWallet(){} export async function signMessage(){}",
    }),
  );
  await page.goto("/");
  await page.evaluate((reads) => { (window as any).outputReads = reads; }, reads);
  const data = await page.evaluate(async () => {
    const p = "/tests/funding-dialog-harness.tsx";
    return (await import(p)).mount();
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Recovery backup", { exact: true }).setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(data.backup),
  });
  await dialog.getByLabel("Backup passphrase").fill(data.password);
  return dialog;
}
const outputs = (page: Page) => page.getByRole("dialog").locator("fieldset").getByRole("checkbox");

test("a failed read shows its error, not 'no outputs', and Refresh reads again", async ({ page }) => {
  const dialog = await open(page, ["fail", "fail", [1]]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Couldn't read your wallet's confirmed outputs: CHAIN_DOWN");
  await expect(dialog).not.toContainText("No confirmed payment outputs");
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(outputs(page)).toHaveCount(1);
  await expect(dialog).not.toContainText("Couldn't read");
  expect(await page.evaluate(() => (window as any).outputCalls)).toBe(3);
});

test("reaching the choice reads the outputs again, so one that confirmed meanwhile appears", async ({ page }) => {
  // Empty when the dialog opened (say, a deposit's change still unconfirmed), confirmed by the time
  // the backup is verified.
  const dialog = await open(page, [[], [1]]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(outputs(page)).toHaveCount(1);
  await expect(dialog).not.toContainText("No confirmed payment outputs");
});

test("'no outputs' appears only after a read answers with none, never while one is pending", async ({ page }) => {
  const dialog = await open(page, [[], "hold", "hold"]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Reading your wallet's confirmed outputs…");
  await expect(dialog).not.toContainText("No confirmed payment outputs");
  await expect(dialog.getByRole("button", { name: "Reading outputs…" })).toBeDisabled();
  await page.evaluate(() => (window as any).releaseOutputs([]));
  await expect(dialog).toContainText(/No confirmed payment outputs at bc1q\w+ yet\. An output appears here once it has one confirmation\./);
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(dialog).toContainText("Reading your wallet's confirmed outputs…");
  await page.evaluate(() => (window as any).releaseOutputs([1]));
  await expect(outputs(page)).toHaveCount(1);
});
