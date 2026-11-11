// Assembling a vault spend: a port of pqb/spend.py `Spend.assemble` (and _research/l1run.py
// `assemble`, which it drives). The scriptSig holds the hash-based witness (the HORS preimages the
// selection opens, the menu entries and Lamport preimages each stage uses, and public keys
// RECOVERED from each stage's post-FindAndDelete sighash) with the ECDSA co-signature and its
// public key on top. The co-signature's is the only private key used. Selection indices come from
// executing the emitted script (sim.ts). Nothing here checks consensus: test the result against a
// node (testmempoolaccept) or MARA Slipstream's /api/mempool/tests before broadcasting.
import { L1Result, pushData, scriptnumBytes } from './l1gen.js';
import { Lock } from './lock.js';
import {
  Bytes, N, Point, PointT, concat, equal, fromInt, hash160, hex, liftX, powmod, signDer, toInt,
} from './primitives.js';
import { Item, ScriptError, Sim, makeResolver, makeRollResolver } from './sim.js';
import { Tx, findAndDelete, legacySighashAll, parseScript, serializeTx, txid } from './tx.js';

export const PIN_LT_MIN = 500000000;
export const PIN_LT_END = 1700000000;
export const PIN_SEQ_MIN = 0x80000000;
export const PIN_SEQ_MAX = 0xfffffffd;
export const PIN_LT_N = PIN_LT_END - PIN_LT_MIN;
export const PIN_NONCE_SPACE = BigInt(PIN_SEQ_MAX - PIN_SEQ_MIN + 1) * BigInt(PIN_LT_N);

/** (nLockTime, nSequence) for pinning nonce `nonce` (grind.pin_fields). */
export function pinFields(nonce: bigint): [number, number] {
  if (nonce < 0n || nonce >= PIN_NONCE_SPACE) throw new Error('pinning nonce out of range');
  return [PIN_LT_MIN + Number(nonce % BigInt(PIN_LT_N)), PIN_SEQ_MIN + Number(nonce / BigInt(PIN_LT_N))];
}

export function pinNonceOf(locktime: number, sequence: number): bigint | null {
  if (!(locktime >= PIN_LT_MIN && locktime < PIN_LT_END && sequence >= PIN_SEQ_MIN && sequence <= PIN_SEQ_MAX)) return null;
  return BigInt(sequence - PIN_SEQ_MIN) * BigInt(PIN_LT_N) + BigInt(locktime - PIN_LT_MIN);
}

/** P = r^-1 (sR - zG), R = lift_x(r, parity = recid & 1): l1gen.recover_pubkey. */
export function recoverPubkey(r: bigint, s: bigint, z: bigint, recid: number): PointT | null {
  const R = liftX(r, (recid & 1) === 1);
  if (R === null) return null;
  const rinv = powmod(r, N - 2n, N);
  const sR = R.multiply(s % N);
  const negz = (N - (z % N)) % N;
  const tmp = negz === 0n ? sR : sR.add(Point.BASE.multiply(negz));
  if (tmp.is0()) return null;
  return tmp.multiply(rinv);
}

function rec(r: bigint, s: bigint, z: bigint): Bytes {
  const q = recoverPubkey(r, s, z, 0) ?? recoverPubkey(r, s, z, 1);
  if (!q) throw new Error('no recoverable key');
  return q.toBytes(true);
}

/** SIGHASH_ALL, the only hashtype a co-signature may carry. The script cannot enforce it, so the
 *  signer does: any other hashtype could let a signature be replayed onto another transaction. */
export const COSIG_HASHTYPE = 0x01;

/** The co-signature over sighash `z`: RFC 6979 ECDSA, low S, DER, then the SIGHASH_ALL byte
 *  (l1run.cosig_sign). Byte-identical to libsecp256k1. */
export function cosigSign(d: bigint, z: bigint, hashtype: number = COSIG_HASHTYPE): Bytes {
  if (hashtype !== COSIG_HASHTYPE) throw new Error('a co-signature is SIGHASH_ALL (0x01) only');
  return concat(signDer(fromInt(z, 32), d), [COSIG_HASHTYPE]);
}

/** The co-signature's HASH160 as the lock carries it, read off the script bytes: bytes 4..6 are
 *  OP_DUP OP_HASH160 PUSH20, right after the 4-byte depth guard. */
