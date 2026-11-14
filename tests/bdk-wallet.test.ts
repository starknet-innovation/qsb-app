import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { Verifier } from "bip322-js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { bdkSigner } from "../sdk/index";

it("uses the exported adapter, preserves the approved selection and refuses declined signing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qsb-bdk-public-test-"));
  try {
    const binary=join(directory,"fake-signer.mjs"), receipt=join(directory,"public-request.json");
    const publicKey="037b198d06ce8f4e474528221af12c7b5d0ac4212b0c78aed8b2efc6516b3c347f";
    const address="bc1q0aw99z9zu986hkhks7dr42wfcz8xkww89dpaw4";
    writeFileSync(binary, `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';\nif(process.argv[2]==='info') console.log(JSON.stringify(${JSON.stringify({address,publicKey})}));\nelse { const r=JSON.parse(readFileSync(0,'utf8')); writeFileSync(${JSON.stringify(receipt)},JSON.stringify(r)); console.log(r.psbt); }\n`, {mode:0o700});
    const prev = new btc.Transaction();
    prev.addInput({txid:"11".repeat(32),index:0});
    const script=btc.p2wpkh(hex.decode(publicKey)).script;
    prev.addOutput({script,amount:100_000n});
    const tx=new btc.Transaction();
    tx.addInput({txid:prev.id,index:0,nonWitnessUtxo:prev.unsignedTx,witnessUtxo:{script,amount:100_000n}});
    tx.addOutput({script,amount:99_000n});
    const psbt=base64.encode(tx.toPSBT()), inputs=[0];
    const signer=await bdkSigner({binary,directory,approve:async review => {
      expect(review.feeSats).toBe(1000); expect(review.inputs).toEqual([0]);
      inputs[0]=1; review.inputs[0]=2; return true;
    }});
    expect(await signer.signPsbt(address,psbt,inputs)).toBe(psbt);
    expect(JSON.parse(readFileSync(receipt,"utf8")).inputs).toEqual([0]);
    const denied=await bdkSigner({binary,directory,approve:async()=>false});
    await expect(denied.signPsbt(address,psbt,[0])).rejects.toThrow("approval declined");
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

describe.skipIf(process.platform !== "darwin")("BDK local signer", () => {
  it("validates the Rust-produced BIP-322 witness using the service's strict verifier", () => {
    const output = execFileSync("cargo", ["test", "--locked", "--manifest-path",
      "tools/qsb-bdk-wallet/Cargo.toml", "public_fixture_signature", "--", "--nocapture"],
      { encoding: "utf8", timeout: 120_000 });
    const lines = output.split("\n");
    const index = lines.findIndex(line => line.startsWith('{"address":'));
    expect(index).toBeGreaterThanOrEqual(0);
    const { address } = JSON.parse(lines[index]);
    const signature = lines[index + 1];
    expect(Verifier.verifySignature(address, "QSB public BIP-322 validation", signature, true)).toBe(true);
    expect(Verifier.verifySignature(address, "different message", signature, true)).toBe(false);
    expect(Verifier.verifySignature("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "QSB public BIP-322 validation", signature, true)).toBe(false);
    const changed = Buffer.from(signature, "base64"); changed[10] ^= 1;
    expect(() => Verifier.verifySignature(address, "QSB public BIP-322 validation", changed.toString("base64"), true)).not.toThrow();
    expect(Verifier.verifySignature(address, "QSB public BIP-322 validation", changed.toString("base64"), true)).toBe(false);
  }, 120_000);
});
