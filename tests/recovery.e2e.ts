import { expect, test } from "@playwright/test";

test("cold recovery restores an encrypted disposable vault locally in a fresh browser context", async ({
  browser,
  baseURL,
}) => {
  const password = "disposable cold recovery drill passphrase";
  const generation = await browser.newContext({
    baseURL,
    serviceWorkers: "block",
  });
  let fixture: { backup: string; id: string; fingerprint: string };
  try {
    const page = await generation.newPage();
    await page.goto("/");
    fixture = await page.evaluate(async (password) => {
      const qsbPath = "/src/lib/qsb.ts",
        backupPath = "/src/lib/backup.ts";
      const qsb = await import(qsbPath),
        backup = await import(backupPath);
      // Generate real disposable HORS state in the application's Pyodide worker.
      // Only encrypted backup text and public identifiers leave this context.
      const generated = await qsb.generateQsb();
      const id = crypto.randomUUID();
      const recovery = {
        format: "qsb-recovery-v1",
        stateJson: generated.stateJson,
        vault: {
          id,
          name: "Cold recovery drill",
          createdAt: new Date().toISOString(),
          network: "mainnet",
          config: "A",
          scriptHex: generated.scriptHex,
          scriptHash: generated.scriptHash,
          paymentAddress: "bc1qdisposableunfundedfixtureonly000000",
          publicStateJson: generated.publicStateJson,
          status: "unfunded",
        },
      };
      const encrypted = await backup.encryptRecovery(recovery, password);
      qsb.lockQsb();
      return { backup: encrypted, id, fingerprint: generated.scriptHash };
    }, password);
  } finally {
    // Destroy the entire original context, including workers, cookies and storage.
    await generation.close();
  }
  expect(JSON.parse(fixture!.backup).format).toBe("qsb-encrypted-v1");
  expect(fixture!.backup).not.toContain("hors_secrets");
  expect(fixture!.fingerprint).toMatch(/^[a-f0-9]{64}$/);

  const restored = await browser.newContext({
    baseURL,
    serviceWorkers: "block",
  });
  const blockedWrites: { method: string; url: string }[] = [];
  const requestedUrls: string[] = [];
  try {
    // Observe the whole new context, including worker requests. Fail closed on
    // every non-GET request so this drill cannot upload or mutate any API state.
    await restored.route("**/*", async (route) => {
      const request = route.request();
      requestedUrls.push(request.url());
      if (request.method() !== "GET") {
        blockedWrites.push({ method: request.method(), url: request.url() });
        await route.abort("blockedbyclient");
      } else if (new URL(request.url()).origin !== new URL(baseURL!).origin) {
        // The UI currently requests Google Fonts; restoration must also work
        // with that optional styling request blocked.
        await route.abort("blockedbyclient");
      } else {
        await route.continue();
      }
    });
    await restored.addInitScript(() => {
      const OriginalWorker = window.Worker;
      (window as any).__recoveryWorkerTerminations = 0;
      window.Worker = class extends OriginalWorker {
        override terminate() {
          (window as any).__recoveryWorkerTerminations++;
          super.terminate();
        }
      };
    });
    const page = await restored.newPage();
    await page.goto("/");
    expect(await restored.cookies()).toEqual([]);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await page.getByRole("button", { name: "Recovery", exact: true }).click();
    await page.getByLabel("Recovery file", { exact: true }).setInputFiles({
      name: "disposable-cold-recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(fixture!.backup),
    });
    await page
      .getByLabel("Recovery passphrase", { exact: true })
      .fill("incorrect disposable password");
    await page.getByRole("button", { name: "Restore on this device" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Unable to unlock this backup",
    );
    await expect(
      page.getByText("Cold recovery drill verified", { exact: true }),
    ).toHaveCount(0);
    expect(blockedWrites).toEqual([]);

    await page
      .getByLabel("Recovery passphrase", { exact: true })
      .fill(password);
    await page.getByRole("button", { name: "Restore on this device" }).click();
    await expect(
      page.getByText("Cold recovery drill verified", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Vault ID: ${fixture!.id}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Script fingerprint: ${fixture!.fingerprint}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Recovery passphrase", { exact: true }),
    ).toHaveValue("");
    expect(
      await page.evaluate(() => (window as any).__recoveryWorkerTerminations),
    ).toBe(1);
    expect(blockedWrites).toEqual([]);
    // In addition to blocking write methods, inspect GET URLs for accidental
    // plaintext/encrypted-backup transmission and require local runtime loads.
    expect(
      requestedUrls.some((url) => new URL(url).pathname === "/qsb/bridge.py"),
    ).toBe(true);
    const external = requestedUrls.filter(
      (url) => new URL(url).origin !== new URL(baseURL!).origin,
    );
    expect(
      external.every(
        (url) =>
          new URL(url).hostname === "fonts.googleapis.com" &&
          new URL(url).pathname === "/css2",
      ),
    ).toBe(true);
    for (const url of requestedUrls) {
      const decoded = decodeURIComponent(url);
      expect(decoded).not.toContain(password);
      expect(decoded).not.toContain("hors_secrets");
      expect(decoded).not.toContain(JSON.parse(fixture!.backup).ciphertext);
    }
    await page.getByRole("button", { name: "Clear recovery result" }).click();
    await expect(
      page.getByText(`Vault ID: ${fixture!.id}`, { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Choose encrypted recovery file", { exact: true }),
    ).toBeVisible();
  } finally {
    await restored.close();
  }
});
