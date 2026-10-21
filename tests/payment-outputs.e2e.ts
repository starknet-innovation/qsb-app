import { test, expect, type Page } from "@playwright/test";

// The wallet's confirmed outputs, as the deposit dialog lists them (withdraw-outputs.e2e.ts covers
// the withdrawal dialog). Each read of /payment-utxos takes the next answer from
// window.outputReads: a list of output numbers, "fail", or "hold" (until window.releaseOutputs()
// answers it with a list, or "fail").
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
          const answer=list=>({utxos:list.map(n=>({...f.point,vout:n}))});
          if(next==='hold')return new Promise((resolve,reject)=>{window.releaseOutputs=list=>{list==='fail'?reject(Error('LATE_FAIL')):resolve(answer(list));return new Promise(done=>setTimeout(done,200));};});
          return answer(next);
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
  const dialog = await open(page, ["fail", "fail", [0]]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Couldn't read your wallet's confirmed outputs: CHAIN_DOWN");
  await expect(dialog).not.toContainText("No confirmed payment outputs");
  // The hint by Review says why it can't go on, not that there's nothing to choose.
  await expect(dialog.locator(".blocker")).toHaveText("Couldn't read your wallet's confirmed outputs. Refresh them to continue.");
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(outputs(page)).toHaveCount(1);
  await expect(dialog).not.toContainText("Couldn't read");
  expect(await page.evaluate(() => (window as any).outputCalls)).toBe(3);
});

test("reaching the choice reads the outputs again, so one that confirmed meanwhile appears", async ({ page }) => {
  // Empty when the dialog opened (say, a deposit's change still unconfirmed), confirmed by the time
  // the backup is verified.
  const dialog = await open(page, [[], [0]]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(outputs(page)).toHaveCount(1);
  await expect(dialog).not.toContainText("No confirmed payment outputs");
});

test("'no outputs' appears only after a read answers with none, never while one is pending", async ({ page }) => {
  const dialog = await open(page, [[], "hold", "hold"]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog.getByRole("status").first()).toHaveText("Reading your wallet's confirmed outputs…");
  await expect(dialog).not.toContainText("No confirmed payment outputs");
  // Refresh stays focusable while it reads, and ignores presses.
  const reading = dialog.getByRole("button", { name: "Reading outputs…" });
  await expect(reading).toHaveAttribute("aria-disabled", "true");
  await reading.focus();
  await expect(reading).toBeFocused();
  await reading.dispatchEvent("click");
  expect(await page.evaluate(() => (window as any).outputCalls)).toBe(2);
  await page.evaluate(() => (window as any).releaseOutputs([]));
  await expect(dialog).toContainText(/No confirmed payment outputs at bc1q\w+ yet\. An output is listed once it has one confirmation: refresh the outputs to check again\./);
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(dialog).toContainText("Reading your wallet's confirmed outputs…");
  await page.evaluate(() => (window as any).releaseOutputs([0]));
  await expect(outputs(page)).toHaveCount(1);
});

test("an older read that answers late can't overwrite a newer one", async ({ page }) => {
  for (const late of [[], "fail"]) {
    // The read from opening the dialog is held; the one after verifying answers first.
    const dialog = await open(page, ["hold", [0]]);
    await dialog.getByRole("button", { name: "Verify backup locally" }).click();
    await expect(outputs(page)).toHaveCount(1);
    await outputs(page).check();
    // Answer the older read, and wait until the dialog has handled the answer, before checking.
    await page.evaluate((late) => (window as any).releaseOutputs(late), late);
    await expect(outputs(page)).toBeChecked();
    await expect(dialog).not.toContainText("No confirmed payment outputs");
    await expect(dialog).not.toContainText("Couldn't read");
    await expect(dialog.getByRole("button", { name: "Refresh outputs" })).toHaveAttribute("aria-disabled", "false");
    await page.reload();
  }
});

test("an output a read drops isn't still counted as chosen", async ({ page }) => {
  // Eight outputs chosen; a refresh drops one of them (spent elsewhere) and adds another, which is
  // then chosen: still eight, so nothing is refused.
  const all = [0, 1, 2, 3, 4, 5, 6, 7];
  const dialog = await open(page, [all, all, [...all.slice(0, 7), 8], [...all, 8]]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(outputs(page)).toHaveCount(8);
  for (let i = 0; i < 8; i++) await outputs(page).nth(i).check();
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(outputs(page)).toHaveCount(8);
  await expect(outputs(page).nth(7)).not.toBeChecked();
  await outputs(page).nth(7).check();
  await dialog.getByLabel("Deposit amount (BTC)").fill("0.0005");
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  await expect(dialog).not.toContainText("Choose at most eight payment outputs.");
  await expect(dialog).toContainText(/Estimated size \d+ vB/);
  // Output 7 comes back: it was dropped from the choice, so it isn't chosen behind the user's back.
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(outputs(page)).toHaveCount(9);
  await expect(page.getByRole("dialog").locator("fieldset label", { hasText: "…:7" }).getByRole("checkbox")).not.toBeChecked();
});

test("Review waits for a pending read, so the figures reviewed can't change under it", async ({ page }) => {
  // Outputs 0 and 1 from the read at opening; the read after verifying is still pending.
  const dialog = await open(page, [[0, 1], "hold"]);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(outputs(page)).toHaveCount(2);
  await outputs(page).first().check();
  await dialog.getByLabel("Deposit amount (BTC)").fill("0.0005");
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  const review = dialog.getByRole("button", { name: "Review deposit", exact: true });
  await expect(dialog.locator(".blocker")).toHaveText("Reading your wallet's confirmed outputs…");
  await expect(review).toBeDisabled();
  await page.evaluate(() => (window as any).releaseOutputs([0]));
  await expect(dialog.locator(".blocker")).toHaveCount(0);
  await expect(review).toBeEnabled();
});
