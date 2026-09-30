import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";

// The network is fixed when the modules load, so load a fresh copy for testnet4.
vi.stubEnv("QSB_NETWORK", "testnet4");
vi.resetModules();
const { QsbClient, loopbackTestSigner } = await import("../sdk");

it("refuses withdrawal assembly and submit off mainnet before any request", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ network: "testnet4" })));
  const signer = loopbackTestSigner(randomBytes(32), "http://127.0.0.1:8787");
  expect(signer.address.startsWith("tb1q")).toBe(true);
  const client = new QsbClient({ baseUrl: "http://127.0.0.1:8787", signer, fetch: fetch as never });
  await expect(
    client.withdrawals.assemble(crypto.randomUUID(), { backup: "{}", passphrase: "unused passphrase", saveBackup: async () => {} }),
  ).rejects.toThrow("mainnet only");
  await expect(client.withdrawals.submit({} as never, { approve: () => undefined })).rejects.toThrow("mainnet only");
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
