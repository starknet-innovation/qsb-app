import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { BODY_HASH_HEADER, CREDENTIAL_HEADER, bodyHash, createSessionClient } from "../src/lib/session";

// Synthetic owners and sessions only; no wallet, chain or network.
const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const other = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20).fill(9) });
const tokens = { [owner]: "A".repeat(43), [other]: "C".repeat(43) };
// What CloudFront origin access control puts in Authorization: its own SigV4 signature.
const sigv4 =
  "AWS4-HMAC-SHA256 Credential=EXAMPLE/20261001/eu-west-2/lambda/aws4_request, SignedHeaders=host;x-amz-date, Signature=" +
  "0".repeat(64);

async function app() {
  const store = new MemoryStore();
  for (const address of [owner, other])
    await store.put({
      pk: `SESSION#${createHash("sha256").update(tokens[address]).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      owner: address,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  const server = createApp(store, { enabled: true, versionedAlias: true });
  // GET /vaults lists the signed-in owner's vaults: 200 with a session, 401 without.
  return (headers: Record<string, string>) => server.request("/v1/vaults", { headers });
}

describe("credential header", () => {
  it("authenticates with X-Qsb-Authorization, and with an Authorization bearer", async () => {
    const vaults = await app();
    expect((await vaults({ [CREDENTIAL_HEADER]: `Bearer ${tokens[owner]}` })).status).toBe(200);
    expect((await vaults({ Authorization: `Bearer ${tokens[owner]}` })).status).toBe(200);
    expect((await vaults({})).status).toBe(401);
  });

  it("reads the credential from X-Qsb-Authorization while CloudFront's signature is in Authorization", async () => {
    const vaults = await app();
    const signed = await vaults({ Authorization: sigv4, [CREDENTIAL_HEADER]: `Bearer ${tokens[owner]}` });
    expect(signed.status).toBe(200);
    // A signature alone is no credential.
    const unsigned = await vaults({ Authorization: sigv4 });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ code: "auth_required" });
  });

  it("reports the allowlist standing from X-Qsb-Authorization on /config", async () => {
    const store = new MemoryStore();
    await store.put({
      pk: `SESSION#${createHash("sha256").update(tokens[owner]).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      owner,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const server = createApp(store, {
      versionedAlias: true,
      ownerLimits: { allowlist: new Set([owner]), maxActiveJobs: null, maxGpuSeconds: null },
    });
    const config = async (headers: Record<string, string>) =>
      (await (await server.request("/v1/config", { headers })).json()).ownerLimits;
    expect(await config({ Authorization: sigv4, [CREDENTIAL_HEADER]: `Bearer ${tokens[owner]}` })).toMatchObject({
      allowlist: true,
      allowlisted: true,
    });
    expect(await config({ Authorization: sigv4 })).toMatchObject({ allowlist: true, allowlisted: null });
  });

  it("prefers X-Qsb-Authorization when both headers carry a bearer", async () => {
    const vaults = await app();
    const both = await vaults({
      Authorization: `Bearer ${tokens[other]}`,
      [CREDENTIAL_HEADER]: `Bearer ${"Z".repeat(43)}`,
    });
    // The unknown session in X-Qsb-Authorization decides, not the valid one in Authorization.
    expect(both.status).toBe(401);
    expect(await both.json()).toMatchObject({ code: "session_expired" });
  });
});

describe("session client", () => {
  it("sends the credential in X-Qsb-Authorization and each body's SHA-256", async () => {
    const sent: { method: string; headers: Headers; body?: string }[] = [];
    const client = createSessionClient(async (_input, init) => {
      sent.push({ method: init!.method!, headers: new Headers(init!.headers), body: init!.body as string | undefined });
      return new Response(JSON.stringify({ ok: true }));
    });
    client.restoreSession(tokens[owner]);
    await client.api("/vaults");
    await client.api("/vaults", { name: "cold-1" });
    const [read, write] = sent;
    expect(read.method).toBe("GET");
    expect(read.headers.get(CREDENTIAL_HEADER)).toBe(`Bearer ${tokens[owner]}`);
    expect(read.headers.get("Authorization")).toBeNull();
    expect(read.headers.get(BODY_HASH_HEADER)).toBeNull();
    expect(write.method).toBe("POST");
    expect(write.headers.get(BODY_HASH_HEADER)).toBe(createHash("sha256").update(write.body!).digest("hex"));
  });

  it("hashes exactly the bytes sent", async () => {
    expect(await bodyHash("")).toBe(createHash("sha256").update("").digest("hex"));
    const text = JSON.stringify({ name: "café ₿" });
    expect(await bodyHash(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
