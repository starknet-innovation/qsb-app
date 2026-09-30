import { test, expect } from "@playwright/test";
test("working surface, navigation, wallet absence and readiness", async ({
  page,
}) => {
  // The mainnet app calls the API under /v1 only; the dev proxy reaches the local API.
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  const config = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/config");
  await page.goto("/");
  expect(await (await config).json()).toMatchObject({ network: "mainnet" });
  await expect(page.getByRole("heading", { name: "My vaults" })).toBeVisible();
  await page
    .getByRole("button", { name: "Connect Xverse", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Install or unlock");
  // The header status reads the server's switches; the local API has them off.
  await page.getByRole("button", { name: "Deposits and withdrawals off" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Full withdrawal consensus validation",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Recovery", exact: true }).click();
  expect(new URL(page.url()).hash).toBe("#/recovery");
  await expect(
    page.getByRole("heading", { name: "Restore a recovery file" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "My vaults", exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/qsb-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Connect Xverse to begin" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/qsb-mobile.png",
    fullPage: true,
  });
  expect(paths.filter((p) => p === "/api" || p.startsWith("/api/"))).toEqual([]);
});
test("real browser QSB generation, backup encryption and restore", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const qsbPath = "/src/lib/qsb.ts",
      backupPath = "/src/lib/backup.ts",
      provenancePath = "/src/lib/provenance.ts";
    const qsb = await import(qsbPath);
    const backup = await import(backupPath);
    const provenance = await import(provenancePath);
    const r = await qsb.generateQsb();
    const digest = await qsb.validateRecovery(r.stateJson);
    const state = JSON.parse(r.stateJson);
    const publicState = JSON.parse(r.publicStateJson);
    const data = {
      format: "qsb-recovery-v1",
      stateJson: r.stateJson,
      vault: provenance.withVaultConfiguration({
        id: crypto.randomUUID(),
        name: "Browser test",
        createdAt: new Date().toISOString(),
        network: "mainnet",
        config: "A",
        scriptHex: r.scriptHex,
        scriptHash: r.scriptHash,
        paymentAddress: "bc1qexampleaddressfortestonly00000000",
        publicStateJson: r.publicStateJson,
        status: "unfunded",
      }),
    };
    const text = await backup.encryptRecovery(
      data,
      "browser integration passphrase",
    );
    const restored = await backup.decryptRecovery(
      text,
      "browser integration passphrase",
    );
    qsb.lockQsb();
    return {
      length: r.scriptHex.length / 2,
      matches: digest === r.scriptHash && restored.stateJson === r.stateJson,
      hasSecrets: !!state.hors_secrets,
      publicSecrets: !!publicState.hors_secrets,
      encrypted: text.includes("hors_secrets"),
    };
  });
  expect(result).toEqual({
    length: 9923,
    matches: true,
    hasSecrets: true,
    publicSecrets: false,
    encrypted: false,
  });
});

test("withdrawal dialog restores locally and saves the exact encrypted payout before starting compute", async ({
  page,
}) => {
  const btc = await import("@scure/btc-signer");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const address = btc.p2wpkh(
    secp256k1.getPublicKey(new Uint8Array(32).fill(8)),
  ).address!;
  let vault: any, submitted: any;
  await page.route("**/v1/config", (route) =>
    route.fulfill({ json: { network: "mainnet", operationsEnabled: true, solverReleaseId: "browser-served-test" } }),
  );
  await page.route("**/v1/rates", (route) =>
    route.fulfill({ json: { submit_fee_rate: 1 } }),
  );
  await page.route("**/v1/payment-utxos", (route) =>
    route.fulfill({
      json: { utxos: [{ txid: "22".repeat(32), vout: 0, value: "10000" }] },
    }),
  );
  await page.route("**/v1/vaults/*/funding", (route) =>
    route.fulfill({ json: { vault, status: { confirmed: true } } }),
  );
  await page.route("**/v1/jobs", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: { job: { id: submitted.idempotencyKey } },
    });
  });
  await page.goto("/");
  const fixture = await page.evaluate(async (address) => {
    const path = "/tests/dialog-harness.tsx";
    return (await import(path)).mount(address);
  }, address);
  vault = fixture.vault;
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Recovery backup", { exact: true })
    .setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(fixture.backup),
    });
  await dialog.getByLabel("Backup passphrase").fill("wrong passphrase");
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Unable to unlock");
  expect(submitted).toBeUndefined();
  await dialog
    .getByLabel("Backup passphrase")
    .fill("browser transaction passphrase");
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  await expect(dialog).toContainText("Recovery backup verified");
  await dialog.getByRole("radio").check();
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  const estimate = (await dialog.locator(".fee-estimate").textContent()) ?? "";
  const fee = Number(/miner fee ([\d,]+) sats/.exec(estimate)?.[1].replace(/,/g, ""));
  expect(fee).toBeGreaterThan(0);
  await expect(dialog).toContainText("You receive");
  await dialog.getByRole("button", { name: "Review withdrawal" }).click();
  await expect(dialog).toContainText(`qsb-recovery-${vault.id}-withdrawal.json`);
  await dialog.getByRole("checkbox").check();
  const downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Save backup and start search" })
    .click();
  const download = await downloaded;
  await expect(dialog).toContainText("Keep the updated withdrawal backup");
  expect(submitted.solverReleaseId).toBe("browser-served-test");
  expect(submitted.fee).toBe(String(fee));
  expect(submitted.outputValue).toBe(String(110_000 - fee));
  expect(submitted.destination).toBe(address);
  expect(JSON.stringify(submitted)).not.toContain("hors_secrets");
  const fs = await import("node:fs/promises");
  const text = await fs.readFile((await download.path())!, "utf8");
  const intent = await page.evaluate(async (text) => {
    const path = "/src/lib/backup.ts";
    return (
      await (
        await import(path)
      ).decryptRecovery(text, "browser transaction passphrase")
    ).authorization;
  }, text);
  expect(JSON.parse(intent.manifestJson)).toEqual(submitted);
  const { createHash } = await import("node:crypto");
  expect(intent.manifestHash).toBe(
    createHash("sha256").update(intent.manifestJson).digest("hex"),
  );
});
