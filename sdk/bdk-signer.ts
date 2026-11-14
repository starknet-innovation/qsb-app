import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { Verifier } from "bip322-js";
import { signerWallet, type Signer } from "./signer";

export interface BdkTransactionReview {
  psbt: string;
  unsignedTransactionHex: string;
  unsignedTxid: string;
  feeSats: number;
  inputs: number[];
  outputs: { scriptHex: string; amountSats: string }[];
}

/** Node-only adapter. Approval must come from the user reviewing these exact bytes. */
export async function bdkSigner(options: {
  binary: string;
  directory: string;
  approve: (review: BdkTransactionReview) => Promise<boolean>;
}): Promise<Signer> {
  if (!isAbsolute(options.binary) || !isAbsolute(options.directory))
    throw new Error("Use absolute paths for the local BDK binary and wallet directory");
  const run = (command: string, input = ""): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(options.binary, [command, options.directory], { stdio: ["pipe", "pipe", "pipe"] });
    let result = "", error = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.setEncoding("utf8").on("data", data => {
      result += data;
      if (result.length > 6 * 1024 * 1024) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", data => { if (error.length < 8192) error += data; });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Local BDK signer failed: ${error}`));
      else resolve(result.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  const info = JSON.parse(await run("info"));
  const own = (address: string) => {
    if (address !== info.address) throw new Error("BDK signer address mismatch");
  };
  const signer: Signer = {
    address: info.address, publicKey: info.publicKey,
    async signMessage(address, message) {
      own(address);
      const signature = await run("sign-message", message);
      if (!Verifier.verifySignature(address, message, signature, true))
        throw new Error("BDK BIP-322 self-verification failed");
      return signature;
    },
    async signPsbt(address, psbt, inputs) {
      own(address);
      if (psbt.length > 4 * 1024 * 1024) throw new Error("PSBT exceeds limit");
      if (!inputs.length || new Set(inputs).size !== inputs.length || inputs.some(i => !Number.isSafeInteger(i) || i < 0))
        throw new Error("Invalid input selection");
      const selected = [...inputs];
      const tx = btc.Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true });
      const unsignedTxid = btc.Transaction.fromRaw(tx.unsignedTx, { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
      if (tx.fee < 0n || tx.fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid transaction fee");
      const feeSats = Number(tx.fee);
      const approved = await options.approve({ psbt, unsignedTransactionHex: hex.encode(tx.unsignedTx), unsignedTxid,
        feeSats, inputs: [...selected], outputs: Array.from({ length: tx.outputsLength }, (_, i) => {
          const output = tx.getOutput(i);
          return { scriptHex: hex.encode(output.script!), amountSats: output.amount!.toString() };
        }) });
      if (!approved) throw new Error("Exact transaction approval declined");
      return run("sign-deposit", JSON.stringify({ psbt, inputs: selected, approvedUnsignedTxid: unsignedTxid, approvedFeeSats: feeSats }));
    },
  };
  signerWallet(signer);
  return signer;
}
