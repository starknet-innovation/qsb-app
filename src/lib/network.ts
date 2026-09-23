import * as btc from "@scure/btc-signer";

export type NetworkId = "mainnet" | "testnet4";
export function parseNetwork(value: string | undefined): NetworkId {
  if (value === undefined || value === "mainnet") return "mainnet";
  if (value === "testnet4") return "testnet4";
  throw new Error("Unsupported QSB network configuration");
}
// Vite replaces the browser environment at build time. Lambda uses only its
// explicit process environment; neither accepts a network supplied by a request.
const configured = import.meta.env?.VITE_QSB_NETWORK ??
  (typeof process !== "undefined" ? process.env.QSB_NETWORK : undefined);
export const NETWORK_ID = parseNetwork(configured);
export const BITCOIN_NETWORK = NETWORK_ID === "testnet4" ? btc.TEST_NETWORK : btc.NETWORK;
export const NETWORK_CONFIG = NETWORK_ID === "testnet4" ? {
  label: "Bitcoin Testnet4",
  chainUrl: "https://mempool.space/testnet4/api",
  minerUrl: "https://teststream.mara.com",
  explorerUrl: "https://mempool.space/testnet4",
  genesisHash: "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
} : {
  label: "Bitcoin mainnet",
  chainUrl: "https://blockstream.info/api",
  minerUrl: "https://slipstream.mara.com",
  explorerUrl: "https://mempool.space",
  genesisHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
};
