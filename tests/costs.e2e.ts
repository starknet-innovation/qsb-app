import { test, expect } from "@playwright/test";
test("costs distinguish unavailable charges and stale rates", async ({ page }) => {
  let unavailable = false;
  await page.route("**/v1/rates", route => route.fulfill({status: unavailable ? 503 : 200, contentType: "application/json", body: JSON.stringify(unavailable ? {error: "Unavailable"} : {effective_rate: 4, submit_fee_rate: 1})}));
  await page.goto("/");
  await page.getByRole("link", {name: "Costs", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Costs", exact: true})).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/costs");
  await expect(page.getByRole("region", {name:"Itemized costs"}).getByText("Customer billing is not enabled.", {exact:true})).toBeVisible();
  // Controls that can't do anything yet aren't shown.
  await expect(page.getByRole("button", {name: /Authorize compute budget/})).toHaveCount(0);
  await expect(page.getByText("MARA effective rate:")).toContainText("4 sat/vB");
  await expect(page.getByText("MARA effective rate:")).toContainText("Minimum accepted now: 1 sat/vB");
  unavailable = true;
  await page.getByRole("button", {name: "Refresh MARA rates"}).click();
  await expect(page.getByRole("alert")).toContainText("MARA rates unavailable");
  await expect(page.getByText("MARA effective rate:")).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/qsb-costs-mobile.png",fullPage:true});
});
