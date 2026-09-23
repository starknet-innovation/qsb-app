import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
async function setup(page: any) {
  await page.route("**/api/config", (r: any) =>
    r.fulfill({
      json: {
        network: "mainnet",
        mainnetEnabled: false,
        operationsEnabled: false,
        checks: [],
      },
    }),
  );
  await page.route("**/src/lib/qsb.ts", (r: any) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `export const lockQsb=()=>{}; export const generateQsb=()=>{throw Error('unused')}; export const validateRecovery=async()=>window.offlineSigningTest.scriptHash; export const assembleQsb=async()=>window.offlineSigningTest.raw;`,
    }),
  );
  await page.route("**/node_modules/.vite/deps/sats-connect.js*", (r: any) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `export const request=(...args)=>window.testWalletRequest(...args);export const getProviders=()=>[]; export const AddressPurpose={Payment:'payment'};export const BitcoinNetworkType={Mainnet:'Mainnet',Testnet4:'Testnet4'};export const MessageSigningProtocols={BIP322:'BIP322'};`,
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/offline-signing-harness.tsx";
    await (await import(path)).mount();
  });
  await expect(
    page.getByRole("heading", { name: "Sign a solved offline fixture" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).loadPublicBundle());
  await expect(page.getByRole("status")).toContainText(
    "Public bundle validated",
  );
  await page.evaluate(() => (window as any).loadPrivateFixture());
  await page
    .getByLabel("Private signing passphrase")
    .fill("disposable browser signing password");
  await expect(
    page.getByRole("button", {
      name: "Prepare private signing backup",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", {
      name: "Prepare private signing backup",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Authorization assembled locally",
  );
  await expect(page.getByLabel("Reimport private signing backup")).toHaveCount(
    0,
  );
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download private signing backup",
      exact: true,
    })
    .click();
  const download = await downloadPromise;
  await expect(
    page.getByRole("button", {
      name: "Sign offline fixture in Xverse — no broadcast",
    }),
  ).toBeDisabled();
  await page
    .getByLabel("Reimport private signing backup")
    .setInputFiles({
      name: "wrong.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
  await page
    .getByLabel("Signing backup passphrase", { exact: true })
    .fill("disposable browser signing password");
  await page
    .getByRole("button", {
      name: "Sign offline fixture in Xverse — no broadcast",
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Reimport the exact signing backup",
  );
  expect(
    await page.evaluate(() => (window as any).offlineSigningTest.calls.length),
  ).toBe(0);
  await page
    .getByLabel("Reimport private signing backup")
    .setInputFiles((await download.path())!);
  await page
    .getByLabel("Signing backup passphrase", { exact: true })
    .fill("disposable browser signing password");
}
test("staged offline signing saves/reimports backup, verifies actual mocked-wallet signature and exports without broadcast", async ({
  page,
}) => {
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await setup(page);
  await page
    .getByRole("button", {
      name: "Sign offline fixture in Xverse — no broadcast",
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Xverse signature verified",
  );
  const calls = await page.evaluate(() =>
    (window as any).offlineSigningTest.calls.map((c: any) => ({
      method: c.method,
      broadcast: c.params.broadcast,
      indices: Object.values(c.params.signInputs),
    })),
  );
  expect(calls).toEqual([
    { method: "signPsbt", broadcast: false, indices: [[0]] },
  ]);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download signed public result" })
    .click();
  const result = JSON.parse(
    await readFile((await (await downloadPromise).path())!, "utf8"),
  );
  expect(result.format).toBe("qsb-offline-signed-result-v1");
  expect(result.broadcast).toBe(false);
  expect(result.helperSignatureVerified).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /stateJson|ciphertext|hors_secrets/,
  );
  const actual = btc.Transaction.fromRaw(hex.decode(result.rawTxHex), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  expect(actual.getInput(0).finalScriptWitness?.length).toBe(2);
  expect(hex.encode(actual.getInput(1).finalScriptSig!)).toBe(
    await page.evaluate(() => (window as any).offlineSigningTest.payload),
  );
  expect(actual.id).toBe(result.txid);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
test("wallet changes during signing discard returned authorization", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).offlineSigningTest.hold = true;
  });
  await page
    .getByRole("button", {
      name: "Sign offline fixture in Xverse — no broadcast",
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).offlineSigningTest.calls.length),
    )
    .toBe(1);
  await page.evaluate(() => {
    (window as any).changeFixtureWallet();
  });
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).offlineSigningTest.resolve();
  });
  await expect(
    page.getByRole("button", { name: "Download signed public result" }),
  ).toHaveCount(0);
});
