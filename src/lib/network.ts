import * as btc from "@scure/btc-signer";

export type NetworkId = "mainnet" | "testnet4";
export function parseNetwork(value: string | undefined): NetworkId {
  if (value === "mainnet" || value === "testnet4") return value;
  throw new Error("Unsupported QSB network configuration");
}
// Vite replaces the browser environment at build time. Lambda uses only its
// explicit process environment; neither accepts a network supplied by a request.
// An omitted value throws. Callers set mainnet or testnet4 explicitly.
const configured = import.meta.env?.VITE_QSB_NETWORK ??
  (typeof process !== "undefined" ? process.env.QSB_NETWORK : undefined);
export const NETWORK_ID = parseNetwork(configured);
export type ApiBasePath = "/v1" | "/api";
/**
 * The prefix of every webapp API call. Mainnet's coordinator API serves `/v1`, the stable
 * prefix, and keeps `/api` for bundles cached before this move (docs/API.md). QSB deploys on
 * mainnet only (server/lambda.ts); a testnet4 build keeps `/api`.
 */
export function apiBasePath(network: NetworkId): ApiBasePath {
  return network === "mainnet" ? "/v1" : "/api";
}
export const API_BASE_PATH = apiBasePath(NETWORK_ID);
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
