import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type SubmitOptions = {
  enabled?: boolean;
  submitDisabled?: boolean;
  minerFloor?: number;
  /** The API's own error answer to the submit POST. */
  submitFailure?: { status: number; json: { error: string; code: string } };
};
async function fixture(
  page: Page,
  options: SubmitOptions = {},
) {
  const bodies: string[] = [];
  let submitted = 0;
  let lastBody: { rawTxHex: string } | undefined;
  await page.route("**/v1/rates", (route) =>
    route.fulfill({ json: { submit_fee_rate: options.minerFloor ?? 1 } }),
  );
  await page.route("**/v1/config", (route) =>
    route.fulfill({ json: { exactSubmitEnabled: options.enabled === true } }),
  );
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
    export async function connectWallet(){throw new Error('No wallet');}
    export async function signMessage(){throw new Error('No wallet');}
  `,
    }),
  );
  let previousTxHex = "";
  await page.route("**/v1/vaults/*/funding", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/v1/payment-input", (route) =>
    route.fulfill({ json: { previousTxHex } }),
  );
  await page.route("**/v1/jobs/*/submit", async (route) => {
    submitted++;
    lastBody = route.request().postDataJSON();
    if (options.submitDisabled)
      return route.fulfill({
        status: 503,
        json: { error: "Exact submission is disabled." },
      });
    if (options.submitFailure) return route.fulfill(options.submitFailure);
    const txid = await page.evaluate(async (raw: string) => {
      const p = "/node_modules/.vite/deps/@scure_btc-signer.js";
      const btc = await import(p);
      return btc.Transaction.fromRaw(
        Uint8Array.from(raw.match(/../g)!.map((x) => parseInt(x, 16))),
        { allowUnknownInputs: true, allowUnknownOutputs: true },
      ).id;
    }, lastBody!.rawTxHex);
    await route.fulfill({ json: { txid, status: "submitted" } });
  });
  await page.goto("/");
  const data = await page.evaluate(async () => {
    const path = "/tests/authorization-harness.tsx";
    return (await import(path)).mount(false, true);
  });
  previousTxHex = data.previousTxHex;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Recovery backup", { exact: true }).setInputFiles({
    name: "intent.json",
    mimeType: "application/json",
    buffer: Buffer.from(data.backup),
  });
  await dialog.getByLabel("Backup passphrase").fill(data.password);
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Recovery backup verified");
  await dialog.getByRole("checkbox").check();
  return {
    dialog,
    bodies,
    submitted: () => submitted,
    lastBody: () => lastBody,
    ...data,
  };
}

test("browser signs a coordinator solved result in Xverse without broadcasting or exporting the recovery secret", async ({
  page,
}) => {
  const { dialog, bodies, submitted } = await fixture(page);
  await expect(dialog).toContainText("Signing does not broadcast");
  const backupDownload = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Save signing backup", exact: true })
    .click();
  const backup = await backupDownload;
  await expect(
    dialog.getByLabel("Verify updated signing backup"),
  ).toBeEnabled();
  await dialog.getByLabel("Verify updated signing backup").setInputFiles({
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
  await expect(dialog).toContainText("nothing was broadcast");
  expect(submitted()).toBe(0);
  expect(bodies.join("\n")).not.toContain("fixture");
  expect(bodies.join("\n")).not.toContain("browser authorization passphrase");
});

async function signForReview(
  page: Page,
  options: SubmitOptions = {},
) {
  const f = await fixture(page, options);
  const backupEvent = page.waitForEvent("download");
  await f.dialog
    .getByRole("button", { name: "Save signing backup", exact: true })
    .click();
  const backup = await backupEvent;
  await f.dialog
    .getByLabel("Verify updated signing backup")
    .setInputFiles({
      name: "signing.json",
      mimeType: "application/json",
      buffer: Buffer.from(await readFile((await backup.path())!, "utf8")),
    });
  const signedEvent = page.waitForEvent("download");
  await f.dialog
    .getByRole("button", { name: "Authorize and sign", exact: true })
    .click();
  const signed = JSON.parse(
    await readFile((await (await signedEvent).path())!, "utf8"),
  );
  await expect(
    f.dialog.getByRole("region", { name: "Exact transaction approval" }),
  ).toContainText(signed.txid);
  return { ...f, signed };
}
test("explicit exact approval submits once even with same-tick double click", async ({
  page,
}) => {
  const f = await signForReview(page, { enabled: true });
  expect(f.submitted()).toBe(0);
  await expect(f.dialog).toContainText("0.00110000 BTC");
  await expect(f.dialog).toContainText("0.00010000 BTC");
  const approve = f.dialog.getByRole("button", {
    name: "Approve exact transaction and submit",
  });
  await expect(approve).toBeEnabled();
  await approve.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(f.dialog.getByRole("status")).toContainText(
    `submitted: ${f.signed.txid}`,
  );
  expect(f.submitted()).toBe(1);
  expect(f.lastBody()).toEqual({ rawTxHex: f.signed.rawTxHex });
  await expect(approve).toBeDisabled();
});
test("cancel after signing never submits", async ({ page }) => {
  const f = await signForReview(page, { enabled: true });
  await f.dialog.getByRole("button", { name: "Cancel submission" }).click();
  await expect(f.dialog).not.toBeVisible();
  expect(f.submitted()).toBe(0);
});
test("switch off leaves only a signed download with submission disabled", async ({
  page,
}) => {
  const f = await signForReview(page);
  await expect(f.dialog.getByRole("status")).toContainText(
    "Submission is disabled",
  );
  await expect(
    f.dialog.getByRole("button", {
      name: "Approve exact transaction and submit",
    }),
  ).toBeDisabled();
  await expect(
    f.dialog.getByRole("button", { name: "Download signed result again" }),
  ).toBeEnabled();
  expect(f.submitted()).toBe(0);
});
test("503 preserves signed download and disables further submission", async ({
  page,
}) => {
  const f = await signForReview(page, { enabled: true, submitDisabled: true });
  const approve = f.dialog.getByRole("button", {
    name: "Approve exact transaction and submit",
  });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(f.dialog.getByRole("status")).toContainText(
    "Submission is disabled",
  );
  await expect(approve).toBeDisabled();
  await expect(
    f.dialog.getByRole("button", { name: "Download signed result again" }),
  ).toBeEnabled();
  expect(f.submitted()).toBe(1);
});
// A failed chain or miner request is a 502 or 503 with its code (docs/API.md). The outcome
// stays uncertain: only the disabled refusal says nothing was accepted.
for (const submitFailure of [
  { status: 502, json: { error: "Unable to complete the request. Please retry.", code: "miner_request_failed" } },
  { status: 503, json: { error: "Miner API credential is unavailable. Contact the service operator.", code: "miner_unavailable" } },
  { status: 503, json: { error: "Chain lookup failed (500). Retry before signing.", code: "chain_unavailable" } },
])
  test(`a ${submitFailure.status} ${submitFailure.json.code} from submit is uncertain, never disabled`, async ({
    page,
  }) => {
    const f = await signForReview(page, { enabled: true, submitFailure });
    const approve = f.dialog.getByRole("button", {
      name: "Approve exact transaction and submit",
    });
    await approve.click();
    const status = f.dialog.getByRole("status");
    await expect(status).toContainText("Submission outcome is uncertain");
    await expect(status).toContainText("Do not submit again.");
    await expect(status).not.toContainText("Submission is disabled");
    await expect(approve).toBeDisabled();
    await expect(
      f.dialog.getByRole("button", { name: "Download signed result again" }),
    ).toBeEnabled();
    expect(f.submitted()).toBe(1);
  });
test("wallet session change after signing prevents approval from posting", async ({
  page,
}) => {
  const f = await signForReview(page, { enabled: true });
  await expect(
    f.dialog.getByRole("button", {
      name: "Approve exact transaction and submit",
    }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const modulePath = "/src/lib/api.ts";
    (await import(modulePath)).clearSession();
  });
  await f.dialog
    .getByRole("button", { name: "Approve exact transaction and submit" })
    .click();
  await expect(f.dialog.getByRole("alert")).toContainText(
    "Wallet session changed",
  );
  expect(f.submitted()).toBe(0);
});

test("a signed rate below MARA's current floor submits nothing", async ({ page }) => {
  const f = await signForReview(page, { enabled: true, minerFloor: 1000 });
  await expect(f.dialog).toContainText(/Signed size: [\d,]+ vB · about [\d.]+ sat\/vB/);
  await f.dialog.getByRole("button", { name: "Approve exact transaction and submit" }).click();
  await expect(f.dialog).toContainText("below MARA's current minimum of 1000 sat/vB. Nothing was submitted.");
  expect(f.submitted()).toBe(0);
});
