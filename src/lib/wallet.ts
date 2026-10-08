import { outputScript } from "./transactions";
import {
  request,
  getProviders,
  AddressPurpose,
  BitcoinNetworkType,
  MessageSigningProtocols,
} from "sats-connect";
export type Wallet = { address: string; publicKey: string; type: string };
let providerId: string | undefined;
export async function connectWallet(): Promise<Wallet> {
  const provider = getProviders().find((p) =>
    p.name.toLowerCase().includes("xverse"),
  );
  if (!provider)
    throw new Error(
      "Install or unlock the Xverse browser extension, then try again.",
    );
  providerId = provider.id;
  const r = await request(
    "wallet_connect",
    {
      addresses: [AddressPurpose.Payment],
      network: BitcoinNetworkType.Mainnet,
      message: "Connect to QSB. This does not move any Bitcoin.",
    },
    providerId,
  );
  if (r.status !== "success")
    throw new Error(r.error.message || "Wallet connection declined.");
  // Xverse can still connect on another network (some versions ignore the one requested above), so check the
  // network it answered with.
  const network = r.result.network?.bitcoin?.name;
  if (network && network !== BitcoinNetworkType.Mainnet)
    throw new Error(
      `Xverse is set to ${network}. QSB runs on Bitcoin mainnet only: switch Xverse's network to Mainnet, then connect again.`,
    );
  const address = r.result.addresses.find((a) => a.purpose === "payment");
  if (!address)
    throw new Error("Xverse did not return a Bitcoin payment address.");
  try {
    outputScript(address.address);
  } catch {
    throw new Error(
      "Xverse returned an address that isn't a Bitcoin mainnet payment address. Switch Xverse's network to Mainnet, then connect again.",
    );
  }
  return {
    address: address.address,
    publicKey: address.publicKey,
    type: address.addressType,
  };
}
export async function signMessage(address: string, message: string) {
  const r = await request(
    "signMessage",
    { address, message, protocol: MessageSigningProtocols.BIP322 },
    providerId,
  );
  if (r.status !== "success")
    throw new Error(r.error.message || "Signature declined.");
  return r.result.signature;
}
export async function signPsbt(
  address: string,
  psbt: string,
  indices: number[],
) {
  const r = await request(
    "signPsbt",
    { psbt, signInputs: { [address]: indices }, broadcast: false },
    providerId,
  );
  if (r.status !== "success")
    throw new Error(r.error.message || "Transaction signature declined.");
  return r.result.psbt;
}
