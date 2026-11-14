// Public data only. No wallet unlock or transaction submission endpoint.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function remoteStatus(address, base = "https://mempool.space/api") {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Remote backend must use HTTPS without credentials, query or fragment");
  if (!/^bc1q[023456789acdefghjklmnpqrstuvwxyz]{38}$/.test(address))
    throw new Error("Expected this wallet's native mainnet P2WPKH address");
  const get = async (path, json = false) => {
    const response = await fetch(`${url.href.replace(/\/$/, "")}/${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Remote chain read failed (${response.status})`);
    return json ? response.json() : response.text();
  };
  const genesis = await get("block-height/0");
  if (genesis.trim() !== "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f")
    throw new Error("Remote backend is not Bitcoin mainnet");
  const [tip, utxos, fees] = await Promise.all([
    get("blocks/tip/height"), get(`address/${address}/utxo`, true), get("v1/fees/recommended", true),
  ]);
  return { backend: url.href, network: "bitcoin", address, tipHeight: Number(tip), utxos, fees };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, backend] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: node remote.mjs <wallet-directory> [HTTPS-Esplora-URL]");
  const metadata = JSON.parse(await readFile(`${directory}/wallet.json`, "utf8"));
  console.log(JSON.stringify(await remoteStatus(metadata.address, backend), null, 2));
}
