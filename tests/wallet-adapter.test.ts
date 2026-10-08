import { expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("sats-connect", () => ({
  request,
  getProviders: () => [{ id: "xverse", name: "Xverse Wallet" }],
  AddressPurpose: { Payment: "payment" },
  BitcoinNetworkType: { Mainnet: "Mainnet", Testnet: "Testnet", Testnet4: "Testnet4", Signet: "Signet" },
  MessageSigningProtocols: {},
}));
import { connectWallet, signPsbt } from "../src/lib/wallet";

const hash = new Uint8Array(20).fill(7);
const mainnet = btc.Address(btc.NETWORK).encode({ type: "wpkh", hash });
const testnet = btc.Address(btc.TEST_NETWORK).encode({ type: "wpkh", hash });
const connected = (address: string, network?: string) => ({
  status: "success",
  result: {
    addresses: [{ address, publicKey: "02" + "11".repeat(32), purpose: "payment", addressType: "p2wpkh" }],
    ...(network ? { network: { bitcoin: { name: network } } } : {}),
  },
});

it("connects to a mainnet payment address", async () => {
  request.mockResolvedValue(connected(mainnet, "Mainnet"));
  expect(await connectWallet()).toMatchObject({ address: mainnet, type: "p2wpkh" });
});

it("explains a wallet set to a test network instead of failing on its address", async () => {
  for (const network of ["Testnet", "Testnet4", "Signet"]) {
    request.mockResolvedValue(connected(testnet, network));
    await expect(connectWallet()).rejects.toThrow(`Xverse is set to ${network}. QSB runs on Bitcoin mainnet only`);
  }
  // Without the network in the answer, the address itself is checked: no base58 "Unknown letter" error.
  request.mockResolvedValue(connected(testnet));
  await expect(connectWallet()).rejects.toThrow("isn't a Bitcoin mainnet payment address");
});
it("always disables wallet broadcasting and restricts requested input indices", async () => {
  request.mockResolvedValue({ status: "success", result: { psbt: "signed" } });
  expect(await signPsbt("payment-address", "unsigned", [0])).toBe("signed");
  // The method and its parameters; the third argument is whichever provider connected.
  expect(request.mock.lastCall?.slice(0, 2)).toEqual([
    "signPsbt",
    {
      psbt: "unsigned",
      signInputs: { "payment-address": [0] },
      broadcast: false,
    },
  ]);
});
