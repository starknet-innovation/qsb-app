import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { publicRuntime } from "../sdk/public-runtime";
/** No GPU solve: use the canonical layout and a placeholder witness, like the existing fake coordinator. */
export function publicPlannerDouble(real: ReturnType<typeof publicRuntime>): ReturnType<typeof publicRuntime> {
  return { ...real, async prepare(_vault, m, hit) {
    const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 1, lockTime: hit.locktime });
    if (m.helper) tx.addInput({ txid: m.helper.txid, index: m.helper.vout, sequence: 0xfffffffe });
    tx.addInput({ txid: m.funding.txid, index: m.funding.vout, sequence: hit.sequence });
    tx.addOutput({ script: hex.decode(m.outputScript), amount: BigInt(m.outputValue) });
    return { transaction: hex.encode(tx.toBytes(true, false)), selection: [hit.round1, hit.round2] };
  }, verify: async () => {} };
}
