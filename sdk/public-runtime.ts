import { readFile } from "node:fs/promises";
import { loadPyodide } from "pyodide";
import { startQsbRuntime } from "../src/lib/qsb-runtime";
import { commitmentOperations } from "../src/lib/qsb-operations";
import { canonical } from "../src/lib/provenance";
import { validatePublicState, type PublicVault, type Job, type Withdrawal } from "../src/lib/model";
import { checkPqbHit, pqbHitsSchema, pqbPacket, pqbSelection, pqbTransaction } from "../src/lib/pqb";
import { parseScript, serializeTx } from "../src/pqb-core/tx";
import { hex, fromHex, sha256, hash160 } from "../src/pqb-core/primitives";
import * as btc from "@scure/btc-signer";
import { verifyPqbWitness } from "./verify-pqb-witness";
import { pinFields } from "../src/pqb-core/spend";

const sources = new URL("../public/qsb/", import.meta.url);
/** Only public inputs are accepted by this facade. No generator, recovery import or secret assembler. */
export function publicRuntime() {
  let loaded: ReturnType<typeof startQsbRuntime> | undefined;
  const start = () => (loaded ??= loadPyodide({ stdout: () => {}, stderr: () => {} }).then(py =>
    startQsbRuntime(py, async file => new Uint8Array(await readFile(new URL(file, sources))))));
  const run = async (method: "setup_from_commitments" | "prepare" | "finish", args: string[] = []) => {
    const runtime = await start();
    try { return runtime.call(method, args); }
    catch { throw new Error("Public Config A validation failed."); }
  };
  const operations = commitmentOperations((method, args) => {
    if (method !== "setup_from_commitments" && method !== "prepare" && method !== "finish") throw new Error("Public operation required.");
    return run(method, args);
  });
  return {
    async verify(vault: PublicVault, manifest: Withdrawal, solution: NonNullable<Job["solution"]>, raw: string) {
      if (vault.config === "PQB") return verifyPqbWitness(raw, vault.scriptHex);
      const prepared = await operations.prepareAssembly(vault.publicStateJson, manifest, solution);
      const tx = btc.Transaction.fromRaw(Uint8Array.from(raw.match(/../g) ?? [], v => parseInt(v, 16)),
        { allowUnknownInputs: true, allowUnknownOutputs: true });
      const pushes = parseScript(tx.getInput(1).finalScriptSig!).flatMap(([, , data]) => data ? [data] : []);
      const state = JSON.parse(vault.publicStateJson);
      const preimages = [prepared.round0, prepared.round1].flatMap((row, r) => row.map(i => {
        const found = pushes.find(p => hex(hash160(p)) === state.hors_commitments[r][i]);
        if (!found) throw new Error("Missing Config A disclosed preimage.");
        return hex(found);
      }));
      if (await operations.finishAssembly(prepared, preimages) !== raw)
        throw new Error("Config A authorization differs from the verified assembly.");
    },
    async validate(vault: PublicVault) {
      validatePublicState(vault.publicStateJson);
      const state = JSON.parse(vault.publicStateJson);
      if (state.config !== vault.config || state.full_script_hex !== vault.scriptHex)
        throw new Error("Public state does not match the vault script.");
      if (hex(sha256(fromHex(vault.scriptHex))) !== vault.scriptHash)
        throw new Error("Public descriptor script hash mismatch.");
      if (vault.config === "A") {
        // JSON.parse rounds the ECDSA integers. Check ORIGINAL text against the canonical Python
        // public state, so a rounded descriptor cannot pass registration and fail withdrawal later.
        try { (await start()).validatePublicState(vault.publicStateJson); }
        catch { throw new Error("Public state does not exactly match its commitments."); }
      }
    },
    async prepare(vault: PublicVault, manifest: Withdrawal, solution: NonNullable<Job["solution"]>) {
      if (vault.config === "A") {
        const prepared = await operations.prepareAssembly(vault.publicStateJson, manifest, solution);
        return { transaction: prepared.transaction, selection: [prepared.round0, prepared.round1] };
      }
      const hits = pqbHitsSchema.parse(solution.pqb);
      if (!hits.round0 || !hits.round1) throw new Error("Incomplete PQB solution.");
      for (const [stage, line] of [hits.pinning, hits.round0, hits.round1].entries()) {
        const packet = pqbPacket(vault.publicStateJson, manifest, stage, solution);
        const checked = checkPqbHit(packet, line);
        if (!checked) throw new Error("PQB solution failed public verification.");
        if (stage === 0) {
          const [lt, seq] = pinFields(checked.nonce);
          if (lt !== solution.locktime || seq !== solution.sequence) throw new Error("PQB pinning solution changed.");
        } else if (canonical(pqbSelection(packet, line)) !== canonical(stage === 1 ? solution.round1 : solution.round2))
          throw new Error("PQB selection changed.");
      }
      return { transaction: hex(serializeTx(pqbTransaction(manifest, solution.sequence, solution.locktime))),
        selection: [solution.round1, solution.round2] };
    },
  };
}
