import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { ChainError } from "../server/chain";
import { MemoryStore } from "../server/store";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { CREDENTIAL_HEADER } from "../src/lib/session";

// Synthetic owner and session only; no wallet, chain or network.
const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const token = "A".repeat(43);

it("marks every API answer no-store, so no cache can serve an old one", async () => {
  const store = new MemoryStore();
  await store.put({
    pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    network: "mainnet",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  // The chain lookup fails, so /payment-utxos answers through the error handler.
  const chain = { paymentUtxos: async () => { throw new ChainError("Chain lookup failed (502). Retry before signing.", "chain_unavailable"); } };
  const app = createApp(store, { versionedAlias: true, chain: chain as never });
  const signedIn = { [CREDENTIAL_HEADER]: `Bearer ${token}` };
  for (const [path, headers, status] of [
    ["/v1/vaults", signedIn, 200],
    ["/api/vaults", signedIn, 200],
    ["/v1/health", {}, 200],
    ["/v1/vaults", {}, 401],
    ["/v1/no-such-route", signedIn, 404],
    ["/v1/payment-utxos", signedIn, 503],
  ] as const) {
    const response = await app.request(path, { headers });
    expect([path, response.status]).toEqual([path, status]);
    expect([path, response.headers.get("Cache-Control")]).toEqual([path, "no-store"]);
  }
});
