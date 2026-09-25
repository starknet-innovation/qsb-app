import { describe, expect, it, vi } from "vitest";
import { Esplora, WithdrawalConflict } from "../server/chain";
import { observeWithdrawal } from "../server/withdrawal-status";
import type { Row } from "../server/store";

const original = "aa".repeat(32),
  included = "bb".repeat(32);
const intent: Row = {
  pk: "OWNER#test",
  sk: `TX#${original}`,
  version: 0,
  kind: "exact-withdrawal",
  txid: original,
  status: "uncertain",
  manifest: {
    vaultId: "00000000-0000-4000-8000-000000000001",
    funding: { txid: "11".repeat(32), vout: 0, value: "50000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
    destination: "bc1q000000000000000000000000000000000000000",
    outputScript: "0014" + "00".repeat(20),
    outputValue: "59000",
    fee: "1000",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    costAccepted: true,
  },
};
function fixture() {
  const chain = new Esplora("https://example.invalid");
  const inclusion = vi.spyOn(chain, "withdrawalInclusion").mockResolvedValue({
    confirmed: false,
    confirmations: 0,
    outpointMatched: false,
    outputMatched: false,
  });
  const miner = {
    status: vi.fn(
      async (): Promise<{
        transaction: { txid: string; status: { confirmed: boolean } };
      }> => {
        throw Error("Miner HTTP404");
      },
    ),
  };
  return { chain, inclusion, miner };
}
describe("withdrawal observation without resubmission authority", () => {
  it("unspent funding and absent miner stays uncertain, regardless of old status string", async () => {
    const f = fixture();
    for (const status of ["uncertain", "submitted", "confirmed"]) {
      expect(
        await observeWithdrawal({ ...intent, status }, f.chain, f.miner),
      ).toMatchObject({ status: "uncertain", includedTxid: undefined });
    }
  });
  it("unspent funding retains submitted only when the stored POST was acknowledged", async () => {
    const f = fixture();
    expect(
      await observeWithdrawal(
        { ...intent, postAcknowledged: true },
        f.chain,
        f.miner,
      ),
    ).toMatchObject({ status: "submitted", includedTxid: undefined });
  });
  it("independently confirmed matching outpoint spender reports actual txid despite missing original miner record", async () => {
    const f = fixture();
    f.inclusion.mockResolvedValue({
      confirmed: true,
      confirmations: 2,
      blockHash: "cc".repeat(32),
      blockHeight: 100,
      txid: included,
      outpointMatched: true,
      outputMatched: true,
    });
    expect(await observeWithdrawal(intent, f.chain, f.miner)).toMatchObject({
      status: "confirmed",
      includedTxid: included,
      alert: undefined,
    });
  });
  it("surfaces mismatched spending as conflict even when miner reports original transaction confirmed", async () => {
    const f = fixture();
    f.inclusion.mockRejectedValue(
      new WithdrawalConflict("Withdrawal spender output mismatch."),
    );
    f.miner.status.mockResolvedValue({
      transaction: { txid: original, status: { confirmed: true } },
    });
    expect(
      await observeWithdrawal(
        { ...intent, postAcknowledged: true },
        f.chain,
        f.miner,
      ),
    ).toMatchObject({
      status: "conflict",
      includedTxid: undefined,
      alert: "Withdrawal spender output mismatch.",
    });
  });
  it("chain and miner outages cannot invent submission or confirmation", async () => {
    const f = fixture();
    f.inclusion.mockRejectedValue(new Error("Chain HTTP503"));
    expect(await observeWithdrawal(intent, f.chain, f.miner)).toMatchObject({
      status: "uncertain",
      chain: null,
      miner: null,
      alert: undefined,
      includedTxid: undefined,
    });
  });
  it("matching mempool spender and miner-only visibility never count as confirmed", async () => {
    const f = fixture();
    f.inclusion.mockResolvedValue({
      confirmed: false,
      confirmations: 0,
      txid: included,
      outpointMatched: true,
      outputMatched: true,
    });
    expect(await observeWithdrawal(intent, f.chain, f.miner)).toMatchObject({
      status: "submitted",
      includedTxid: undefined,
    });
    f.inclusion.mockRejectedValue(new Error("Chain unavailable"));
    f.miner.status.mockResolvedValue({
      transaction: { txid: original, status: { confirmed: true } },
    });
    expect(await observeWithdrawal(intent, f.chain, f.miner)).toMatchObject({
      status: "uncertain",
      includedTxid: undefined,
    });
  });
});

it.each(["conflict", "confirmed"])(
  "preserves %s evidence through an outage but allows a successful reorg observation",
  async (status) => {
    const f = fixture();
    const saved = {
      ...intent,
      status,
      alert: status === "conflict" ? "Foreign spender" : undefined,
      includedTxid: included,
    };
    f.inclusion.mockRejectedValue(new Error("Chain HTTP429"));
    expect(await observeWithdrawal(saved, f.chain, f.miner)).toMatchObject({
      status,
      chainUnavailable: true,
      alert: saved.alert,
    });
    if (status === "confirmed")
      expect(
        (await observeWithdrawal(saved, f.chain, f.miner)).includedTxid,
      ).toBe(included);
    f.inclusion.mockResolvedValue({
      confirmed: false,
      confirmations: 0,
      outpointMatched: false,
      outputMatched: false,
    });
    expect(await observeWithdrawal(saved, f.chain, f.miner)).toMatchObject({
      status: "uncertain",
      alert: undefined,
      includedTxid: undefined,
    });
  },
);
