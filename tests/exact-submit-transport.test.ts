import { afterEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { Slipstream } from "../server/providers";
import { issueExactSubmitPermit } from "../server/exact-submit-permit";

function transaction() {
  const tx = new btc.Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  tx.addInput({
    txid: "11".repeat(32),
    index: 0,
  });
  tx.addOutput({ script: Uint8Array.of(0x51), amount: 1n });
  tx.updateInput(0, { finalScriptSig: Uint8Array.of(0) }, true);
  return { raw: hex.encode(tx.toBytes(true, true)), id: tx.id };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("switch off prevents credential resolution and all HTTP even with an internal permit", async () => {
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", "false");
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const auth = vi.fn();
  const { raw } = transaction();
  await expect(
    new Slipstream(undefined, auth).submit(raw, issueExactSubmitPermit(raw)),
  ).rejects.toThrow("Disabled");
  expect(auth).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it("makes one exact mainnet POST and consumes the permit", async () => {
  vi.stubEnv("QSB_MAINNET_ENABLED", "true");
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", "true");
  const { raw, id } = transaction();
  const request = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ status: "success", message: id })),
    );
  vi.stubGlobal("fetch", request);
  const miner = new Slipstream(undefined, async () => undefined),
    permit = issueExactSubmitPermit(raw);
  await expect(miner.submit(raw, permit)).resolves.toEqual({
    status: "success",
    message: id,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe(
    "https://slipstream.mara.com/api/transactions",
  );
  expect(request.mock.calls[0][1]).toMatchObject({
    method: "POST",
    redirect: "error",
    body: JSON.stringify({ tx_hex: raw }),
  });
  await expect(miner.submit(raw, permit)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(["timeout", "wrong-id", "malformed", "rejected"])(
  "never retries %s",
  async (kind) => {
    vi.stubEnv("QSB_MAINNET_ENABLED", "true");
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", "true");
    const { raw } = transaction();
    const request = vi.fn();
    if (kind === "timeout") request.mockRejectedValue(new Error("timeout"));
    else
      request.mockResolvedValue(
        new Response(
          JSON.stringify(
            kind === "wrong-id"
              ? { status: "success", message: "22".repeat(32) }
              : kind === "rejected"
                ? { status: "error", message: "rejected" }
                : {},
          ),
        ),
      );
    vi.stubGlobal("fetch", request);
    const miner = new Slipstream(undefined, async () => undefined),
      permit = issueExactSubmitPermit(raw);
    await expect(miner.submit(raw, permit)).rejects.toThrow();
    await expect(miner.submit(raw, permit)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("rejects changed bytes and a different miner before HTTP", async () => {
  vi.stubEnv("QSB_MAINNET_ENABLED", "true");
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", "true");
  const { raw } = transaction(),
    request = vi.fn();
  vi.stubGlobal("fetch", request);
  await expect(
    new Slipstream().submit("00", issueExactSubmitPermit(raw)),
  ).rejects.toThrow("BytesChanged");
  await expect(
    new Slipstream("https://teststream.mara.com").submit(
      raw,
      issueExactSubmitPermit(raw),
    ),
  ).rejects.toThrow("MinerMismatch");
  expect(request).not.toHaveBeenCalled();
});
