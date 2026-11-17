import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Item, Sim, scriptnumVal } from "../src/pqb-core/sim";
import { concat, hash256, u32le } from "../src/pqb-core/primitives";
import { parseStrictDer } from "../src/pqb-core/grind";
import { pushData, scriptnumBytes } from "../src/pqb-core/l1gen";
import { cloneTx, findAndDelete, parseScript, serializeTx, type Tx } from "../src/pqb-core/tx";

/**
 * Check the returned PQB stack, hashes and signature opcodes before helper signing. This
 * deliberately supports only PQB's emitted opcode set. Bitcoin Core remains the consensus oracle.
 * The upstream layout simulator treats signatures permissively; intercept them here and verify
 * against the actual transaction with Bitcoin's legacy FindAndDelete rules.
 */
export function verifyPqbWitness(rawHex: string, scriptHex: string): void {
  const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
  const parsed = btc.Transaction.fromRaw(hex.decode(rawHex), opts);
  const tx: Tx = { version: parsed.version, locktime: parsed.lockTime,
    vin: Array.from({ length: parsed.inputsLength }, (_, i) => {
      const v = parsed.getInput(i);
      return { txid: hex.encode(v.txid!), vout: v.index!, sequence: v.sequence!, scriptSig: new Uint8Array() };
    }), vout: Array.from({ length: parsed.outputsLength }, (_, i) => {
      const v = parsed.getOutput(i); return { value: v.amount!, script: v.script! };
    }) };
  const script = hex.decode(scriptHex);
  const stack = parseScript(parsed.getInput(1).finalScriptSig!).map(([, op, data]) => {
    if (data !== null && data.length <= 520) return new Item(data);
    if (op >= 0x51 && op <= 0x60) return new Item(scriptnumBytes(op - 0x50));
    if (op === 0x4f) return new Item(scriptnumBytes(-1));
    throw new Error("PQB authorization must be push-only with bounded elements.");
  });
  if (stack.length > 1000) throw new Error("PQB witness exceeds the stack limit.");
  const sim = new Sim(parseScript(script), stack);
  const sighash = (code: Uint8Array, type: number) => {
    // Core legacy hashing, including unknown ALL-like types and the SINGLE historical bug.
    const t = cloneTx(tx), base = type & 0x1f;
    if (base === 3 && 1 >= t.vout.length) { const one = new Uint8Array(32); one[0] = 1; return one; }
    t.vin.forEach((v, i) => {
      v.scriptSig = i === 1 ? code : new Uint8Array();
      if (i !== 1 && (base === 2 || base === 3)) v.sequence = 0;
    });
    if (base === 2) t.vout = [];
    if (base === 3) t.vout = [{ value: 0xffffffffffffffffn, script: new Uint8Array() }, t.vout[1]];
    if (type & 0x80) t.vin = [t.vin[1]];
    return hash256(concat(serializeTx(t), u32le(type)));
  };
  let firstSignature = true;
  const check = (sig: Uint8Array, pk: Uint8Array, code: Uint8Array, cosig = false) => {
    if (cosig && sig.at(-1) !== 1) throw new Error("PQB co-signature must use SIGHASH_ALL.");
    if (!sig.length) return false;
    if (!parseStrictDer(sig)) throw new Error("Invalid PQB signature encoding.");
    // PQB allows consensus-valid hybrid keys at its early puzzle stages; noble takes SEC1 keys.
    if (pk.length === 65 && (pk[0] === 6 || pk[0] === 7)) {
      if ((pk[64] & 1) !== (pk[0] & 1)) return false;
      pk = pk.slice(); pk[0] = 4;
    }
    try { return secp256k1.verify(sig.slice(0, -1), sighash(code, sig.at(-1)!), pk,
      { format: "der", prehash: false, lowS: cosig }); }
    catch { return false; }
  };
  while (sim.i < sim.tok.length) {
    const op = sim.tok[sim.i][1];
    let signatureResult: boolean | undefined;
    if (sim.cond.every(Boolean)) {
      const st = sim.st;
      if (op === 0xac || op === 0xad) {
        if (st.length < 2) throw new Error("PQB signature stack is incomplete.");
        const sig = st.at(-2)!.data, pk = st.at(-1)!.data;
        const [code] = findAndDelete(script, pushData(sig));
        signatureResult = check(sig, pk, code, firstSignature);
        firstSignature = false;
        if (op === 0xad && !signatureResult) throw new Error("Invalid PQB signature.");
      } else if (op === 0xae || op === 0xaf) {
        const nk = scriptnumVal(st.at(-1)!.data);
        if (nk < 0 || nk > 20 || st.length < nk + 2) throw new Error("Invalid PQB multisig stack.");
        const ns = scriptnumVal(st[st.length - nk - 2].data);
        if (ns < 0 || ns > nk || st.length < nk + ns + 3) throw new Error("Invalid PQB multisig stack.");
        const keys = st.slice(st.length - nk - 1, st.length - 1).map(v => v.data);
        const sigs = st.slice(st.length - nk - ns - 2, st.length - nk - 2).map(v => v.data);
        if (st[st.length - nk - ns - 3].data.length) throw new Error("PQB multisig dummy must be empty.");
        let code = script;
        for (const sig of sigs) [code] = findAndDelete(code, pushData(sig));
        let k = 0;
        signatureResult = true;
        for (const sig of sigs) {
          while (k < keys.length && !check(sig, keys[k], code)) k++;
          if (k++ >= keys.length) { signatureResult = false; break; }
        }
        if (op === 0xaf && !signatureResult) throw new Error("Invalid PQB multisignature.");
      }
    }
    sim.step();
    if (signatureResult !== undefined && (op === 0xac || op === 0xae))
      sim.st[sim.st.length - 1] = new Item(signatureResult ? Uint8Array.of(1) : new Uint8Array());
    if (sim.peak > 1000 || sim.nops > 201) throw new Error("PQB script exceeds its limits.");
  }
  if (sim.cond.length || !sim.st.length || scriptnumVal(sim.st.at(-1)!.data) !== 1)
    throw new Error("PQB authorization did not finish with a true stack top.");
}
