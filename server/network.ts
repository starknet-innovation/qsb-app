import { NETWORK_CONFIG } from "../src/lib/network";

export const transactionsEnabled = process.env.QSB_MAINNET_ENABLED === "true";
export const chainBase = process.env.ESPLORA_URL || NETWORK_CONFIG.chainUrl;
export const minerBase = NETWORK_CONFIG.minerUrl;
