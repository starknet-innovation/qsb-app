import { test, expect, type Page } from "@playwright/test";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SERVICE_FEE_PRIVATE_KEY } from "./service-fee-fixture";

// At 10,000,000 USD/BTC the USD 200 fee is 2,000 sats, which the harness's 100,000-sat output covers.
const feeAddress = btc.p2wpkh(secp256k1.getPublicKey(SERVICE_FEE_PRIVATE_KEY, true)).address!;
const quote = { usd: 200, btcUsd: "10000000", source: "coinbase", sats: "2000", address: feeAddress };

async function open(page: Page, offered: boolean) {
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
        if(path==='/config')return {network:'mainnet',operationsEnabled:true,exactSubmitEnabled:true,serviceFeeAddress:${offered ? JSON.stringify(feeAddress) : "null"}};
        if(path==='/service-fee'){window.quoteCalls=(window.quoteCalls||0)+1;return {...${JSON.stringify(quote)},quotedAt:new Date().toISOString()};}
        if(path==='/payment-utxos')return {utxos:[f.point]};
        if(path==='/rates')return {submit_fee_rate:1};
        if(path==='/payment-input')return {previousTxHex:f.previousTxHex};
        if(path==='/vaults')return {vaults:[f.vault],noDeposit:[]};
        if(path.endsWith('/fund/submit')){
          window.submitted=body;
          return {vault:{...f.vault,status:'submitted',funding:{txid:'cd'.repeat(32),vout:0,value:body.amount}},submission:'submitted'};
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
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Recovery backup verified");
  await dialog.locator("fieldset").getByRole("checkbox").check();
  await dialog.getByLabel("Deposit amount (BTC)").fill("0.0005");
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  return dialog;
}

test("deposit pays the opted-in service fee as output 1", async ({ page }) => {
  const dialog = await open(page, true);
  await expect(dialog).toContainText(/Estimated size \d+ vB/);
  await dialog.getByLabel(/Pay the optional USD 200 service fee/).check();
  await expect(dialog).toContainText(/Estimated size \d+ vB · miner fee \d+ sats/);
  await dialog.getByRole("button", { name: "Review deposit", exact: true }).click();
  await expect(dialog).toContainText("Service fee (optional)");
  await expect(dialog).toContainText(`2,000 sats`);
  await expect(dialog).toContainText(feeAddress);
  await dialog.getByLabel("I have read these statements and accept them").check();
  await dialog.getByRole("button", { name: "Review deposit in Xverse" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).submitted?.rawTxHex)).toBeTruthy();
  const submitted = await page.evaluate(() => (window as any).submitted);
  const tx = btc.Transaction.fromRaw(hex.decode(submitted.rawTxHex), { allowUnknownOutputs: true });
  expect(submitted.amount).toBe("50000");
  expect(tx.getOutput(0).amount).toBe(50_000n);
  expect(hex.encode(tx.getOutput(0).script!)).toBe("51".repeat(100));
  expect(tx.getOutput(1).amount).toBe(2_000n);
  expect(hex.encode(tx.getOutput(1).script!)).toBe(hex.encode(btc.OutScript.encode(btc.Address().decode(feeAddress))));
  expect(tx.outputsLength).toBe(3);
});

test("deposit pays no service fee unless the user ticks it", async ({ page }) => {
  const dialog = await open(page, true);
  await dialog.getByRole("button", { name: "Review deposit", exact: true }).click();
  await expect(dialog).not.toContainText("Service fee (optional)");
  await dialog.getByLabel("I have read these statements and accept them").check();
  await dialog.getByRole("button", { name: "Review deposit in Xverse" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).submitted?.rawTxHex)).toBeTruthy();
  const tx = btc.Transaction.fromRaw(hex.decode(await page.evaluate(() => (window as any).submitted.rawTxHex)), { allowUnknownOutputs: true });
  expect(tx.outputsLength).toBe(2);
  expect(await page.evaluate(() => (window as any).quoteCalls ?? 0)).toBe(0);
});

test("a deployment without the fee doesn't offer it", async ({ page }) => {
  const dialog = await open(page, false);
  await expect(dialog).toContainText(/Estimated size \d+ vB/);
  await expect(dialog.getByLabel(/Pay the optional USD 200 service fee/)).toHaveCount(0);
});
