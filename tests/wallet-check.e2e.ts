import { test, expect } from "@playwright/test";
test("synthetic signing requires opt-in, verifies both responses and makes no broadcast request", async ({
  page,
}) => {
  await page.route("**/src/lib/wallet.ts", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: "export const signPsbt = (...args) => window.testSign(...args); export const connectWallet=()=>{}; export const signMessage=()=>{};",
    }),
  );
  await page.route("https://**", (r) => r.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const path = "/tests/wallet-check-harness.tsx";
    (await import(path)).mount();
  });
  const section = page.getByRole("region", {
    name: "Wallet compatibility check",
  });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await expect(
    section.getByRole("button", { name: "Run wallet check" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).walletCheckCalls.length),
  ).toBe(0);
  await section.getByRole("checkbox").check();
  await section.getByRole("button", { name: "Run wallet check" }).click();
  const results = section.getByRole("status");
  await expect(results).toContainText("Complete-stack format check passed");
  await expect(results).toContainText("Funding synthetic signing passed");
  await expect(results).toContainText("Helper synthetic signing passed");
  await expect(section).toContainText("real withdrawal signing remains unverified");
  expect(
    await page.evaluate(() =>
      (window as any).walletCheckCalls.map((c: any) => c.indices),
    ),
  ).toEqual([[0], [0], [0]]);
  expect(writes).toEqual([]);
});

test("a failed check stops the run, and the remaining checks can be continued", async ({ page }) => {
  await page.route("**/src/lib/wallet.ts", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: "export const signPsbt = (...args) => window.testSign(...args); export const connectWallet=()=>{}; export const signMessage=()=>{};",
    }),
  );
  await page.route("https://**", (r) => r.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const path = "/tests/wallet-check-harness.tsx";
    (await import(path)).mount();
    const sign = (window as any).testSign;
    let declined = false;
    (window as any).testSign = (...args: unknown[]) => {
      if (!declined) {
        declined = true;
        (window as any).walletCheckCalls.push({ declined: true });
        return Promise.reject(new Error("User declined"));
      }
      return sign(...args);
    };
  });
  const section = page.getByRole("region", { name: "Wallet compatibility check" });
  await section.getByRole("checkbox").check();
  await section.getByRole("button", { name: "Run wallet check" }).click();
  const results = section.getByRole("status");
  await expect(results).toContainText("Check did not pass: User declined");
  await expect(results).toContainText("Not run");
  // Stopping after a declined request: no second prompt follows on its own.
  expect(await page.evaluate(() => (window as any).walletCheckCalls.length)).toBe(1);
  await section.getByRole("button", { name: "Continue with the remaining checks" }).click();
  await expect(results).toContainText("Complete-stack format check passed");
  await expect(results).toContainText("Helper synthetic signing passed");
  await expect(results).toContainText("Check did not pass: User declined");
  expect(await page.evaluate(() => (window as any).walletCheckCalls.length)).toBe(3);
});