export function cosigHashInScript(script: Bytes): Bytes {
  if (!(script[4] === 0x76 && script[5] === 0xa9 && script[6] === 0x14 && script[27] === 0x88 &&
    script[28] === 0xad)) throw new Error('the script does not carry the co-signature where PQB puts it');
  return script.slice(7, 27);
}

/** t distinct indices per round, pairwise disjoint on a shared table (l1run.default_subsets). */
export function defaultSubsets(n: number, tl: number[]): number[][] {
  if (tl.reduce((a, b) => a + b, 0) > n) throw new Error('a shared table needs n >= sum(t)');
  const sel: number[][] = [];
  const used = new Set<number>();
  tl.forEach((t, r) => {
    const row: number[] = [];
    let j = (7 * r + 3) % n;
    let guard = 0;
    while (row.length < t) {
      if (++guard > 20 * n) throw new Error('subset generator stuck');
      if (!used.has(j % n) && !row.includes(j % n)) { row.push(j % n); used.add(j % n); }
      j = (j + 11) % n;
    }
    sel.push(row.sort((a, b) => a - b));
  });
  return sel;
}

export interface Funding { txid: string; vout: number; amount: number }

export interface SpendOptions {
  /** qsb-app: exact caller-approved transaction, with the vault at inputIndex. */
  transaction?: Tx;
  inputIndex?: number;
  selection?: number[][];
  /** menu entry per gated stage: 'pin' and round numbers */
  menuPick?: { pin?: number; [round: number]: number };
  /** selector ladder branch per stage tag: 'pin', 'r0', 'r1' */
  hashPick?: Record<string, number>;
  locktime?: number;
  version?: number;
  sequence?: number;
  /** the pinning stage's solved nonce: sets nLockTime and nSequence */
  pinNonce?: bigint;
  /** witness slots the grind solved (puzzle keys in their solved encoding) */
  puzzleKeys?: Record<string, Bytes>;
}

export interface AssembledSpend {
  tx: Tx; raw: Bytes; hex: string; txid: string; scriptSig: Bytes; z: bigint[]; nfound: number[];
  /** the co-signature's sighash: the whole script, nothing deleted */
  zCosig: bigint;
  selection: number[][]; indices: Record<string, number>; simError: string | null;
  /** the secrets this witness publishes (HORS preimages, menu entries, Lamport preimages) */
  revealed: Bytes[];
}

const isIndexSlot = (s: string) => (s.startsWith('i') && s.includes('_')) || s === 'menu_idx' || s.startsWith('midx');
const isSecretSlot = (s: string) => s === 'menu_sig' || s.startsWith('pre') || s.startsWith('msig') ||
  (s.includes('_u') && /^\d+$/.test(s.split('_u').pop()!));

