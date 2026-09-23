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
    section.getByRole("button", { name: "Check funding signature" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).walletCheckCalls.length),
  ).toBe(0);
  await section.getByRole("checkbox").check();
  await section
    .getByRole("button", { name: "Check funding signature" })
    .click();
  await expect(section.getByRole("status")).toContainText(
    "Funding synthetic signing passed",
  );
  await section.getByRole("button", { name: "Check helper signature" }).click();
  await expect(section.getByRole("status")).toContainText(
    "Helper synthetic signing passed",
  );
  await section.getByRole("button", { name: "Check complete-stack signing" }).click();
  await expect(section.getByRole("status")).toContainText("Complete-stack format check passed");
  await expect(section.getByRole("status")).toContainText("Real withdrawal signing remains unverified");
  expect(
    await page.evaluate(() =>
      (window as any).walletCheckCalls.map((c: any) => c.indices),
    ),
  ).toEqual([[0], [0], [0]]);
  expect(writes).toEqual([]);
});
