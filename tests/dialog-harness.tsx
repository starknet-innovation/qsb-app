// Local Playwright harness. Not an application entry point or production route.
import { createRoot } from "react-dom/client";
import TransactionDialog from "../src/TransactionDialog";
import { generateQsb, lockQsb } from "../src/lib/qsb";
import { encryptRecovery } from "../src/lib/backup";
import type { PublicVault } from "../src/lib/model";
export async function mount(address: string) {
  const generated = await generateQsb();
  lockQsb();
  const vault: PublicVault = {
    id: crypto.randomUUID(),
    name: "Withdrawal browser fixture",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex: generated.scriptHex,
    scriptHash: generated.scriptHash,
    paymentAddress: address,
    publicStateJson: generated.publicStateJson,
    status: "confirmed",
    funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
  };
  const backup = await encryptRecovery(
    { format: "qsb-recovery-v1", vault, stateJson: generated.stateJson },
    "browser transaction passphrase",
  );
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(
    <TransactionDialog
      vault={vault}
      wallet={{ address, publicKey: "02" + "11".repeat(32), type: "p2wpkh" }}
      onClose={() => root.unmount()}
      onUpdated={() => {}}
    />,
  );
  return { backup, vault };
}
