import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Slipstream } from "../server/providers";
import { createApp } from "../server/app";
import { Esplora } from "../server/chain";
import { MemoryStore } from "../server/store";
const id = "11".repeat(32);
afterEach(() => vi.unstubAllGlobals());
it("rejects a miner status for a different transaction", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transaction: { txid: "22".repeat(32), status: { confirmed: true } },
        }),
      ),
    ),
  );
  await expect(new Slipstream().status(id)).rejects.toThrow("hash mismatch");
});
it("rejects malformed live rates rather than presenting a usable quote", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ effective_rate: -1 }))),
  );
  await expect(new Slipstream().rates()).rejects.toThrow();
});
async function fixture() {
  const store = new MemoryStore(),
    miner = new Slipstream(),
    chain = new Esplora();
  const token = "a".repeat(43);
  await store.put({
    pk: "SESSION#" + createHash("sha256").update(token).digest("hex"),
    sk: "AUTH",
    version: 0,
    owner: "owner",
  });
  await store.put({
    pk: "OWNER#owner",
    sk: "TX#" + id,
    version: 0,
    status: "uncertain",
    rawTxHex: "private-signed-intent",
  });
  const submit = vi.spyOn(miner, "submit");
  const app = createApp(store, { miner, chain });
  const query = (auth = true, txid = id) =>
    app.request(
      new Request("http://localhost/api/transactions/" + txid + "/status", {
        headers: auth ? { authorization: "Bearer " + token } : {},
      }),
    );
  return { store, miner, chain, submit, query };
}
it("reconciles private miner visibility without rebroadcast or claiming confirmation", async () => {
  const f = await fixture();
  vi.spyOn(f.chain, "status").mockRejectedValue(Error("not in public mempool"));
  vi.spyOn(f.miner, "status").mockResolvedValue({
    transaction: { txid: id, status: { confirmed: true } },
  });
  const result = await (await f.query()).json();
  expect(result).toMatchObject({
    status: "submitted",
    chain: null,
    miner: { visible: true, reportedConfirmed: true },
    retrySafe: false,
    section7Inclusion: {
      independentlyConfirmed: false,
      section7Closed: false,
      preflightIsInclusion: false,
    },
  });
  expect(result).not.toHaveProperty("rawTxHex");
  expect(f.submit).not.toHaveBeenCalled();
});
it("keeps an unobserved signed intent uncertain and reserved", async () => {
  const f = await fixture();
  vi.spyOn(f.chain, "status").mockRejectedValue(Error("unavailable"));
  vi.spyOn(f.miner, "status").mockRejectedValue(Error("unavailable"));
  expect(await (await f.query()).json()).toMatchObject({
    status: "uncertain",
    retrySafe: false,
  });
  expect(await f.store.get("OWNER#owner", "TX#" + id)).toMatchObject({
    rawTxHex: "private-signed-intent",
  });
  expect(f.submit).not.toHaveBeenCalled();
});
it("requires chain confirmation and owner authentication", async () => {
  const f = await fixture();
  vi.spyOn(f.chain, "status").mockResolvedValue({
    confirmed: true,
    confirmations: 2,
    blockHash: "33".repeat(32),
    blockHeight: 100,
  });
  vi.spyOn(f.miner, "status").mockRejectedValue(Error("unavailable"));
  expect((await f.query(false)).status).toBe(401);
  expect((await f.query(true, "22".repeat(32))).status).toBe(404);
  expect(await (await f.query()).json()).toMatchObject({
    status: "confirmed",
    chain: { confirmations: 2, blockHeight: 100 },
    section7Inclusion: {
      independentlyConfirmed: true,
      structurallyComplete: true,
      section7Closed: false,
      preflightIsInclusion: false,
      httpSuccessIsInclusion: false,
      observedByThisCheckout: true,
    },
  });
  expect(f.submit).not.toHaveBeenCalled();
});
it("reports provider authorization failures without retrying the request", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(new Slipstream().test("00")).rejects.toThrow(
    "Miner API authorization is unavailable",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("uses the operator-specified authorization scheme only on MARA and forbids redirects", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
  await new Slipstream(undefined, async () => "ExampleScheme test-only").test(
    "00",
  );
  const options = fetchMock.mock.calls[0][1];
  expect(options.headers.get("Authorization")).toBe("ExampleScheme test-only");
  expect(options.redirect).toBe("error");
  await expect(
    new Slipstream(
      "https://example.com",
      async () => "ExampleScheme test-only",
    ).test("00"),
  ).rejects.toThrow("destination");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
