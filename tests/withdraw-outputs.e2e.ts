import { test, expect, type Page } from "@playwright/test";

// The withdrawal dialog's helper outputs. Each read of /v1/payment-utxos takes the next answer from
// `reads`: a list of output numbers, "fail" (a 503), or "hold" (until release() answers it).
type Read = number[] | "fail";
async function serve(page: Page, reads: (Read | "hold")[]) {
  let held: ((answer: Read) => void) | undefined;
  let submitted: unknown, vault: unknown;
  await page.route("**/v1/config", (route) =>
    route.fulfill({ json: { network: "mainnet", operationsEnabled: true, solverReleaseId: "browser-served-test" } }),
  );
  await page.route("**/v1/rates", (route) => route.fulfill({ json: { submit_fee_rate: 1 } }));
  await page.route("**/v1/payment-utxos", async (route) => {
    let next = reads.shift();
    if (next === undefined) throw Error("Unexpected read of the payment outputs");
    if (next === "hold") next = await new Promise<Read>((resolve) => (held = resolve));
    return next === "fail"
      ? route.fulfill({ status: 503, json: { error: "CHAIN_DOWN", code: "chain_unavailable" } })
      : route.fulfill({ json: { utxos: next.map((vout) => ({ txid: "22".repeat(32), vout, value: "10000" })) } });
  });
  await page.route("**/v1/vaults/*/funding", (route) => route.fulfill({ json: { vault, status: { confirmed: true } } }));
  await page.route("**/v1/jobs", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { job: { id: (submitted as any).idempotencyKey } } });
  });
  return {
    // The page shows a read as pending as soon as it asks, before the request reaches the route.
    async release(answer: Read) {
      await expect.poll(() => held !== undefined).toBe(true);
      held!(answer);
      held = undefined;
    },
    submitted: () => submitted,
    funded(v: unknown) {
      vault = v;
    },
  };
}
async function destination() {
  const btc = await import("@scure/btc-signer");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  return btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(8))).address!;
}
// Mounts the dialog (a new vault, or `vault` again after a reload) and verifies `backup`, or the
// new vault's own backup.
async function unlock(page: Page, address: string, vault?: unknown, backup?: string) {
  const fixture = await page.evaluate(
    async ({ address, vault }) => {
      const path = "/tests/dialog-harness.tsx";
      return (await import(path)).mount(address, vault);
    },
    { address, vault },
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Recovery backup", { exact: true }).setInputFiles({
    name: "recovery.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup ?? fixture.backup),
  });
  await dialog.getByLabel("Backup passphrase").fill("browser transaction passphrase");
  await dialog.getByRole("button", { name: "Verify backup locally" }).click();
  // Unlocking derives the backup's key and checks its script, which can take a while.
  await expect(dialog).toContainText("Recovery backup verified", { timeout: 60_000 });
  return { dialog, vault: fixture.vault };
}

test("a failed read of the helper outputs says so, and Refresh reads again", async ({ page }) => {
  await serve(page, ["fail", "fail", [0]]);
  await page.goto("/");
  const { dialog } = await unlock(page, await destination());
  await expect(dialog.getByRole("alert")).toContainText("Couldn't read your wallet's confirmed outputs: CHAIN_DOWN");
  await expect(dialog).not.toContainText("No confirmed payment outputs");
  await expect(dialog.locator(".blocker")).toHaveText("Couldn't read your wallet's confirmed outputs. Refresh them to continue.");
  await expect(dialog.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await expect(dialog).not.toContainText("Couldn't read");
  await dialog.getByRole("radio").check();
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  await expect(dialog.getByRole("button", { name: "Review withdrawal" })).toBeEnabled();
});

test("while the helper outputs are read, the hint says so rather than that one is missing", async ({ page }) => {
  const outputs = await serve(page, [[0], "hold"]);
  await page.goto("/");
  const { dialog } = await unlock(page, await destination());
  await expect(dialog.locator(".blocker")).toHaveText("Reading your wallet's confirmed outputs…");
  await expect(dialog.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
  await outputs.release([0]);
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await expect(dialog.locator(".blocker")).toHaveText("Choose one helper output.");
});

test("a saved intent keeps its helper when a read leaves it out, and resumes once it's back", async ({ page }) => {
  // Save a withdrawal backup (its intent fixes helper 0), as starting the search does.
  const outputs = await serve(page, [[0], [0], [], "hold", [0]]);
  await page.goto("/");
  const address = await destination();
  const { dialog, vault } = await unlock(page, address);
  outputs.funded(vault);
  await dialog.getByRole("radio").check();
  await dialog.getByLabel("Miner fee rate (sat/vB)").fill("2");
  await dialog.getByRole("button", { name: "Review withdrawal" }).click();
  await dialog.getByRole("checkbox").check();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save backup and start search" }).click();
  const fs = await import("node:fs/promises");
  const saved = await fs.readFile((await (await downloaded).path())!, "utf8");
  // The backup is saved before the search is asked for: wait for that too.
  await expect(dialog).toContainText("Keep the updated withdrawal backup");
  const first = outputs.submitted();
  expect(first).toBeDefined();
  // Reopen with it (say POST /jobs failed) while the helper isn't among the confirmed outputs.
  await page.reload();
  await unlock(page, address, vault, saved);
  // Not "isn't among your outputs" while the read is pending: that's known only once it answers.
  await expect(dialog.locator(".blocker")).toHaveText("Reading your wallet's confirmed outputs…");
  await outputs.release([]);
  await expect(dialog.locator(".blocker")).toHaveText(
    "The helper output this backup fixed isn't among your wallet's confirmed outputs.",
  );
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh outputs" }).click();
  // Back: still the intent's helper, chosen and locked, so the same intent is retried.
  await expect(dialog.getByRole("radio")).toBeChecked();
  await expect(dialog.getByRole("radio")).toBeDisabled();
  await dialog.getByRole("button", { name: "Review withdrawal" }).click();
  await dialog.getByRole("checkbox").check();
  const again = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save backup and start search" }).click();
  await again;
  await expect(dialog).toContainText("Keep the updated withdrawal backup");
  expect(outputs.submitted()).toEqual(first);
});
