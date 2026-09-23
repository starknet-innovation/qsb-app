import { afterEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function testnet() {
  vi.stubEnv("VITE_QSB_NETWORK", "testnet4");
  vi.resetModules();
  return Promise.all([import("../src/lib/transactions"), import("../src/lib/model"), import("../src/lib/readiness")]);
}
const pub = hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
it("testnet address construction rejects mainnet and preserves matching funding ownership", async () => {
  const [tx] = await testnet();
  const testAddress = btc.p2wpkh(pub, btc.TEST_NETWORK).address!;
  expect(() => tx.outputScript(btc.p2wpkh(pub).address!)).toThrow();
  expect(tx.outputScript(testAddress)).toEqual(btc.p2wpkh(pub).script);
  const parent = new btc.Transaction({ allowUnknownInputs: true });
  parent.addInput({ txid: "00".repeat(32), index: 0 });
  parent.addOutputAddress(testAddress, 200000n, btc.TEST_NETWORK);
  const built = tx.fundingPsbt([{
    txid: parent.id, vout: 0, value: 200000n,
    previousTxHex: hex.encode(parent.toBytes(true, false)),
    publicKey: hex.encode(pub), address: testAddress,
  }], "61".repeat(100), 100000n, 10000n, testAddress);
  expect(built.getOutput(1).amount).toBe(90000n);
  expect(built.getOutput(1).script).toEqual(btc.p2wpkh(pub).script);
});
it("backup network binding and spending configuration fail closed", async () => {
  const [, model, readiness] = await testnet();
  expect(model.publicVaultSchema.shape.network.safeParse("mainnet").success).toBe(false);
  expect(model.publicVaultSchema.shape.network.safeParse("testnet4").success).toBe(true);
  for (const config of [undefined, {}, { mainnetEnabled: true }, { network: "testnet4", mainnetEnabled: true },
    { network: "mainnet", operationsEnabled: true },
    { network: "testnet4", operationsEnabled: false, mainnetEnabled: true }])
    expect(readiness.operationsAllowed(config)).toBe(false);
  expect(readiness.operationsAllowed({ network: "testnet4", operationsEnabled: true })).toBe(true);
});

it("Testnet3 cannot reach the Testnet4 signature prompt", async () => {
  await testnet();
  const request = vi.fn().mockResolvedValue({ status: "success", result: { bitcoin: { name: "Testnet" } } });
  vi.doMock("sats-connect", () => ({ request, getProviders: () => [],
    AddressPurpose: { Payment: "payment" }, BitcoinNetworkType: { Mainnet: "Mainnet", Testnet4: "Testnet4" }, MessageSigningProtocols: {} }));
  const wallet = await import("../src/lib/wallet");
  await expect(wallet.signPsbt("tb1-wallet", "unsigned", [0])).rejects.toThrow("Testnet4");
  expect(request.mock.calls.map((args) => args[0])).toEqual(["wallet_getNetwork"]);
  vi.doUnmock("sats-connect");
});
it("changed Xverse account cannot reach the signature prompt", async () => {
  await testnet();
  const request = vi.fn().mockImplementation(async (method) => method === "wallet_getNetwork"
    ? { status: "success", result: { bitcoin: { name: "Testnet4" } } }
    : { status: "success", result: { network: { bitcoin: { name: "Testnet4" } }, addresses: [{ purpose: "payment", address: "another-wallet" }] } });
  vi.doMock("sats-connect", () => ({ request, getProviders: () => [],
    AddressPurpose: { Payment: "payment" }, BitcoinNetworkType: { Mainnet: "Mainnet", Testnet4: "Testnet4" }, MessageSigningProtocols: {} }));
  const wallet = await import("../src/lib/wallet");
  await expect(wallet.signPsbt("tb1-wallet", "unsigned", [0])).rejects.toThrow("account or network changed");
  expect(request.mock.calls.map((args) => args[0])).toEqual(["wallet_getNetwork", "wallet_getAccount"]);
  vi.doUnmock("sats-connect");
});

it("connects before network permissions and refreshes addresses after an approved switch", async () => {
  await testnet();
  let network = "Mainnet";
  const testAddress = btc.p2wpkh(pub, btc.TEST_NETWORK).address!;
  const request = vi.fn().mockImplementation(async (method) => {
    if (method === "wallet_connect") return { status: "success", result: { addresses: [{ address: btc.p2wpkh(pub).address!, purpose: "payment" }] } };
    if (method === "wallet_changeNetwork") { network = "Testnet4"; return { status: "success", result: null }; }
    if (method === "wallet_getNetwork") return { status: "success", result: { bitcoin: { name: network } } };
    return { status: "success", result: { network: { bitcoin: { name: network } }, addresses: [{ address: testAddress, purpose: "payment", publicKey: hex.encode(pub), addressType: "p2wpkh" }] } };
  });
  vi.doMock("sats-connect", () => ({ request, getProviders: () => [{ name: "Xverse", id: "xverse" }],
    AddressPurpose: { Payment: "payment" }, BitcoinNetworkType: { Mainnet: "Mainnet", Testnet4: "Testnet4" }, MessageSigningProtocols: {} }));
  const wallet = await import("../src/lib/wallet");
  expect((await wallet.connectWallet()).address).toBe(testAddress);
  expect(request.mock.calls[0]).toMatchObject(["wallet_connect", { network: "Testnet4" }, "xverse"]);
  expect(request.mock.calls.map((args) => args[0])).toContain("wallet_changeNetwork");
  vi.doUnmock("sats-connect");
});
it("rejects a network switch that reports success but leaves Xverse on mainnet", async () => {
  await testnet();
  const request = vi.fn().mockImplementation(async (method) => method === "wallet_connect"
    ? { status: "success", result: { addresses: [] } }
    : method === "wallet_changeNetwork" ? { status: "success", result: null }
    : { status: "success", result: { bitcoin: { name: "Mainnet" } } });
  vi.doMock("sats-connect", () => ({ request, getProviders: () => [{ name: "Xverse", id: "xverse" }],
    AddressPurpose: { Payment: "payment" }, BitcoinNetworkType: { Mainnet: "Mainnet", Testnet4: "Testnet4" }, MessageSigningProtocols: {} }));
  const wallet = await import("../src/lib/wallet");
  await expect(wallet.connectWallet()).rejects.toThrow("Select Testnet4");
  expect(request.mock.calls[0][0]).toBe("wallet_connect");
  vi.doUnmock("sats-connect");
});