export function assemble(lock: Lock, funding: Funding, outputs: [number | bigint, Bytes][],
  o: SpendOptions = {}): AssembledSpend {
  const res: L1Result = lock.detail;
  let locktime = o.locktime ?? 0;
  let sequence = o.sequence ?? 0xffffffff;
  if (o.pinNonce !== undefined) [locktime, sequence] = pinFields(o.pinNonce);
  const tx: Tx = o.transaction ?? {
    version: o.version ?? 2, locktime,
    vin: [{ txid: funding.txid, vout: funding.vout, scriptSig: new Uint8Array(0), sequence }],
    vout: outputs.map(([v, s]) => ({ value: BigInt(v), script: s })),
  };
  const nIn = o.inputIndex ?? 0;
  const R = res.tl.length;
  const sel = o.selection ?? defaultSubsets(res.comm.length, res.tl);
  const script = res.script;

  // ---- FindAndDelete + legacy sighash, per stage
  const dele: Bytes[][] = [[]];                                // gated: the menu entry is in the scriptSig
  for (let r = 0; r < R; r++) {
    const base = res.rmenu[r] ? [] : [res.sigNonce[r].sig];
    dele.push([...base, ...sel[r].map((j) => res.dsig[j])]);
  }
  const z: bigint[] = [];
  const nfound: number[] = [];
  for (const pats of dele) {
    let code = script;
    let tot = 0;
    for (const pat of pats) {
      const [c, k] = findAndDelete(code, pushData(pat));
      code = c; tot += k;
    }
    nfound.push(tot);
    z.push(toInt(legacySighashAll(tx, nIn, code)));
  }

  // ---- the ECDSA co-signature, over the whole script. Check the derived key against the lock
  // first: a key that does not match it can never spend it.
  const zCosig = toInt(legacySighashAll(tx, nIn, script));
  if (!equal(hash160(res.cosig.pk), cosigHashInScript(script)))
    throw new Error('the co-signature key does not match this lock');
  const vals = new Map<string, Bytes>();
  vals.set('cosig_pk', res.cosig.pk);
  vals.set('cosig_sig', cosigSign(res.cosig.d, zCosig));

  // ---- key recovery at the POST-DELETION sighash
  const mp = o.menuPick ?? {};
  const menu = res.menu!;
  const mi0 = mp.pin ?? 0;
  vals.set('menu_sig', menu.sigs[mi0]);
  vals.set('knpin', rec(menu.r, menu.s[mi0], z[0]));
  for (let r = 0; r < R; r++) {
    const mm = res.rmenu[r];
    if (mm) {
      const mi = mp[r] ?? 0;
      vals.set('msig' + r, mm.sigs[mi]);
      vals.set('kn' + r, rec(mm.r, mm.s[mi], z[r + 1]));
    } else {
      vals.set('kn' + r, rec(res.sigNonce[r].r, res.sigNonce[r].s, z[r + 1]));
    }
    vals.set('X' + r, rec(2n, BigInt(5 + r), z[r + 1]));
    sel[r].forEach((j, a) => {
      const d = res.dsig[j];
      vals.set(`k${r}_${a}`, rec(BigInt(d[4]), BigInt(d[7]), z[r + 1]));
      vals.set(`pre${r}_${a}`, res.wit[r][j]);
    });
  }
  // ---- the selector ladder's witness
  const hp = o.hashPick ?? {};
  res.hs.forEach(([variant, L], st) => {
    const tag = st === 0 ? 'pin' : 'r' + (st - 1);
    const k = L ? (hp[tag] ?? 0) % 2 ** L : 0;
    for (let i = 0; i < L; i++) {
      const b = (k >> i) & 1;
      if (variant === 'sound9' || variant === 'sound10') vals.set(`${tag}_u${i}`, res.ladU[st][i][b]);
      if (variant === 'ungated' || variant === 'sound9') vals.set(`${tag}_b${i}`, b ? Uint8Array.of(1) : new Uint8Array(0));
    }
  });

  // ---- resolve the selection indices by EXECUTING the emitted script
  const targets = new Map<string, Bytes>();
  sel.forEach((row, r) => row.forEach((j, a) => targets.set(`i${r}_${a}`, res.comm[j])));
  targets.set('menu_idx', menu.comm[mi0]);
  res.rmenu.forEach((mm, r) => { if (mm) targets.set('midx' + r, mm.comm[mp[r] ?? 0]); });
  const init = res.slots.map((s) => new Item(isIndexSlot(s) ? Uint8Array.of(0) : mustGet(vals, s), 'sigslot:' + s));
  const m = new Sim(parseScript(script), init, makeResolver(targets), makeRollResolver(targets));
  let simError: string | null = null;
  try { m.run(); } catch (e) { if (e instanceof ScriptError) simError = e.message; else throw e; }
  const indices: Record<string, number> = {};
  for (const [k, v] of m.resolved) { indices[k] = v; vals.set(k, scriptnumBytes(v)); }
  for (const [k, v] of Object.entries(o.puzzleKeys ?? {})) vals.set(k, v);

  // ---- scriptSig
  const scriptSig = concat(...res.slots.map((s) => pushData(mustGet(vals, s))));
  tx.vin[nIn].scriptSig = scriptSig;
  const raw = serializeTx(tx);
  return {
    tx, raw, hex: hex(raw), txid: txid(tx), scriptSig, z, nfound, zCosig, selection: sel, indices,
    simError, revealed: res.slots.filter(isSecretSlot).map((s) => mustGet(vals, s)),
  };
}

function mustGet(m: Map<string, Bytes>, k: string): Bytes {
  const v = m.get(k);
  if (v === undefined) throw new Error('no value for witness slot ' + k);
  return v;
}
