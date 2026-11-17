import { expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { publicRuntime } from "../sdk/public-runtime";
import { nodeQsb } from "./recovery-runtime";
import { parseScript } from "../src/pqb-core/tx";
import { withVaultConfiguration } from "../src/lib/provenance";

// Component regression only: replace the expensive puzzle predicate, keeping the real facade,
// scriptSig parsing, selected-preimage checks and exact Python reconstruction. Not a real solve.
vi.mock("../src/lib/qsb-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/lib/qsb-runtime")>();
  return { ...actual, startQsbRuntime: async (...args: Parameters<typeof actual.startQsbRuntime>) => {
    const runtime = await actual.startQsbRuntime(...args);
    await args[0].runPythonAsync("import qsb_pipeline, secp256k1\n" +
      "_sig = secp256k1.encode_der_sig(secp256k1.G[0], 1, sighash=0x01)\n" +
      "qsb_pipeline.puzzle_hash = lambda pubkey, hash_mode='ripemd160', hash_choice=0: (_sig, True, 0)");
    return runtime;
  } };
});

it("verifies Config A disclosed witnesses and rejects missing/altered preimages and edited scriptSig bytes", async () => {
  const manager = nodeQsb();
  const { stateJson, ...descriptor } = await manager.generateQsb();
  const vault = withVaultConfiguration({ ...descriptor, id: crypto.randomUUID(), name: "public component fixture",
    config: "A", network: "mainnet", createdAt: new Date().toISOString(), status: "unfunded",
    paymentAddress: "bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8" });
  const manifest = { vaultId: vault.id, idempotencyKey: crypto.randomUUID(), costAccepted: true as const,
    funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "20000" },
    destination: vault.paymentAddress, outputScript: "0014" + "33".repeat(20), outputValue: "110000", fee: "10000" };
  const solution = { sequence: 2147483648, locktime: 500000000,
    round1: [0,1,2,3,4,5,6,7,8], round2: [10,11,12,13,14,15,16,17,18] };
  const raw = await manager.assembleQsb(stateJson, manifest, solution);
  manager.lockQsb();
  const runtime = publicRuntime();
  const prepared = await runtime.prepare(vault, manifest, solution);
  await expect(runtime.verify(vault, manifest, solution, raw)).resolves.toBeUndefined();
  const selected = JSON.parse(stateJson).hors_secrets[0][prepared.selection[0][0]] as string;
  const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
  const tx = btc.Transaction.fromRaw(hex.decode(raw), opts);
  const script = tx.getInput(1).finalScriptSig!;
  const token = parseScript(script).find(([, , data]) => data && hex.encode(data) === selected)!;
  expect(token).toBeDefined();
  const changed = (sig: Uint8Array) => {
    const altered = tx.clone(); altered.updateInput(1, { finalScriptSig: sig }, true);
    return hex.encode(altered.toBytes(true, true));
  };
  const missing = new Uint8Array([...script.slice(0, token[0]), ...script.slice(token[0] + token[3])]);
  await expect(runtime.verify(vault, manifest, solution, changed(missing))).rejects.toThrow("Missing Config A disclosed preimage");
  const altered = script.slice(); altered[token[0] + token[3] - 1] ^= 1;
  await expect(runtime.verify(vault, manifest, solution, changed(altered))).rejects.toThrow("Missing Config A disclosed preimage");
  await expect(runtime.verify(vault, manifest, solution, changed(new Uint8Array([...script, 0]))))
    .rejects.toThrow("differs from the verified assembly");
}, 120000);
