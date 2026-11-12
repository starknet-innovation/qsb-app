import { expect, test } from "@playwright/test";

test("PQB generation and encrypted recovery stay local and work in a fresh browser context", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const writes: string[] = [];
  await context.route("**/*", async route => {
    if (route.request().method() !== "GET") { writes.push(route.request().url()); await route.abort(); }
    else if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) await route.abort();
    else await route.continue();
  });
  let fixture: { backup: string; hash: string };
  try {
    const page = await context.newPage();
    const workers: string[] = []; page.on("worker", worker => workers.push(worker.url()));
    await page.goto("/");
    fixture = await page.evaluate(async () => {
      const runtime = await import("/src/lib/qsb.ts" as string), backup = await import("/src/lib/backup.ts" as string);
      const { withVaultConfiguration } = await import("/src/lib/provenance.ts" as string);
      const g = await runtime.generateQsb("PQB");
      const r = { format: "qsb-recovery-v1", stateJson: g.stateJson, vault: withVaultConfiguration({
        id: crypto.randomUUID(), name: "Unfunded PQB browser fixture", createdAt: new Date().toISOString(),
        network: "mainnet", config: "PQB", scriptHex: g.scriptHex, scriptHash: g.scriptHash,
        paymentAddress: "bc1qunfundedpublicfixtureonly000000000", publicStateJson: g.publicStateJson, status: "unfunded",
      }) };
      if (g.scriptHex.length !== 9816 || g.publicStateJson.includes(JSON.parse(g.stateJson).seed)) throw Error("Invalid PQB public state");
      const encrypted = await backup.encryptRecovery(r, "disposable browser PQB passphrase");
      runtime.lockQsb(); return { backup: encrypted, hash: g.scriptHash };
    });
    expect(workers.some(url => url.includes("qsb-worker"))).toBe(true);
  } finally { await context.close(); }
  const cold = await browser.newContext({ baseURL, serviceWorkers: "block" });
  await cold.route("**/*", async route => {
    if (route.request().method() !== "GET") { writes.push(route.request().url()); await route.abort(); }
    else if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) await route.abort();
    else await route.continue();
  });
  try {
    const page = await cold.newPage();
    const workers: string[] = []; page.on("worker", worker => workers.push(worker.url()));
    await page.goto("/");
    const hash = await page.evaluate(async text => {
      const runtime = await import("/src/lib/qsb.ts" as string), backup = await import("/src/lib/backup.ts" as string);
      const restored = await backup.decryptRecovery(text, "disposable browser PQB passphrase");
      const hash = await runtime.validateRecovery(restored.stateJson); runtime.lockQsb(); return hash;
    }, fixture!.backup);
    expect(hash).toBe(fixture!.hash); expect(writes).toEqual([]);
    expect(workers.some(url => url.includes("qsb-worker"))).toBe(true);
  } finally { await cold.close(); }
});
