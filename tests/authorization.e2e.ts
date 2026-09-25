import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
// These tests exercise browser control flow with mocked cryptography and wallet
// transport. Actual encryption and transaction parsing are used; no network send.
async function fixture(page: Page, changedSolution = false) {
  await page.route("**/src/lib/qsb.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    export async function validateRecovery(){return window.authorizationFixture.scriptHash;}
    export async function assembleQsb(state,manifest,solution){return window.authorizationFixture.assembly(solution);}
    export function lockQsb(){}
    export async function generateQsb(){throw new Error('UI fixture only');}
  `,
    }),
  );
  await page.route("**/src/lib/wallet.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    export async function signPsbt(){window.walletCalls++;throw new Error('TEST_WALLET_REACHED');}
    export async function fundFromXverse(){throw new Error('TEST_WALLET_REACHED');}
    export async function connectWallet(){throw new Error('No wallet');}
    export async function signMessage(){throw new Error('No wallet');}
  `,
    }),
  );
  await page.route("**/api/config", (route) => route.fulfill({ json: { network: "mainnet", operationsEnabled: true } }));
  let previousTxHex = "";
  await page.route("**/api/vaults/*/funding", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/api/payment-input", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/api/jobs/*/submit", () => {
    throw new Error("No broadcast permitted in authorization test");
  });
  await page.goto("/");
  const data = await page.evaluate(async (changed) => {
    const path = "/tests/authorization-harness.tsx";
    return (await import(path)).mount(changed);
  }, changedSolution);
  previousTxHex = data.previousTxHex;
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Recovery backup", { exact: true })
    .setInputFiles({
      name: "intent.json",
      mimeType: "application/json",
      buffer: Buffer.from(data.backup),
    });
  await dialog.getByLabel("Backup passphrase").fill(data.password);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Recovery backup verified");
  await dialog.getByRole("checkbox").check();
  return { dialog, ...data };
}
const calls = (page: Page) => page.evaluate(() => (window as any).walletCalls);
test("requires the exact downloaded signing backup before wallet disclosure", async ({
  page,
}) => {
  const { dialog, backup } = await fixture(page);
  const downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Save signing backup", exact: true })
    .click();
  const download = await downloaded;
  const signedBackup = await readFile((await download.path())!, "utf8");
  expect(await calls(page)).toBe(0);
  await expect(
    dialog.getByRole("button", { name: "Save signing backup", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Verify updated signing backup")
    .setInputFiles({
      name: "stale.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
  await expect(dialog.getByRole("alert")).toContainText(
    "updated signing backup just downloaded",
  );
  expect(await calls(page)).toBe(0);
  await dialog
    .getByLabel("Verify updated signing backup")
    .setInputFiles({
      name: "signing.json",
      mimeType: "application/json",
      buffer: Buffer.from(signedBackup),
    });
  await expect(
    dialog.getByRole("button", { name: "Authorize and sign", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Authorize and sign", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("TEST_WALLET_REACHED");
  expect(await calls(page)).toBe(1);
});
test("rejects an alternate solution when restoring an already-bound signing backup", async ({
  page,
}) => {
  const { dialog } = await fixture(page, true);
  await dialog
    .getByRole("button", { name: "Authorize and sign", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "already binds another QSB solution",
  );
  expect(await calls(page)).toBe(0);
});
