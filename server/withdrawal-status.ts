import { withdrawalSchema } from "../src/lib/model";
import { WithdrawalConflict, type Esplora } from "./chain";
import type { Slipstream } from "./providers";
import type { Row } from "./store";

/** Observations never authorize another submission or release input reservations. */
export async function observeWithdrawal(
  intent: Row,
  chain: Esplora,
  miner: Pick<Slipstream, "status">,
) {
  const exact = intent.kind === "exact-withdrawal";
  const [chainResult, minerResult] = await Promise.allSettled([
    exact
      ? chain.withdrawalInclusion(withdrawalSchema.parse(intent.manifest))
      : chain.status(intent.txid as string),
    miner.status(intent.txid as string),
  ]);
  const onChain = chainResult.status === "fulfilled" ? chainResult.value : null;
  const inMiner = minerResult.status === "fulfilled" ? minerResult.value : null;
  const alert =
    chainResult.status === "rejected" &&
    chainResult.reason instanceof WithdrawalConflict
      ? chainResult.reason.message
      : undefined;
  const matched =
    onChain !== null &&
    (!exact ||
      ("outpointMatched" in onChain && onChain.outpointMatched === true));
  const status = alert
    ? "conflict"
    : matched && onChain.confirmed
      ? "confirmed"
      : matched || (!exact && inMiner) || intent.postAcknowledged === true
        ? "submitted"
        : "uncertain";
  const includedTxid =
    status === "confirmed"
      ? ((onChain && "txid" in onChain ? onChain.txid : intent.txid) as string)
      : undefined;
  return { status, chain: onChain, miner: inMiner, alert, includedTxid };
}
