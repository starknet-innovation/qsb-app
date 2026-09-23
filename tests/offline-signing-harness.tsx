import { createRoot } from "react-dom/client";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import OfflineSigning from "../src/OfflineSigning";
import { createOfflineRequest } from "../src/lib/offline-fixture";
import { encryptRecovery } from "../src/lib/backup";
export async function mount() {
  document.getElementById("root")!.style.display = "none";
  const key = new Uint8Array(32).fill(23),
    publicKey = hex.encode(secp256k1.getPublicKey(key)),
    payment = btc.p2wpkh(hex.decode(publicKey));
  const wallet = { publicKey, address: payment.address!, type: "p2wpkh" };
  const scriptHex = "51".repeat(100),
    scriptHash = hex.encode(sha256(hex.decode(scriptHex)));
  const publicState = {
    config: "A",
    hash_mode: "sha256",
    n: 150,
    t1s: 8,
    t1b: 1,
    t2s: 7,
    t2b: 2,
    hors_commitments: Array.from({ length: 2 }, () =>
      Array(150).fill("00".repeat(20)),
    ),
    dummy_sigs: Array.from({ length: 2 }, () => Array(150).fill("3000")),
    pin_r: 1,
    pin_s: 1,
    pin_sig: "3000",
    round_sigs: [
      { r: 1, s: 1, sig: "3000" },
      { r: 1, s: 1, sig: "3000" },
    ],
    full_script_hex: scriptHex,
  };
  const vault = {
    id: crypto.randomUUID(),
    name: "Offline signing test — never fund",
    createdAt: new Date().toISOString(),
    network: "mainnet" as const,
    config: "A" as const,
    scriptHex,
    scriptHash,
    publicStateJson: JSON.stringify(publicState),
    paymentAddress: wallet.address,
    status: "unfunded" as const,
  };
  const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
  const parent = new btc.Transaction(opts);
  parent.addInput({ txid: "00".repeat(32), index: 0xffffffff });
  parent.addOutput({ amount: 100000n, script: hex.decode(scriptHex) });
  parent.addOutput({ amount: 10000n, script: payment.script });
  parent.updateInput(0, { finalScriptSig: Uint8Array.of(0) }, true);
  const manifest = {
    vaultId: vault.id,
    funding: { txid: parent.id, vout: 0, value: "100000" },
    helper: { txid: parent.id, vout: 1, value: "10000" },
    destination: wallet.address,
    outputScript: hex.encode(payment.script),
    outputValue: "90000",
    fee: "20000",
    idempotencyKey: crypto.randomUUID(),
    costAccepted: true,
  };
  const solution = {
    sequence: 1,
    locktime: 0,
    round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    round2: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  };
  const assembled = new btc.Transaction({ ...opts, version: 1, lockTime: 0 });
  assembled.addInput({ txid: parent.id, index: 1, sequence: 0xfffffffe });
  assembled.addInput({ txid: parent.id, index: 0, sequence: 1 });
  assembled.addOutput({ amount: 90000n, script: payment.script });
  // Shape-only disposable payload, explicitly not a valid QSB authorization.
  const payload = btc.Script.encode(
    Array.from({ length: 57 }, (_, i) =>
      i % 3 === 0 ? secp256k1.getPublicKey(key) : new Uint8Array(20).fill(i),
    ),
  );
  assembled.updateInput(1, { finalScriptSig: payload }, true);
  const bundle = {
    format: "qsb-offline-signing-bundle-v1",
    request: createOfflineRequest(wallet, vault),
    fixture: {
      network: "regtest",
      fundingRawTx: hex.encode(parent.toBytes(true, true)),
      manifest,
    },
    solution,
  };
  const backup = await encryptRecovery(
    {
      format: "qsb-recovery-v1",
      vault,
      stateJson: "disposable synthetic recovery",
    },
    "disposable browser signing password",
  );
  const state = {
    calls: [] as any[],
    raw: hex.encode(assembled.toBytes(true, true)),
    scriptHash,
    hold: false,
    resolve: undefined as undefined | (() => void),
    payload: hex.encode(payload),
    bundle,
  };
  (window as any).offlineSigningTest = state;
  (window as any).testWalletRequest = async (method: string, params: any) => {
    state.calls.push({ method, params });
    if (state.hold)
      await new Promise<void>((resolve) => {
        state.resolve = resolve;
      });
    const tx = btc.Transaction.fromPSBT(base64.decode(params.psbt), opts);
    tx.signIdx(key, 0);
    return { status: "success", result: { psbt: base64.encode(tx.toPSBT()) } };
  };
  const fill = (label: string, text: string) => {
    const input = Array.from(document.querySelectorAll("label"))
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector("input");
    if (!input) throw Error("Missing fixture input");
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([text], "disposable.json", { type: "application/json" }),
    );
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  (window as any).loadPublicBundle = () =>
    fill("Public solved bundle", JSON.stringify(bundle));
  (window as any).loadPrivateFixture = () =>
    fill("Matching private backup", backup);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<OfflineSigning wallet={wallet} />);
  (window as any).changeFixtureWallet = () =>
    root.render(
      <OfflineSigning
        wallet={{
          ...wallet,
          address: btc.p2wpkh(
            secp256k1.getPublicKey(new Uint8Array(32).fill(24)),
          ).address!,
        }}
      />,
    );
}
