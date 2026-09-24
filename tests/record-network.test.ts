import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { vaultConfiguration } from "../supervised/runtime/source/outputs/qsb-vault/src/lib/provenance";

const token = "b".repeat(43);
const sessionPk = "SESSION#" + createHash("sha256").update(token).digest("hex");

it("rejects a challenge, session, and vault that omit network", async () => {
  const store = new MemoryStore();
  const app = createApp(store);
  await store.put({
    pk: "CHALLENGE#00000000-0000-4000-8000-000000000001",
    sk: "AUTH",
    version: 0,
    address: "addr",
    message: "QSB",
  });
  expect(
    (
      await app.request(
        new Request("http://localhost/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            signature: "aa",
          }),
        }),
      )
    ).status,
  ).toBe(401);
  await store.put({
    pk: sessionPk,
    sk: "AUTH",
    version: 0,
    owner: "owner",
  });
  expect(
    (
      await app.request(
        new Request("http://localhost/api/vaults", {
          headers: { authorization: "Bearer " + token },
        }),
      )
    ).status,
  ).toBe(401);
  await store.put(
    {
      pk: sessionPk,
      sk: "AUTH",
      version: 1,
      owner: "owner",
      network: "mainnet",
    },
    0,
  );
  await store.put({
    pk: "OWNER#owner",
    sk: "VAULT#vault",
    version: 0,
    vault: { id: "vault" },
  });
  const funding = await app.request(
    new Request("http://localhost/api/vaults/vault/funding", {
      headers: { authorization: "Bearer " + token },
    }),
  );
  expect(funding.status).toBe(409);
  expect(await funding.json()).toMatchObject({
    error: "Vault belongs to a different Bitcoin network.",
  });
});

it("the packaged runtime refuses a vault configuration with no network", () => {
  expect(() =>
    vaultConfiguration({
      config: "A",
      scriptHex: "51",
      scriptHash: "aa",
      publicStateJson: "{}",
    }),
  ).toThrow("Unsupported QSB network configuration");
});
