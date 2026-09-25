import { expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("sats-connect", () => ({
  request,
  getProviders: () => [],
  AddressPurpose: {},
  BitcoinNetworkType: {},
  MessageSigningProtocols: {},
}));
import { fundFromXverse, signPsbt } from "../src/lib/wallet";
it("always disables wallet broadcasting and restricts requested input indices", async () => {
  request.mockResolvedValue({ status: "success", result: { psbt: "signed" } });
  expect(await signPsbt("payment-address", "unsigned", [0])).toBe("signed");
  expect(request).toHaveBeenCalledWith(
    "signPsbt",
    {
      psbt: "unsigned",
      signInputs: { "payment-address": [0] },
      broadcast: false,
    },
    undefined,
  );
});
it("asks Xverse to send the deposit and returns its txid", async () => {
  request.mockResolvedValue({
    status: "success",
    result: { psbt: "signed", txid: "ab".repeat(32) },
  });
  await expect(
    fundFromXverse("payment-address", "unsigned", [0, 1], vi.fn()),
  ).resolves.toEqual({ psbt: "signed", txid: "ab".repeat(32) });
  expect(request).toHaveBeenCalledWith(
    "signPsbt",
    {
      psbt: "unsigned",
      signInputs: { "payment-address": [0, 1] },
      broadcast: true,
    },
    undefined,
  );
});

it("retains broadcast identity before rejecting a malformed signed result", async () => {
  request.mockResolvedValue({
    status: "success",
    result: { txid: "ab".repeat(32) },
  });
  const remember = vi.fn();
  await expect(
    fundFromXverse("payment-address", "unsigned", [0], remember),
  ).rejects.toThrow();
  expect(remember).toHaveBeenCalledWith("ab".repeat(32));
});
it("retains an unknown broadcast guard when the success receipt has no txid", async () => {
  request.mockResolvedValue({ status: "success", result: { psbt: "signed" } });
  const remember = vi.fn();
  await expect(
    fundFromXverse("payment-address", "unsigned", [0], remember),
  ).rejects.toThrow();
  expect(remember).toHaveBeenCalledWith(undefined);
});
