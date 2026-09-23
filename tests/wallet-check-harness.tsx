import { createRoot } from "react-dom/client";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import WalletCheck from "../src/WalletCheck";
import type { PublicVault } from "../src/lib/model";
export function mount() {
  document.getElementById("root")!.style.display = "none";
  const privateKey = new Uint8Array(32).fill(19),
    pub = secp256k1.getPublicKey(privateKey);
  const wallet = {
    address: btc.p2wpkh(pub).address!,
    publicKey: hex.encode(pub),
    type: "payment",
  };
  (window as any).walletCheckCalls = [];
  (window as any).testSign = async (
    address: string,
    psbt: string,
    indices: number[],
  ) => {
    (window as any).walletCheckCalls.push({ address, indices });
    const tx = btc.Transaction.fromPSBT(base64.decode(psbt), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    tx.signIdx(privateKey, 0);
    return base64.encode(tx.toPSBT());
  };
  const vault = {
    id: crypto.randomUUID(),
    name: "Synthetic UI fixture",
    scriptHex: "51".repeat(9923),
  } as PublicVault;
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(<WalletCheck wallet={wallet} vaults={[vault]} />);
}
