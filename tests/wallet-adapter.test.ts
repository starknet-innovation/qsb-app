import { expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("sats-connect", () => ({
  request,
  getProviders: () => [],
  AddressPurpose: {},
  BitcoinNetworkType: {},
  MessageSigningProtocols: {},
}));
import { signPsbt } from "../src/lib/wallet";
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
