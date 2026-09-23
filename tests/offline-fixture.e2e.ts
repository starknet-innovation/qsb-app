import { test, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
test("fresh offline fixture encrypts, reimports, and exports public-only request", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        network: "mainnet",
        mainnetEnabled: false,
        operationsEnabled: false,
        checks: [],
      },
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const harnessPath = "/tests/offline-fixture-harness.tsx";
    const harness = await import(/* @vite-ignore */ harnessPath);
    harness.mount();
  });
  await expect(
    page.getByRole("heading", {
      name: "Prepare the definitive offline signing test",
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("checkbox").check();
  await page
    .getByLabel("Private backup passphrase", { exact: true })
    .fill("disposable browser test password");
  await page
    .getByLabel("Confirm passphrase")
    .fill("disposable browser test password");
  await page
    .getByRole("button", { name: "Generate offline fixture", exact: true })
    .click();
  const privateDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download private backup — keep it private" })
    .click({ timeout: 110000 });
  const backup = await privateDownload,
    path = (await backup.path())!;
  expect(backup.suggestedFilename()).toMatch(/^qsb-offline-private-backup-/);
  await page
    .getByLabel("Backup passphrase", { exact: true })
    .fill("disposable browser test password");
  await page
    .getByLabel("Reimport the downloaded private backup")
    .setInputFiles(path);
  const publicDownload = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download public request — share this file only",
    })
    .click();
  const exported = await publicDownload;
  const parsed = JSON.parse(await readFile((await exported.path())!, "utf8"));
  expect(parsed.format).toBe("qsb-offline-fixture-request-v1");
  expect(parsed.fixtureChain).toBe("regtest");
  expect(parsed.id).toBe(parsed.vault.id);
  expect(JSON.stringify(parsed)).not.toMatch(
    /hors_secrets|pin_k|ciphertext|"stateJson"/,
  );
  expect(parsed.vault.name).toBe("Offline signing test — never fund");
  expect(errors).toEqual([]);
  // Optional public-only handoff for the offline Core integration test.
  if (process.env.QSB_PUBLIC_SMOKE_REQUEST) {
    await mkdir(dirname(process.env.QSB_PUBLIC_SMOKE_REQUEST), { recursive: true });
    await writeFile(process.env.QSB_PUBLIC_SMOKE_REQUEST, JSON.stringify(parsed));
  }
});
