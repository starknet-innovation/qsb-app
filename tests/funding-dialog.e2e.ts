import { test, expect } from "@playwright/test";
for (const scenario of ["success", "post-broadcast-failure", "server-submitted", "server-confirmed", "server-funding", "server-missing", "server-read-failure", "local-guard", "local-guard-during-fetch", "unknown-guard", "malformed-guard"]) {
  const failAfterBroadcast = scenario === "post-broadcast-failure";
  test(`deposit dialog preserves one-deposit guard (${scenario})`, async ({
    page,
  }) => {
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
      export async function api(path,body){
        const f=window.fundingFixture;
        if(path==='/config')return {network:'mainnet',operationsEnabled:true};
        if(path==='/payment-utxos')return {utxos:[f.point]};
        if(path==='/payment-input')return {previousTxHex:f.previousTxHex};
        if(path==='/vaults'){
          if(window.serverReadFailure)throw Error('SERVER_READ_FAILED');
          if(window.guardDuringFetch)localStorage.setItem('qsb-funding:'+f.vault.id,JSON.stringify({txid:'ab'.repeat(32),amount:'50000'}));
          return {vaults:window.serverVaults??[f.vault]};
        }
        if(path.endsWith('/fund')){window.recordCalls++;return {vault:{...f.vault,status:'submitted',funding:{txid:body.txid}}};}
        throw Error('Unexpected API '+path);
      }`,
      }),
    );
    await page.route("**/src/lib/wallet.ts*", (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `
      export async function fundFromXverse(address,psbt,indices,remember){
        window.walletCalls++;const receipt=window.signFunding(psbt);remember(receipt.txid);
        if(${failAfterBroadcast})throw Error('POST_BROADCAST_CHECK_FAILED');return receipt;
      }
      export async function signPsbt(){throw Error('No withdrawal');} export async function connectWallet(){} export async function signMessage(){}
    `,
      }),
    );
    await page.goto("/");
    const data = await page.evaluate(async () => {
      const p = "/tests/funding-dialog-harness.tsx";
      return (await import(p)).mount();
    });
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Recovery backup", { exact: true })
      .setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(data.backup),
      });
    await dialog.getByLabel("Backup passphrase").fill(data.password);
    await dialog.getByRole("button", { name: "Verify backup locally" }).click();
    await expect(dialog).toContainText("Recovery backup verified");
    await dialog.locator("fieldset").getByRole("checkbox").check();
    await dialog
      .getByLabel("I have reviewed the itemized costs", { exact: false })
      .check();
    await dialog.getByLabel("Deposit amount (BTC)").fill("0.0005");
    await dialog.getByLabel("Miner fee (BTC, exact amount)").fill("0.0001");
    // Change another device/tab's state only after this dialog has opened.
    await page.evaluate((scenario) => {
      const w = window as any, vault = w.fundingFixture.vault;
      if (scenario === "server-read-failure") w.serverReadFailure = true;
      if (scenario.startsWith("server-")) w.serverVaults = scenario === "server-missing" ? [] : [{
        ...vault,
        status: scenario === "server-funding" ? "unfunded" : scenario.slice(7),
        funding: { txid: "ab".repeat(32), vout: 0, value: "50000" },
      }];
      if (["local-guard", "unknown-guard", "malformed-guard"].includes(scenario))
        localStorage.setItem("qsb-funding:" + vault.id, scenario === "malformed-guard" ? "{" : JSON.stringify({txid: scenario === "unknown-guard" ? "" : "ab".repeat(32), amount:"50000"}));
      if (scenario === "local-guard-during-fetch") w.guardDuringFetch = true;
    }, scenario);
    await dialog
      .getByRole("button", { name: "Review deposit in Xverse" })
      .click();
    if (scenario !== "success" && !failAfterBroadcast) {
      await expect(dialog).toContainText(scenario === "server-read-failure" ? "SERVER_READ_FAILED" : "do not deposit again.");
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(0);
      expect(await page.evaluate(() => (window as any).recordCalls)).toBe(0);
      if (!scenario.startsWith("server-")) {
        await expect(dialog.getByRole("button", {name:"Record deposit", exact:true})).toBeVisible();
        if (["local-guard", "local-guard-during-fetch"].includes(scenario)) {
          await dialog.getByRole("button", {name:"Record deposit", exact:true}).click();
          await expect(dialog).toContainText("Deposit submitted:");
          expect(await page.evaluate(() => (window as any).recordCalls)).toBe(1);
          expect(await page.evaluate(() => (window as any).walletCalls)).toBe(0);
        }
      }
      return;
    }
    if (failAfterBroadcast) {
      await expect(dialog).toContainText("POST_BROADCAST_CHECK_FAILED");
      expect(
        await page.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem(
                "qsb-funding:11111111-1111-4111-8111-111111111111",
              )!,
            ).txid,
        ),
      ).toMatch(/^[0-9a-f]{64}$/);
      await dialog
        .getByRole("button", { name: "Record deposit", exact: true })
        .click();
    }
    await expect(dialog).toContainText("Deposit submitted:");
    expect(await page.evaluate(() => (window as any).walletCalls)).toBe(1);
    expect(await page.evaluate(() => (window as any).recordCalls)).toBe(1);
  });
}
