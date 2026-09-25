import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { z } from "zod";
import { outputScript } from "../src/lib/transactions";
import {
  outpoint,
  txid,
  withdrawalSchema,
  type Withdrawal,
} from "../src/lib/model";

import { NETWORK_ID, NETWORK_CONFIG } from "../src/lib/network";
import { chainBase, testnet4Genesis } from "./network";

const statusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: txid.optional(),
});
export class ChainError extends Error {}
export class Esplora {
  constructor(
    private base = chainBase,
    private request: typeof fetch = fetch,
  ) {}
  private async read(path: string) {
    const r = await this.request(`${this.base}${path}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new ChainError(
        `Chain lookup failed (${r.status}). Retry before signing.`,
      );
    const text = await r.text();
    if (text.length > 8000000)
      throw new ChainError("Chain response exceeds limit.");
    return text;
  }
  async assertNetwork() {
    const expected =
      NETWORK_ID === "testnet4" ? testnet4Genesis : NETWORK_CONFIG.genesisHash;
    // Check each operation; do not cache a provider's identity across requests.
    if ((await this.read("/block-height/0")).trim() !== expected)
      throw new ChainError(
        `Chain provider is not Bitcoin ${NETWORK_ID}. Signing and submission are blocked.`,
      );
  }
  async raw(id: string) {
    await this.assertNetwork();
    txid.parse(id);
    const raw = (await this.read(`/tx/${id}/hex`)).trim();
    const tx = btc.Transaction.fromRaw(hex.decode(raw), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    if (tx.id !== id.toLowerCase())
      throw new ChainError("Previous transaction hash mismatch.");
    return { tx, raw };
  }
  async status(id: string) {
    await this.assertNetwork();
    txid.parse(id);
    const s = statusSchema.parse(
      JSON.parse(await this.read(`/tx/${id}/status`)),
    );
    if (!s.confirmed) return { confirmed: false, confirmations: 0 };
    if (s.block_height === undefined || !s.block_hash)
      throw new ChainError("Incomplete block status.");
    const canonical = (
      await this.read(`/block-height/${s.block_height}`)
    ).trim();
    if (canonical !== s.block_hash)
      return { confirmed: false, confirmations: 0 };
    const tip = Number((await this.read("/blocks/tip/height")).trim());
    if (!Number.isSafeInteger(tip) || tip < s.block_height)
      throw new ChainError("Inconsistent chain tip.");
    return {
      confirmed: true,
      confirmations: tip - s.block_height + 1,
      blockHash: s.block_hash,
      blockHeight: s.block_height,
    };
  }
  /** Follow the funding outpoint because a valid legacy scriptSig mutation changes txid. */
  async withdrawalInclusion(manifest: Withdrawal) {
    const approved = withdrawalSchema.parse(manifest);
    await this.assertNetwork();
    const spent = z
      .discriminatedUnion("spent", [
        z.object({ spent: z.literal(false) }),
        z.object({
          spent: z.literal(true),
          txid,
          vin: z.number().int().min(0).max(0xffffffff),
        }),
      ])
      .parse(
        JSON.parse(
          await this.read(
            `/tx/${approved.funding.txid}/outspend/${approved.funding.vout}`,
          ),
        ),
      );
    if (!spent.spent)
      return {
        confirmed: false,
        confirmations: 0,
        outpointMatched: false,
        outputMatched: false,
      };
    // raw() binds the response bytes to the provider's actual spender txid.
    const { tx } = await this.raw(spent.txid);
    if (tx.inputsLength !== 2 || spent.vin >= tx.inputsLength)
      throw new WithdrawalConflict("Withdrawal spender input mismatch.");
    const fundingInput = tx.getInput(spent.vin);
    if (
      !fundingInput.txid ||
      hex.encode(fundingInput.txid) !== approved.funding.txid.toLowerCase() ||
      fundingInput.index !== approved.funding.vout
    )
      throw new WithdrawalConflict("Withdrawal spender input mismatch.");
    const expected = [approved.helper, approved.funding]
      .map((point) => `${point.txid.toLowerCase()}:${point.vout}`)
      .sort();
    const actual = [0, 1]
      .map((index) => {
        const input = tx.getInput(index);
        return `${input.txid ? hex.encode(input.txid) : ""}:${input.index}`;
      })
      .sort();
    if (
      expected[0] === expected[1] ||
      expected.some((point, index) => point !== actual[index])
    )
      throw new WithdrawalConflict("Withdrawal spender input mismatch.");
    if (tx.outputsLength !== 1)
      throw new WithdrawalConflict("Withdrawal spender output mismatch.");
    const output = tx.getOutput(0);
    if (
      !output.script ||
      hex.encode(output.script) !== approved.outputScript.toLowerCase() ||
      hex.encode(outputScript(approved.destination)) !==
        approved.outputScript.toLowerCase() ||
      output.amount !== BigInt(approved.outputValue) ||
      BigInt(approved.helper.value) +
        BigInt(approved.funding.value) -
        output.amount !==
        BigInt(approved.fee)
    )
      throw new WithdrawalConflict("Withdrawal spender output mismatch.");
    // Do not accept the outspend endpoint's supplied status: status() separately
    // checks the spender and its canonical block against the current chain tip.
    const status = await this.status(spent.txid);
    return {
      ...status,
      txid: tx.id,
      outpointMatched: true,
      outputMatched: true,
    };
  }
  async unspent(point: z.infer<typeof outpoint>, script: string) {
    outpoint.parse(point);
    const { tx, raw } = await this.raw(point.txid);
    const output = tx.getOutput(point.vout);
    if (
      output.amount !== BigInt(point.value) ||
      !output.script ||
      hex.encode(output.script) !== script.toLowerCase()
    )
      throw new ChainError("Previous output amount or script mismatch.");
    const [s, spent] = await Promise.all([
      this.status(point.txid),
      this.read(`/tx/${point.txid}/outspend/${point.vout}`),
    ]);
    if (!s.confirmed)
      throw new ChainError(
        "Input is unconfirmed or was reorganized out of the chain.",
      );
    if (z.object({ spent: z.boolean() }).parse(JSON.parse(spent)).spent)
      throw new ChainError("Input has already been spent.");
    return { previousTxHex: raw, confirmations: s.confirmations };
  }
  async paymentUtxos(address: string) {
    await this.assertNetwork();
    outputScript(address); // Configured-network address checksum validation before URL construction.
    const rows = z
      .array(
        z.object({
          txid,
          vout: z.number().int().nonnegative(),
          value: z.number().int().nonnegative().max(2100000000000000),
          status: statusSchema,
        }),
      )
      .parse(
        JSON.parse(
          await this.read(`/address/${encodeURIComponent(address)}/utxo`),
        ),
      );
    return rows
      .filter((x) => x.status.confirmed)
      .map((x) => ({ txid: x.txid, vout: x.vout, value: String(x.value) }));
  }
}
export const chain = new Esplora();

/** A known funding spender contradicts the approved withdrawal. */
export class WithdrawalConflict extends ChainError {}
