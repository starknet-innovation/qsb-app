import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function fixture(page: Page) {
  const bodies: string[] = [];
  let submitted = false;
  page.on("request", (request) => {
    const body = request.postData();
    if (body) bodies.push(body);
  });
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
    export async function signPsbt(_address, psbt, indices){
      window.walletCalls++;
      if (!indices || indices.length !== 1 || indices[0] !== 0) throw new Error("wrong helper input");
      return window.signSolvedPsbt(psbt);
    }
    export async function fundFromXverse(){throw new Error('No deposit in withdrawal test');}
    export async function connectWallet(){throw new Error('No wallet');}
    export async function signMessage(){throw new Error('No wallet');}
  `,
    }),
  );
  let previousTxHex = "";
  await page.route("**/api/vaults/*/funding", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/api/payment-input", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/api/jobs/*/submit", () => {
    submitted = true;
    throw new Error("No broadcast permitted");
  });
  await page.goto("/");
  const data = await page.evaluate(async () => {
    const path = "/tests/authorization-harness.tsx";
    return (await import(path)).mount(false, true);
  });
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
  return { dialog, bodies, submitted: () => submitted, ...data };
}

test("browser signs a coordinator solved result in Xverse without broadcasting or exporting the recovery secret", async ({
  page,
}) => {
  const { dialog, bodies, submitted } = await fixture(page);
  await expect(dialog).toContainText("nothing is broadcast");
  const backupDownload = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Save signing backup", exact: true })
    .click();
  const backup = await backupDownload;
  await expect(
    dialog.getByLabel("Verify updated signing backup"),
  ).toBeEnabled();
  await dialog
    .getByLabel("Verify updated signing backup")
    .setInputFiles({
      name: "signing.json",
      mimeType: "application/json",
      buffer: Buffer.from(await readFile((await backup.path())!, "utf8")),
    });
  const resultDownload = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Authorize and sign", exact: true })
    .click();
  const outcome = await Promise.race([
    resultDownload.then(() => "download" as const),
    dialog
      .getByRole("alert")
      .waitFor({ timeout: 15000 })
      .then(async () => `alert:${await dialog.getByRole("alert").innerText()}`),
  ]);
  expect(outcome).toBe("download");
  const download = await resultDownload;
  expect(download.suggestedFilename()).toMatch(
    /^qsb-coordinator-public-signed-result-[0-9a-f-]{36}\.json$/i,
  );
  const published = JSON.parse(
    await readFile((await download.path())!, "utf8"),
  );
  expect(published.format).toBe("qsb-coordinator-public-signed-result-v1");
  expect(published.helperSighash).toBe("SIGHASH_ALL");
  expect(published.rawTxHex).toMatch(/^(?:[a-f0-9]{2})+$/);
  expect(JSON.stringify(published)).not.toContain("fixture");
  expect(JSON.stringify(published)).not.toContain("passphrase");
  await expect(dialog).toContainText("Nothing was broadcast");
  expect(submitted()).toBe(false);
  expect(bodies.join("\n")).not.toContain("fixture");
  expect(bodies.join("\n")).not.toContain("browser authorization passphrase");
});
