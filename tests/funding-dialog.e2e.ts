import { test, expect } from "@playwright/test";
for (const scenario of ["success", "uncertain-submission", "miner-rejected", "server-submitted", "server-confirmed", "server-funding", "server-missing", "server-read-failure", "local-guard", "local-guard-during-fetch", "unknown-guard", "malformed-guard", "below-floor", "below-current-rate", "submit-disabled"]) {
  const uncertain = scenario === "uncertain-submission";
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
        if(path==='/config')return {network:'mainnet',operationsEnabled:true,exactSubmitEnabled:window.exactSubmit??true};
        if(path==='/payment-utxos')return {utxos:[f.point]};
        if(path==='/rates')return window.minerRates??{submit_fee_rate:window.minerFloor??1};
        if(path==='/payment-input')return {previousTxHex:f.previousTxHex};
        if(path==='/vaults'){
          if(window.serverReadFailure)throw Error('SERVER_READ_FAILED');
          if(window.guardDuringFetch)localStorage.setItem('qsb-funding:'+f.vault.id,JSON.stringify({txid:'ab'.repeat(32),amount:'50000'}));
          return {vaults:window.serverVaults??[f.vault]};
        }
        if(path.endsWith('/fund/submit')){
          window.submitCalls=(window.submitCalls||0)+1;(window.submitted=window.submitted||[]).push(body);
          const outcome=(window.minerOutcomes||[]).shift()??'submitted';
          if(outcome==='rejected')return {vault:f.vault,submission:'rejected',reason:'min relay fee not met'};
          return {vault:{...f.vault,status:'submitted',funding:{txid:'cd'.repeat(32),vout:0,value:body.amount}},submission:outcome};
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
      export async function signPsbt(address,psbt,indices){window.walletCalls++;return window.signFunding(psbt).psbt;}
      export async function connectWallet(){} export async function signMessage(){}
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
    await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
    await expect(dialog).toContainText(/Estimated size \d+ vB · miner fee \d+ sats/);
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
      if (scenario === "below-floor") w.minerFloor = 5;
      // MARA's minimum is the higher of its floor and its current rate.
      if (scenario === "below-current-rate") w.minerRates = { submit_fee_rate: 1, effective_rate: 5 };
      if (scenario === "submit-disabled") w.exactSubmit = false;
      if (scenario === "uncertain-submission") w.minerOutcomes = ["uncertain", "submitted"];
      if (scenario === "miner-rejected") w.minerOutcomes = ["rejected"];
    }, scenario);
    await dialog
      .getByRole("button", { name: "Review deposit in Xverse" })
      .click();
    if (scenario === "submit-disabled") {
      await expect(dialog).toContainText("switched off right now. Nothing was signed.");
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(0);
      expect(await page.evaluate(() => (window as any).recordCalls)).toBe(0);
      return;
    }
    if (scenario === "below-floor" || scenario === "below-current-rate") {
      await expect(dialog).toContainText("below MARA's current minimum of 5 sat/vB");
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(0);
      expect(await page.evaluate(() => (window as any).recordCalls)).toBe(0);
      return;
    }
    const guard = () =>
      page.evaluate(() => localStorage.getItem("qsb-funding:11111111-1111-4111-8111-111111111111"));
    if (scenario === "miner-rejected") {
      await expect(dialog).toContainText("MARA refused the deposit: min relay fee not met. Nothing was sent to the network.");
      expect(await guard()).toBeNull();
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(1);
      expect(await page.evaluate(() => (window as any).recordCalls)).toBe(0);
      return;
    }
    if (scenario !== "success" && !uncertain) {
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
    if (uncertain) {
      await expect(dialog).toContainText("was lost. Don't deposit again");
      const kept = JSON.parse((await guard())!);
      expect(kept.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(kept.rawTxHex).toMatch(/^[0-9a-f]+$/);
      // The manual fallback shows exactly the kept bytes and links to MARA's portal.
      await dialog.getByText("Submit it yourself on MARA Slipstream").click();
      await expect(dialog.getByLabel("Signed deposit transaction (hex)")).toHaveValue(kept.rawTxHex);
      await expect(dialog.getByRole("link", { name: "slipstream.mara.com" })).toHaveAttribute("href", "https://slipstream.mara.com/");
      await dialog.getByRole("button", { name: "Submit deposit again", exact: true }).click();
    }
    await expect(dialog).toContainText("Deposit submitted to MARA Slipstream:");
    expect(await guard()).toBeNull();
    expect(await page.evaluate(() => (window as any).walletCalls)).toBe(1);
    expect(await page.evaluate(() => (window as any).recordCalls)).toBe(0);
    const submitted = await page.evaluate(() => (window as any).submitted);
    expect(submitted).toHaveLength(uncertain ? 2 : 1);
    // A retry resends exactly the signed bytes.
    expect(new Set(submitted.map((b: { rawTxHex: string }) => b.rawTxHex)).size).toBe(1);
    expect(submitted[0]).toMatchObject({ amount: "50000", costAccepted: true });
  });
}
