import { describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { encryptRecovery } from "../src/lib/backup";
import {
  createOfflineRequest,
  verifyOfflineBackup,
} from "../src/lib/offline-fixture";
import { lockQsb, validateRecovery } from "../src/lib/qsb";
vi.mock("../src/lib/qsb", () => ({
  lockQsb: vi.fn(),
  validateRecovery: vi.fn(),
}));
const pub =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const wallet = {
  address: btc.p2wpkh(hex.decode(pub)).address!,
  publicKey: pub,
  type: "p2wpkh",
};
function fixture() {
  const scriptHex = "51".repeat(100),
    scriptHash = hex.encode(sha256(hex.decode(scriptHex)));
  const state = {
    config: "A",
    hash_mode: "sha256",
    n: 150,
    t1s: 8,
    t1b: 1,
    t2s: 7,
    t2b: 2,
    hors_commitments: Array.from({ length: 2 }, () =>
      Array(150).fill("00".repeat(20)),
    ),
    dummy_sigs: Array.from({ length: 2 }, () => Array(150).fill("3000")),
    pin_r: 1,
    pin_s: 1,
    pin_sig: "3000",
    round_sigs: [
      { r: 1, s: 1, sig: "3000" },
      { r: 1, s: 1, sig: "3000" },
    ],
    full_script_hex: scriptHex,
  };
  return {
    id: crypto.randomUUID(),
    name: "Offline signing test — never fund",
    createdAt: new Date().toISOString(),
    network: "mainnet" as const,
    config: "A" as const,
    scriptHex,
    scriptHash,
    publicStateJson: JSON.stringify(state),
    paymentAddress: wallet.address,
    status: "unfunded" as const,
  };
}
describe("offline fixture public boundary", () => {
  it("exports only public data and preserves original arbitrary precision JSON text", () => {
    const vault = fixture();
    vault.publicStateJson = vault.publicStateJson.replace(
      '"pin_r":1',
      '"pin_r":123456789012345678901234567890',
    );
    const result = createOfflineRequest(wallet, vault);
    expect(result.id).toBe(vault.id);
    expect(result.fixtureChain).toBe("regtest");
    expect(result.vault.publicStateJson).toBe(vault.publicStateJson);
    expect(JSON.stringify(result)).not.toMatch(
      /stateJson|hors_secrets|pin_k|ciphertext/,
    );
  });
  it("rejects secret nesting, script mismatches and mismatched owner keys", () => {
    for (const mutate of [
      (s: any) => {
        s.hors_commitments[0][0] = { secret: "bad" };
      },
      (s: any) => {
        s.round_sigs[0].k = "secret";
      },
      (s: any) => {
        s.hors_secrets = [];
      },
    ]) {
      const v = fixture(),
        s = JSON.parse(v.publicStateJson);
      mutate(s);
      v.publicStateJson = JSON.stringify(s);
      expect(() => createOfflineRequest(wallet, v)).toThrow();
    }
    const v = fixture();
    expect(() =>
      createOfflineRequest(wallet, { ...v, scriptHash: "00".repeat(32) }),
    ).toThrow();
    expect(() =>
      createOfflineRequest(
        { ...wallet, address: btc.p2sh(btc.p2wpkh(hex.decode(pub))).address! },
        v,
      ),
    ).toThrow();
  });
  it("requires exact reimport, verifies recovery digest, and locks worker even on failure", async () => {
    const v = fixture(),
      request = createOfflineRequest(wallet, v),
      pass = "disposable fixture password";
    const encrypted = await encryptRecovery(
      {
        format: "qsb-recovery-v1",
        vault: v,
        stateJson: "private recovery not exported",
      },
      pass,
    );
    vi.mocked(validateRecovery).mockResolvedValue(v.scriptHash);
    await verifyOfflineBackup(encrypted, encrypted, pass, request);
    expect(validateRecovery).toHaveBeenCalledWith(
      "private recovery not exported",
    );
    await expect(
      verifyOfflineBackup(encrypted + " ", encrypted, pass, request),
    ).rejects.toThrow("exact private backup");
    vi.mocked(validateRecovery).mockResolvedValue("00".repeat(32));
    await expect(
      verifyOfflineBackup(encrypted, encrypted, pass, request),
    ).rejects.toThrow("commitment");
    expect(lockQsb).toHaveBeenCalledTimes(3);
  });
});
