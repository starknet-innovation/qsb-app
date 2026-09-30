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
  const address = r.result.addresses.find((a) => a.purpose === "payment");
  if (!address)
    throw new Error("Xverse did not return a Bitcoin payment address.");
  outputScript(address.address);
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
