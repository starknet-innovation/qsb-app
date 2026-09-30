import * as btc from "@scure/btc-signer";

/** QSB runs on Bitcoin mainnet only. */
export type NetworkId = "mainnet";
export function parseNetwork(value: string | undefined): NetworkId {
  if (value === "mainnet") return value;
  throw new Error("Unsupported QSB network configuration");
}
// Vite replaces the browser environment at build time. Lambda uses only its
// explicit process environment; neither accepts a network supplied by a request.
// An omitted or other value throws, so every build names mainnet explicitly.
const configured = import.meta.env?.VITE_QSB_NETWORK ??
  (typeof process !== "undefined" ? process.env.QSB_NETWORK : undefined);
export const NETWORK_ID = parseNetwork(configured);
/** The API's prefixes: `/v1`, the stable one, and the `/api` compatibility alias (docs/API.md). */
export type ApiBasePath = "/v1" | "/api";
/** The prefix of every webapp API call. */
export const API_BASE_PATH: ApiBasePath = "/v1";
export const BITCOIN_NETWORK = btc.NETWORK;
export const NETWORK_CONFIG = {
  label: "Bitcoin mainnet",
  chainUrl: "https://blockstream.info/api",
  minerUrl: "https://slipstream.mara.com",
  explorerUrl: "https://mempool.space",
  genesisHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
};
