// Local public-key UI fixture. No real wallet or network broadcast.
import { createRoot } from "react-dom/client";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import TransactionDialog from "../src/TransactionDialog";
import { encryptRecovery } from "../src/lib/backup";
import type { PublicVault } from "../src/lib/model";
export async function mount() {
  const key = new Uint8Array(32).fill(7),
    pub = secp256k1.getPublicKey(key);
  const address = btc.p2wpkh(pub).address!;
  const previous = new btc.Transaction();
  previous.addInput({ txid: "11".repeat(32), index: 0 });
  previous.addOutputAddress(address, 100000n);
  const vault: PublicVault = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Funding",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex: "51".repeat(100),
    scriptHash: "aa".repeat(32),
    paymentAddress: address,
    publicStateJson: "{}",
    status: "unfunded",
  };
  const password = "public browser test password";
  const backup = await encryptRecovery(
    { format: "qsb-recovery-v1", vault, stateJson: "{}" },
    password,
  );
  Object.assign(window, {
    fundingFixture: {
      vault,
      previousTxHex: hex.encode(previous.toBytes(true, true)),
      point: { txid: previous.id, vout: 0, value: "100000" },
    },
    walletCalls: 0,
    recordCalls: 0,
    signFunding: (psbt: string) => {
      const tx = btc.Transaction.fromPSBT(base64.decode(psbt), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      tx.sign(key);
      tx.finalize();
      return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
    },
  });
  const el = document.createElement("div");
  document.body.append(el);
  createRoot(el).render(
    <TransactionDialog
      vault={vault}
      wallet={{ address, publicKey: hex.encode(pub), type: "p2wpkh" }}
      onClose={() => {}}
      onUpdated={() => {}}
    />,
  );
  return { backup, password };
}
