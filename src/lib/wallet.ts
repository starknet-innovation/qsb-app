import { clearSession } from "./api";
import { NETWORK_ID } from "./network";
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
const walletNetwork = NETWORK_ID === "testnet4" ? BitcoinNetworkType.Testnet4 : BitcoinNetworkType.Mainnet;
function walletChanged(message: string): never {
  clearSession();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("qsb-wallet-changed"));
  throw new Error(message);
}
async function assertWalletNetwork(address?: string): Promise<void> {
  // Mainnet retains the existing connection flow; rehearsal requires explicit
  // Testnet4 identity because testnet3 and Testnet4 share address prefixes.
  if (NETWORK_ID !== "testnet4") return;
  const network = await request("wallet_getNetwork", null, providerId);
  if (network.status !== "success" || network.result.bitcoin.name !== walletNetwork)
    walletChanged("Select Testnet4 in Xverse, then reconnect. No transaction was submitted.");
  if (address) {
    const account = await request("wallet_getAccount", null, providerId);
    if (account.status !== "success" || account.result.network.bitcoin.name !== walletNetwork ||
      !account.result.addresses.some((a) => a.purpose === AddressPurpose.Payment && a.address === address))
      walletChanged("Xverse account or network changed. Reconnect before signing.");
  }
}
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
      network: walletNetwork,
      message: "Connect to QSB. This does not move any Bitcoin.",
    },
    providerId,
  );
  if (r.status !== "success")
    throw new Error(r.error.message || "Wallet connection declined.");
  let addresses = r.result.addresses;
  if (NETWORK_ID === "testnet4") {
    const network = await request("wallet_getNetwork", null, providerId);
    if (network.status !== "success")
      walletChanged("Unable to verify Xverse Testnet4 network. Reconnect before continuing.");
    if (network.result.bitcoin.name !== walletNetwork) {
      const changed = await request("wallet_changeNetwork", { name: walletNetwork }, providerId);
      if (changed.status !== "success")
        walletChanged("Approve switching Xverse to Testnet4 to continue the rehearsal.");
    }
    await assertWalletNetwork();
    // Switching changes addresses; never retain the original connection's set.
    const account = await request("wallet_getAccount", null, providerId);
    if (account.status !== "success" || account.result.network.bitcoin.name !== walletNetwork)
      walletChanged("Unable to verify the Testnet4 account. Reconnect before continuing.");
    addresses = account.result.addresses;
  }
  const address = addresses.find((a) => a.purpose === "payment");
  if (!address)
    throw new Error("Xverse did not return a Bitcoin payment address.");
  outputScript(address.address);
  await assertWalletNetwork(address.address);
  return {
    address: address.address,
    publicKey: address.publicKey,
    type: address.addressType,
  };
}
export async function signMessage(address: string, message: string) {
  await assertWalletNetwork(address);
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
  await assertWalletNetwork(address);
  const r = await request(
    "signPsbt",
    { psbt, signInputs: { [address]: indices }, broadcast: false },
    providerId,
  );
  if (r.status !== "success")
    throw new Error(r.error.message || "Transaction signature declined.");
  await assertWalletNetwork(address);
  return r.result.psbt;
}
