import { NETWORK_ID, NETWORK_CONFIG } from "../src/lib/network";
import { release } from "../src/lib/model";

export const transactionsEnabled =
  NETWORK_ID === "testnet4"
    ? process.env.QSB_REHEARSAL_ENABLED === "true" &&
      Boolean(
        (process.env.QSB_REHEARSAL_ADDRESSES || "")
          .split(",")
          .some((x) => x.trim()),
      )
    : release.mainnetEnabled;
export function rehearsalAddressAllowed(address: string): boolean {
  return (
    NETWORK_ID !== "testnet4" ||
    (process.env.QSB_REHEARSAL_ADDRESSES || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .includes(address)
  );
}
export const chainBase = process.env.ESPLORA_URL || NETWORK_CONFIG.chainUrl;
export const minerBase = NETWORK_CONFIG.minerUrl;
export const testnet4Genesis =
  "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043";
