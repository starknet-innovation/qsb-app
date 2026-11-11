// Legacy transactions, Core's legacy SignatureHash, and FindAndDelete: what a vault spend needs.
import { Bytes, concat, fromHex, hash256, hex, u32le, u64le, varint } from './primitives.js';

export interface TxIn { txid: string; vout: number; scriptSig: Bytes; sequence: number }
export interface TxOut { value: bigint; script: Bytes }
export interface Tx { version: number; vin: TxIn[]; vout: TxOut[]; locktime: number }

export function serializeTx(tx: Tx): Bytes {
  return concat(u32le(tx.version), varint(tx.vin.length),
    ...tx.vin.map((i) => concat(fromHex(i.txid).reverse(), u32le(i.vout), varint(i.scriptSig.length),
      i.scriptSig, u32le(i.sequence))),
    varint(tx.vout.length),
    ...tx.vout.map((o) => concat(u64le(o.value), varint(o.script.length), o.script)),
    u32le(tx.locktime));
}

export const txid = (tx: Tx): string => hex(hash256(serializeTx(tx)).reverse());

export function cloneTx(tx: Tx): Tx {
  return {
    version: tx.version, locktime: tx.locktime,
    vin: tx.vin.map((i) => ({ ...i, scriptSig: i.scriptSig.slice() })),
    vout: tx.vout.map((o) => ({ ...o, script: o.script.slice() })),
  };
}

/** Script tokens with Core's GetOp framing: [pc, opcode, data | null, length]. */
export type Token = [number, number, Bytes | null, number];

export function parseScript(s: Bytes): Token[] {
  const out: Token[] = [];
  let pc = 0;
  while (pc < s.length) {
    const start = pc;
    const op = s[pc++];
    let data: Bytes | null = null;
    let len = -1;
    if (op < 0x4c) len = op;
    else if (op === 0x4c) len = s[pc++];
    else if (op === 0x4d) { len = s[pc] | (s[pc + 1] << 8); pc += 2; }
    else if (op === 0x4e) { len = new DataView(s.buffer, s.byteOffset + pc, 4).getUint32(0, true); pc += 4; }
    if (len >= 0) {
      data = s.slice(pc, pc + len);
      if (data.length !== len) throw new Error(`truncated push at ${start}`);
      pc += len;
    }
    out.push([start, op, data, pc - start]);
  }
  return out;
}

/** Bit-exact port of CScript::FindAndDelete: matches at opcode boundaries only. */
export function findAndDelete(script: Bytes, pattern: Bytes): [Bytes, number] {
  if (pattern.length === 0) return [script, 0];
  let nFound = 0;
  const result: number[] = [];
  let pc = 0;
  let pc2 = 0;
  const L = script.length;
  const matchAt = (p: number) => {
    if (L - p < pattern.length) return false;
    for (let i = 0; i < pattern.length; i++) if (script[p + i] !== pattern[i]) return false;
    return true;
  };
  for (;;) {
    for (let i = pc2; i < pc; i++) result.push(script[i]);
    while (matchAt(pc)) { pc += pattern.length; nFound++; }
    pc2 = pc;
    if (pc >= L) break;
    const op = script[pc++];
    if (op < 0x4c) pc += op;
    else if (op === 0x4c) { if (pc >= L) break; pc += 1 + script[pc]; }
    else if (op === 0x4d) { if (pc + 1 >= L) break; pc += 2 + (script[pc] | (script[pc + 1] << 8)); }
    else if (op === 0x4e) {
      if (pc + 3 >= L) break;
      pc += 4 + new DataView(script.buffer, script.byteOffset + pc, 4).getUint32(0, true);
    }
    if (pc > L) break;
  }
  if (nFound > 0) {
    for (let i = pc2; i < L; i++) result.push(script[i]);
    return [Uint8Array.from(result), nFound];
  }
  return [script, 0];
}

/** Core's legacy SignatureHash, SIGHASH_ALL only (the vault's hashtype): hash256 of the tx with
 *  every scriptSig emptied and input `nIn`'s set to the scriptCode (OP_CODESEPARATORs removed). */
export function legacySighashAll(tx: Tx, nIn: number, scriptCode: Bytes): Bytes {
  const t = cloneTx(tx);
  for (const i of t.vin) i.scriptSig = new Uint8Array(0);
  t.vin[nIn].scriptSig = findAndDelete(scriptCode, Uint8Array.of(0xab))[0];
  return hash256(concat(serializeTx(t), u32le(1)));
}
