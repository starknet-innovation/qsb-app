import { test, expect } from "@playwright/test";
for (const scenario of ["success", "uncertain-submission", "miner-rejected", "server-submitted", "server-confirmed", "server-funding", "server-missing", "server-read-failure", "local-guard", "local-guard-during-fetch", "unknown-guard", "malformed-guard", "below-floor", "below-current-rate", "submit-disabled", "unrecorded-failure", "miner-unavailable", "disabled-after-sign", "different-bytes", "no-deposit", "held-at-submit", "held-at-record"]) {
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
          return {vaults:window.serverVaults??[f.vault],noDeposit:window.noDeposit??[]};
        }
        if(path.endsWith('/fund/signed')){
          if(window.exactSubmit===false||!window.serverSigned)throw Error('NOT_RECORDED');
          return {rawTxHex:window.serverSignedOverride??window.serverSigned};
        }
        if(path.endsWith('/fund/submit')){
          window.submitCalls=(window.submitCalls||0)+1;(window.submitted=window.submitted||[]).push(body);
          const outcome=(window.minerOutcomes||[]).shift()??'submitted';
          if(outcome==='throw')throw Error('NETWORK_DOWN');
          // The API's 503 when the miner credential can't be read, before anything is recorded.
          if(outcome==='unavailable'){const {ApiRequestError}=await import('/src/lib/session.ts');throw new ApiRequestError('Miner API credential is unavailable. Contact the service operator.',503,'miner_unavailable');}
          // Another vault holds this vault's script: refused before anything is recorded or sent.
          if(outcome==='held'){const {ApiRequestError}=await import('/src/lib/session.ts');throw new ApiRequestError("Another vault on this deployment holds this vault's script, so this vault takes no deposit.",409,'vault_script_registered');}
          if(outcome!=='rejected')window.serverSigned=body.rawTxHex;
          if(window.disableAfterSubmit)window.exactSubmit=false;
          if(outcome==='rejected')return {vault:f.vault,submission:'rejected',reason:'min relay fee not met'};
          return {vault:{...f.vault,status:'submitted',funding:{txid:'cd'.repeat(32),vout:0,value:body.amount}},submission:outcome};
        }
        if(path.endsWith('/fund')){
          window.recordCalls++;
          if(window.recordHeld){const {ApiRequestError}=await import('/src/lib/session.ts');throw new ApiRequestError("Another vault on this deployment holds this vault's script, so this vault takes no deposit.",409,'vault_script_registered');}
          return {vault:{...f.vault,status:'submitted',funding:{txid:body.txid}}};
        }
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
    // A fractional minimum is suggested as is, not rounded up to a whole sat/vB.
    if (scenario === "success") await page.evaluate(() => { (window as any).minerRates = { submit_fee_rate: 1.5 }; });
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
    if (scenario === "success") await expect(dialog.getByLabel("Miner fee rate (sat/vB)")).toHaveValue("1.5");
    await dialog.locator("fieldset").getByRole("checkbox").check();
    await dialog.getByLabel("Deposit amount (BTC)").fill("0.0005");
    await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
    await expect(dialog).toContainText(/Estimated size \d+ vB · miner fee \d+ sats/);
    await dialog.getByRole("button", { name: "Review deposit", exact: true }).click();
    await expect(dialog).toContainText("Leaves your wallet");
    await dialog.getByLabel("I have read these statements and accept them").check();
    // Change another device/tab's state only after this dialog has opened.
    await page.evaluate((scenario) => {
      const w = window as any, vault = w.fundingFixture.vault;
      if (scenario === "server-read-failure") w.serverReadFailure = true;
      if (scenario.startsWith("server-")) w.serverVaults = scenario === "server-missing" ? [] : [{
        ...vault,
        status: scenario === "server-funding" ? "unfunded" : scenario.slice(7),
        funding: { txid: "ab".repeat(32), vout: 0, value: "50000" },
      }];
      if (["local-guard", "unknown-guard", "malformed-guard", "held-at-record"].includes(scenario))
        localStorage.setItem("qsb-funding:" + vault.id, scenario === "malformed-guard" ? "{" : JSON.stringify({txid: scenario === "unknown-guard" ? "" : "ab".repeat(32), amount:"50000"}));
      if (scenario === "local-guard-during-fetch") w.guardDuringFetch = true;
      if (scenario === "below-floor") w.minerFloor = 5;
      // MARA's minimum is the higher of its floor and its current rate.
      if (scenario === "below-current-rate") w.minerRates = { submit_fee_rate: 1, market_rate: 5, effective_rate: 5 };
      if (scenario === "submit-disabled") w.exactSubmit = false;
      if (scenario === "unrecorded-failure") w.minerOutcomes = ["throw"];
      if (scenario === "miner-unavailable") w.minerOutcomes = ["unavailable"];
      if (scenario === "disabled-after-sign") { w.minerOutcomes = ["uncertain"]; w.disableAfterSubmit = true; }
      // The server holds a different deposit for this vault (another device's).
      if (scenario === "different-bytes") { w.minerOutcomes = ["uncertain"]; w.serverSignedOverride = "02" + "00".repeat(60); }
      if (scenario === "uncertain-submission") w.minerOutcomes = ["uncertain", "submitted"];
      if (scenario === "miner-rejected") w.minerOutcomes = ["rejected"];
      // The server lists this vault as taking no deposit, or says so only at submit.
      if (scenario === "no-deposit") w.noDeposit = [vault.id];
      if (scenario === "held-at-submit") w.minerOutcomes = ["held"];
      if (scenario === "held-at-record") w.recordHeld = true;
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
    if (scenario === "held-at-record") {
      // A deposit Xverse broadcast, which the server won't record: the guard keeps its txid.
      await expect(dialog).toContainText("do not deposit again.");
      await dialog.getByRole("button", { name: "Record deposit", exact: true }).click();
      await expect(dialog).toContainText(`won't record the transaction Xverse broadcast, ${"ab".repeat(32)}`);
      expect(JSON.parse((await guard())!).txid).toBe("ab".repeat(32));
      expect(await page.evaluate(() => (window as any).recordCalls)).toBe(1);
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(0);
      await expect(dialog.getByRole("button", { name: "Record deposit", exact: true })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Download signing backup again" })).toHaveCount(0);
      return;
    }
    if (scenario === "no-deposit" || scenario === "held-at-submit") {
      await expect(dialog).toContainText("so this vault takes no deposit");
      await expect(dialog).toContainText(scenario === "no-deposit" ? "Nothing was signed." : "This request sent nothing.");
      // Nothing left to sign or send: no guard, no resend, and the primary action stays off.
      expect(await guard()).toBeNull();
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(scenario === "no-deposit" ? 0 : 1);
      expect(await page.evaluate(() => (window as any).submitCalls ?? 0)).toBe(scenario === "no-deposit" ? 0 : 1);
      await expect(dialog.getByRole("button", { name: "Submit deposit again", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Review deposit in Xverse" })).toBeDisabled();
      // Nor does it show the withdrawal's signing-backup panel, which would offer an empty "backup".
      await expect(dialog.getByRole("button", { name: "Download signing backup again" })).toHaveCount(0);
      await expect(dialog.getByLabel("Verify updated signing backup")).toHaveCount(0);
      await expect(dialog).not.toContainText("Keep this newest backup");
      return;
    }
    if (scenario === "unrecorded-failure" || scenario === "miner-unavailable" || scenario === "disabled-after-sign" || scenario === "different-bytes") {
      // The signed deposit is kept, but manual submission stays hidden: the server hasn't
      // recorded these bytes, or deposits were switched off.
      await expect(dialog).toContainText("Don't deposit again");
      expect(JSON.parse((await guard())!).rawTxHex).toMatch(/^[0-9a-f]+$/);
      await expect(dialog).toContainText("Manual submission on MARA Slipstream becomes available once the app has recorded");
      await expect(dialog.getByText("Submit it yourself on MARA Slipstream")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).walletCalls)).toBe(1);
      return;
    }
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
