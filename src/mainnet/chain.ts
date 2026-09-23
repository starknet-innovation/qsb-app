import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { z } from "zod";
import { outpoint, txid } from "../lib/model";

const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

const statusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: txid.optional(),
});
export class ChainError extends Error {}
export class MainnetEsplora {
  constructor(
    private base: string,
    private request: typeof fetch = fetch,
  ) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || base.endsWith('/')) throw new ChainError('Fixed HTTPS chain origin required');
  }
  private async read(path: string) {
    const r = await this.request(`${this.base}${path}`, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
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
    if ((await this.read('/block-height/0')).trim() !== MAINNET_GENESIS)
      throw new ChainError('Chain provider is not Bitcoin mainnet. Signing is blocked.');
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
    btc.Address(btc.NETWORK).decode(address); // Explicit mainnet checksum; no ambient build setting.
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
// No default client or network request at module import. Operator supplies trusted fixed origin.
