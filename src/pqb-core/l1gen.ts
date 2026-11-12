// A line-for-line port of pqb/_research/l1gen.py `build()` for the configuration pqb ships:
// shared chained HORS table, stride-3 gadget, depth guard, gated pinning and round menus,
// 'none' / 'sound10' selector ladders, DER-only or full-key puzzle tails, independent menu
// scalars, and the ECDSA co-signature. Any other option throws rather than guess.
//
// The output must be BYTE-identical to the Python: test/vectors.json (tools/js_vectors.py) pins
// every script's sha256, the published artefacts included. The emitter keeps the same live stack
// model as the Python, because every OP_ROLL depth in the script is read off it.
import {
  Bytes, N, P, concat, fromHex, fromInt, hash160, hex, liftX, minimalBE, pubkeyOf, ripemd160, sha1,
  sha256, toInt, utf8,
} from './primitives.js';

export const OP = {
  ZERO: 0x00, TRUE: 0x51, DEPTH: 0x74, VERIFY: 0x69, DROP: 0x75, TWODROP: 0x6d, TWODUP: 0x6e,
  DUP: 0x76,
  OVER: 0x78, ROLL: 0x7a, SWAP: 0x7c, TUCK: 0x7d, SIZE: 0x82, EQUAL: 0x87, EQUALVERIFY: 0x88,
  MIN: 0xa3, RIPEMD160: 0xa6, SHA1: 0xa7, SHA256: 0xa8, HASH160: 0xa9, HASH256: 0xaa,
  CHECKSIG: 0xac, CHECKSIGVERIFY: 0xad, CHECKMULTISIGVERIFY: 0xaf, IF: 0x63, ELSE: 0x67,
  ENDIF: 0x68,
} as const;
const HASHOP: Record<string, number> = {
  ripemd160: 0xa6, sha1: 0xa7, sha256: 0xa8, hash160: 0xa9, hash256: 0xaa,
};
export const DER_PUBKEY33 =
  fromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');

// ------------------------------------------------------------------------------ push encoding
export function scriptnumBytes(v: number): Bytes {
  if (v === 0) return new Uint8Array(0);
  const neg = v < 0;
  let a = Math.abs(v);
  const b: number[] = [];
  while (a > 0) {
    b.push(a & 0xff);
    a = Math.floor(a / 256);
  }
  if (b[b.length - 1] & 0x80) b.push(neg ? 0x80 : 0x00);
  else if (neg) b[b.length - 1] |= 0x80;
  return Uint8Array.from(b);
}

export function pushData(b: Bytes): Bytes {
  if (b.length === 0) return Uint8Array.of(0x00);
  if (b.length === 1 && b[0] >= 1 && b[0] <= 16) return Uint8Array.of(0x50 + b[0]);
  if (b.length === 1 && b[0] === 0x81) return Uint8Array.of(0x4f);
  if (b.length >= 76) throw new Error('table entries must stay under OP_PUSHDATA1');
  return concat([b.length], b);
}

export const pushNum = (v: number): Bytes => pushData(scriptnumBytes(v));

// ----------------------------------------------------------------------------------- secrets
/** The generator's one secret derivation (pqb's declared patch to l1gen._secret). */
export function secret(seed: Bytes | null, label: string): Bytes {
  if (seed === null) return sha256(utf8(label));
  if (seed.length < 32) throw new Error('seed must be at least 32 bytes of entropy');
  return sha256(concat(utf8('pqb/v1|'), seed, utf8('|' + label)));
}

/** The co-signature key pair from 32 secret bytes (l1gen.cosig_key): d = int(secret) mod (n-1) + 1,
 *  so d is in [1, n-1], and its 33-byte compressed public key. */
export function cosigKey(sec: Bytes): { d: bigint; pk: Bytes } {
  const d = (toInt(sec) % (N - 1n)) + 1n;
  return { d, pk: pubkeyOf(d, true) };
}

/** The ECDSA co-signature: public key, its HASH160 (the only part the script carries) and the
 *  private scalar. SIGHASH_ALL is the only hashtype a signer may use. */
export interface Cosig { form: 'p2pkh'; d: bigint; pk: Bytes; h160: Bytes; hashtype: 1 }

// ------------------------------------------------------------------------------------ DER
export function derEncode(r: bigint, s: bigint): Bytes {
  const enc = (v: bigint): Bytes => {
    let b = minimalBE(v);
    if (b.length === 0) b = Uint8Array.of(0);
    if (b[0] & 0x80) b = concat([0], b);
    return concat([0x02, b.length], b);
  };
  const body = concat(enc(r), enc(s));
  return concat([0x30, body.length], body);
}

export const derSig = (r: bigint, s: bigint, ht = 1): Bytes => concat(derEncode(r, s), [ht]);

let _XOK: number[] | null = null;
/** 1-byte r values that are real x-coordinates (l1gen._XOK). */
export function xok(): number[] {
  if (_XOK === null) {
    _XOK = [];
    for (let r = 1; r < 128; r++) if (liftX(BigInt(r)) !== null) _XOK.push(r);
  }
  return _XOK;
}

export function dummyPool(n: number, block = 0): [number, number][] {
  const out: [number, number][] = [];
  const x = xok();
  for (let i = block; i < x.length; i += 4) {
    for (let ss = 1; ss < 128; ss++) {
      out.push([x[i], ss]);
      if (out.length === n) return out;
    }
  }
  throw new Error('dummy signature pool exhausted');
}

export interface BigSig { sig: Bytes; r: bigint; s: bigint }

export function bigSig(tag: string): BigSig {
  let base = toInt(sha256(utf8('r2g4-signonce-' + tag)));
  base = (base | (1n << 255n)) & ~(1n << 254n);
  const s = toInt(concat([0x20], sha256(utf8('s-' + tag)).slice(0, 15)));
  for (let d = 0n; d < 1n << 17n; d++) {
    const r = base + d;
    if (r === 0n || liftX(r) === null) continue;
    const sig = concat([0x30, 0x35, 0x02, 0x21, 0x00], fromInt(r, 32), [0x02, 0x10],
      fromInt(s, 16), [0x01]);
    return { sig, r, s };
  }
  throw new Error('no big sig');
}

// ------------------------------------------------------------------------------------- menus
export interface Menu {
  sigs: Bytes[]; comm: Bytes[]; r: bigint; s: bigint[]; hashname: string; hashop: number;
}

export function makeMenu(tag: string, K: number, hashname: string, smallR: boolean,
  masterSeed: Bytes | null): Menu {
  if (hashname !== 'sha1') throw new Error('only the default SHA-1 menu commitment is ported');
  const seed = secret(masterSeed, 'r2f-menu-' + tag);
  let r: bigint | null = null;
  if (smallR) {
    const x = xok();
    for (let cand = 2; cand < 200; cand++) {
      const c = BigInt(cand);
      if (liftX(c) === null) continue;
      if (c + N >= P || liftX(c + N) === null) continue;
      if (x.includes(cand)) continue;
      r = c;
      break;
    }
  } else {
    const base = toInt(sha256(concat(utf8('r-'), seed))) & ((1n << 255n) - 1n);
    for (let d = 0n; d < 1n << 18n; d++) {
      const cand = (base + d) % (1n << 255n);
      if (cand !== 0n && liftX(cand) !== null && cand < N) {
        r = cand;
        break;
      }
    }
  }
  if (r === null) throw new Error('no menu r');
  // independent menu scalars
  const iseed = secret(masterSeed, 'r5close-indep-menu-' + tag);
  const sigs: Bytes[] = [];
  const svals: bigint[] = [];
  for (let j = 0; j < K; j++) {
    const x = toInt(sha256(concat(iseed, utf8('|' + j))));
    const sj = (x >> 6n) | (1n << 250n);
    if (!(sj > 0n && sj < N)) throw new Error('menu scalar out of range');
    sigs.push(derSig(r, sj));
    svals.push(sj);
  }
  if (new Set(sigs.map((g) => g.length)).size !== 1) throw new Error('menu lengths differ');
  const comm = sigs.map((g) => sha1(g));
  return { sigs, comm, r, s: svals, hashname, hashop: 0xa7 };
}

// ------------------------------------------------------------------ emitter + live stack model
class Emit {
  st: string[];
  buf: number[] = [];
  nops = 0;
  peak: number;

  constructor(initial: string[]) {
    this.st = [...initial];
    this.peak = this.st.length;
  }

  touch() { this.peak = Math.max(this.peak, this.st.length); }
  pos(slot: string): number {
    const i = this.st.indexOf(slot);
    if (i < 0) throw new Error('slot not on the model stack: ' + slot);
    return i;
  }
  depth(slot: string): number { return this.st.length - 1 - this.pos(slot); }

  push(slot: string, data: Bytes) {
    for (const x of pushData(data)) this.buf.push(x);
    this.st.push(slot);
    this.touch();
  }

  pushConst(v: number) {
    for (const x of pushNum(v)) this.buf.push(x);
    this.st.push('#const');
    this.touch();
  }

  op(code: number, extra = 0) {
    this.buf.push(code);
    this.nops += 1 + extra;
  }

  moveToTop(d: number) {
    const [v] = this.st.splice(this.st.length - 1 - d, 1);
    this.st.push(v);
  }

  rollSlot(slot: string): number {
    const d = this.depth(slot);
    this.pushConst(d);
    this.st.pop();
    this.op(OP.ROLL);
    this.moveToTop(d);
    return d;
  }

  tableFetch(sentinel: string, k: number, name: string) {
    this.st.pop();
    const q = this.pos(sentinel);
    this.st.splice(q + k, 1);
    this.st.push(name);
    this.touch();
  }

  constBinop(v: number, code: number, out: string) {
    this.pushConst(v);
    this.op(code);
    this.st.pop();
    this.st.pop();
    this.st.push(out);
  }

  drop(k = 1) { for (let i = 0; i < k; i++) this.st.pop(); }
  dup(name?: string) { this.st.push(name ?? this.st[this.st.length - 1]); this.touch(); }
  swap() {
    const n = this.st.length;
    [this.st[n - 1], this.st[n - 2]] = [this.st[n - 2], this.st[n - 1]];
  }
  tuck() {
    this.op(OP.TUCK);
    this.st.splice(this.st.length - 2, 0, this.st[this.st.length - 1]);
    this.touch();
  }

  ladder(variant: string, L: number, pred: string, CU: Bytes[][], stage: string,
    sha1Chain: boolean) {
    const n32 = pred === 'sha256' || pred === 'hash256';
    const s1 = sha1Chain && !n32;
    if (variant === 'none' || L === 0) {
      this.op(HASHOP[pred]);
      return;
    }
    if (variant !== 'sound10') throw new Error('selector ladder ' + variant + ' is not ported');
    if (s1) throw new Error('sha1_chain is not ported');
    if (n32) this.op(OP.SHA256);
    for (let i = 0; i < L; i++) {
      const hs = i === 0 ? [OP.SHA256] : Array(2 ** (i - 1)).fill(OP.HASH256);
      this.rollSlot(`${stage}_u${i}`);
      this.op(OP.SHA1);
      this.op(OP.DUP); this.dup();
      this.push('#CU', CU[i][1]);
      this.op(OP.EQUAL);
      this.drop(1);
      this.op(OP.IF); this.drop(1);
      this.push('#CU', CU[i][1]);
      this.op(OP.EQUALVERIFY); this.drop(2);
      for (const c of hs) this.op(c);
      this.op(OP.ELSE);
      this.push('#CU', CU[i][0]); this.drop(1);
      this.op(OP.EQUALVERIFY);
      this.op(OP.ENDIF);
    }
    if (!n32) this.op(OP.RIPEMD160);
  }
}

export function rungOps(k: number): number[] {
  if (k === 0) return [0xa6];
  if (k === 1) return [0xa9];
  return [...Array(k - 1).fill(0xa8), 0xa9];
}

export function rungApply(w: Bytes, k: number): Bytes {
  for (let i = 0; i < (k >= 1 ? k - 1 : 0); i++) w = sha256(w);
  return k >= 1 ? ripemd160(sha256(w)) : ripemd160(w);
}

// ------------------------------------------------------------------------------------- build
export interface L1Params {
  R: number; t: number; n: number; m: number; t_list?: number[] | null;
  m_list?: number[] | null; K: number | number[]; predicate?: string[] | null;
  sharing: string; gadget: string; depth_guard: boolean; gates: number; round_gates: number;
  hsel?: [string, number][] | null; der_only: boolean | boolean[]; sha1_chain: boolean;
  der_pk33: boolean; menu_hash?: string; wpad?: number; real_puzzles?: boolean;
  seed?: Bytes | null; cosig?: string | null; pin_keep_false?: boolean; pin_gate_last?: boolean;
  hors_secret_bytes?: number;
}

export interface L1Result {
  script: Bytes; slots: string[]; W: number; ops: number; peak: number;
  wit: Bytes[][]; comm: Bytes[]; dsig: Bytes[]; sigNonce: BigSig[]; pinSig: BigSig;
  menu: Menu | null; rmenu: (Menu | null)[]; rung: number[]; ladU: Bytes[][][];
  ladCU: Bytes[][][]; tl: number[]; ml: number[]; Kl: number[]; hs: [string, number][];
  preds: string[]; derOnly: boolean[]; realPuzzles: boolean;
  /** Holds the co-signature's private scalar: never log or serialise it. */
  cosig: Cosig;
}

export function build(p: L1Params): L1Result {
  const R = p.R;
  const S = R + 1;
  const seed = p.seed ?? null;
  const real = !!p.real_puzzles;
  const tl = p.t_list ? [...p.t_list] : Array(R).fill(p.t);
  const ml = p.m_list ? [...p.m_list] : Array(S).fill(p.m);
  const Kl = Array.isArray(p.K) ? [...p.K] : Array(S).fill(p.K);
  const hs: [string, number][] = p.hsel ? p.hsel.map(([v, l]) => [v, l]) : Array(S).fill(['none', 0]);
  const preds = p.predicate ? [...p.predicate] : Array(R + 1).fill('ripemd160');
  const DO: boolean[] = Array.isArray(p.der_only) ? [...p.der_only] : Array(R + 1).fill(!!p.der_only);
  if (tl.length !== R || ml.length !== S || Kl.length !== S || hs.length !== S ||
    preds.length !== R + 1 || DO.length !== R + 1) throw new Error('per-stage parameter lengths');
  if (!ml.every((x) => [2, 4, 6, 12].includes(x))) throw new Error('m must be 2, 4, 6 or 12');
  if (p.sharing !== 'shared_chained' || p.gadget !== 'stride3')
    throw new Error('only the shared_chained / stride3 layout is ported');
  if (!p.depth_guard) throw new Error('only depth-guarded scripts are ported');
  if (p.gates !== 1) throw new Error('only gated pinning stages are ported');
  if (p.sha1_chain) throw new Error('sha1_chain is not ported');
  if ((p.wpad ?? 0) !== 0) throw new Error('wpad is a measurement knob');
  if (R > 3) throw new Error('HASH160 offers exactly three rungs');
  if (p.cosig !== 'p2pkh') throw new Error("only the 'p2pkh' co-signature is ported");
  if (!p.pin_gate_last || !p.pin_keep_false || !DO[0] || (hs[0][0] !== 'none' && hs[0][1] !== 0))
    throw new Error('only the gate-last, DER-only pinning stage with no selector ladder is ported');
  const hb = p.hors_secret_bytes ?? 32;
  if (!(hb >= 20 && hb <= 32)) throw new Error('hors_secret_bytes must be in [20, 32]');
  const menuHash = p.menu_hash ?? 'sha1';

  // ---- HORS material (shared_chained)
  const rung = Array.from({ length: R }, (_, r) => R - 1 - r);
  const sec: Bytes[] = Array.from({ length: p.n }, (_, j) => secret(seed, 'r2g4-hors-' + j).slice(0, hb));
  const wit: Bytes[][] = [];
  let cur = sec;
  for (let r = 0; r < R; r++) {
    wit.push([...cur]);
    cur = cur.map((x) => sha256(x));
  }
  const comm = Array.from({ length: p.n }, (_, j) => rungApply(wit[0][j], rung[0]));
  const dsig = dummyPool(p.n, 0).map(([a, b]) => derSig(BigInt(a), BigInt(b)));

  const ladU: Bytes[][][] = [];
  const ladCU: Bytes[][][] = [];
  for (let st = 0; st < S; st++) {
    const L = hs[st][1];
    const u = Array.from({ length: L }, (_, i) =>
      [0, 1].map((b) => secret(seed, `k6-lad-${st}-${i}-${b}`)));
    ladU.push(u);
    ladCU.push(u.map((x) => [sha1(x[0]), sha1(x[1])]));
  }

  const sigNonce = Array.from({ length: R }, (_, r) => bigSig('round' + r));
  const pinSig = bigSig('pin');
  const ck = cosigKey(secret(seed, 'cosig-key'));
  const cosig: Cosig = { form: 'p2pkh', d: ck.d, pk: ck.pk, h160: hash160(ck.pk), hashtype: 1 };
  const rg = p.round_gates;
  if (!(rg >= 0 && rg <= R)) throw new Error('round_gates must be <= R');
  const menu = makeMenu('pin', Kl[0], menuHash, [4, 12].includes(ml[0]), seed);
  const rmenu = Array.from({ length: R }, (_, r) =>
    r < rg ? makeMenu('round' + r, Kl[r + 1], menuHash, [4, 12].includes(ml[r + 1]), seed) : null);
  const allc = [menu, ...rmenu].flatMap((m) => (m ? m.comm.map(hex) : []));
  if (new Set(allc).size !== allc.length) throw new Error('menu commitments must be distinct');

  // ---- scriptSig slot order (bottom .. top)
  const slots: string[] = [];
  for (let r = 0; r < R; r++) {
    slots.push('kn' + r);
    if (!DO[r + 1]) slots.push('X' + r);
    for (let a = 0; a < tl[r]; a++) slots.push(`k${r}_${a}`);
  }
  for (let r = R - 1; r >= 0; r--) for (let a = tl[r] - 1; a >= 0; a--) slots.push(`pre${r}_${a}`);
  for (let r = R - 1; r >= 0; r--) for (let a = tl[r] - 1; a >= 0; a--) slots.push(`i${r}_${a}`);
  for (let r = 0; r < R; r++) if (rmenu[r]) slots.push('msig' + r, 'midx' + r);
  slots.push('menu_idx', 'menu_sig');
  for (let st = 0; st < S; st++) {
    const [v, L] = hs[st];
    const tag = st === 0 ? 'pin' : 'r' + (st - 1);
    for (let i = 0; i < L; i++) {
      if (v === 'sound9' || v === 'sound10') slots.push(`${tag}_u${i}`);
      if (v === 'ungated' || v === 'sound9') slots.push(`${tag}_b${i}`);
    }
  }
  slots.push('knpin');
  slots.push('cosig_sig', 'cosig_pk');                    // the public key on top

  const e = new Emit(slots);
  const W = slots.length;

  // ---- the depth guard
  e.op(OP.DEPTH);
  e.st.push('#depth'); e.touch();
  e.pushConst(W);
  e.op(OP.EQUALVERIFY); e.drop(2);

  // ---- the co-signature: P2PKH on the top two items, ANDed with everything below. Its sighash
  // is the whole script with nothing deleted.
  e.op(OP.DUP); e.dup();
  e.op(OP.HASH160); e.st[e.st.length - 1] = '#cosig_hash';
  e.push('#cosig_h160', cosig.h160);
  e.op(OP.EQUALVERIFY); e.drop(2);
  e.op(OP.CHECKSIGVERIFY); e.drop(2);

  // ---- stage 0: pinning (gated, DER-only): check the pair, run the puzzle on knpin, then open
  // the gate on the menu entry
  e.op(OP.TWODUP); e.st.push(...e.st.slice(-2)); e.touch();
  e.op(OP.CHECKSIGVERIFY); e.drop(2);
  if (ml[0] === 2 || ml[0] === 4) sizeGuard(e);
  e.ladder(hs[0][0], hs[0][1], preds[0], ladCU[0], 'pin', false);
  pushDerPubkey(e, p.der_pk33);
  if (real) e.op(OP.CHECKSIG);       // DER-only: the result is never read and stays on the stack
  else e.op(OP.EQUAL);               // elided: 1 opcode, 1 byte, the same empty false
  e.drop(2);
  e.st.push('#false'); e.touch();
  e.push('MSENT', Uint8Array.of(1));
  menu.comm.forEach((c, i) => e.push('MC_' + i, c));
  e.rollSlot('menu_idx');
  {
    const L = e.st.length;
    const cap = (L - 1) - 1 - (e.pos('MSENT') + 1);
    e.constBinop(cap, OP.MIN, '#clamped');
  }
  e.op(OP.ROLL);
  e.tableFetch('MSENT', 1, 'MC_sel');
  e.rollSlot('menu_sig');
  e.op(menu.hashop);
  e.op(OP.EQUALVERIFY); e.drop(2);

  // ---- the shared chained table, stride-3
  e.push('TSENT', Uint8Array.of(1));
  for (let j = 0; j < p.n; j++) {
    e.push('D_' + j, dsig[j]);
    e.push('F_' + j, Uint8Array.of(1));
    e.push('C_' + j, comm[j]);
  }
  const csent = 'TSENT';

  // ---- rounds
  for (let r = 0; r < R; r++) {
    const rm = rmenu[r];
    if (rm) {
      e.push('MSENT' + r, Uint8Array.of(1));
      rm.comm.forEach((c, i) => e.push(`MC${r}_${i}`, c));
    }
    e.push('dummy' + r, new Uint8Array(0));
    if (!rm) e.push('sn' + r, sigNonce[r].sig);
    for (let a = 0; a < tl[r]; a++) {
      e.rollSlot(`i${r}_${a}`);
      // depth guard: no per-selection clamp
      e.op(OP.DUP); e.dup();
      e.op(OP.ROLL);
      e.tableFetch(csent, 3, `CSEL${r}_${a}`);
      e.rollSlot(`pre${r}_${a}`);
      for (const oc of rungOps(rung[r])) e.op(oc);
      e.op(OP.EQUALVERIFY); e.drop(2);
      e.op(OP.ROLL);
      e.tableFetch(csent, 1, `SIG${r}_${a}`);
    }
    if (rm) {
      e.rollSlot('midx' + r);
      const L = e.st.length;
      const cap = (L - 1) - 1 - (e.pos('MSENT' + r) + 1);
      e.constBinop(cap, OP.MIN, '#clamped');
      e.op(OP.ROLL);
      e.tableFetch('MSENT' + r, 1, 'MC_sel' + r);
      e.rollSlot('msig' + r);
      e.tuck();
      e.op(rm.hashop);
      e.op(OP.EQUALVERIFY); e.drop(2);
    }
    const M = tl[r] + 1;
    e.pushConst(M);
    if (!rm) e.rollSlot('kn' + r);
    else {
      for (let a = 0; a < tl[r]; a++) e.rollSlot(`k${r}_${a}`);
      e.rollSlot('kn' + r);
    }
    if (ml[r + 1] === 2 || ml[r + 1] === 4) sizeGuard(e);
    e.op(OP.DUP); e.dup();
    e.ladder(hs[r + 1][0], hs[r + 1][1], preds[r + 1], ladCU[r + 1], 'r' + r, false);
    if (DO[r + 1]) {
      pushDerPubkey(e, p.der_pk33);
      puzzleTailDer(e, real);
    } else {
      e.rollSlot('X' + r);
      puzzleTailKey(e, real);
    }
    if (!rm) for (let a = 0; a < tl[r]; a++) e.rollSlot(`k${r}_${a}`);
    e.pushConst(M);
    e.op(OP.CHECKMULTISIGVERIFY, M);
    e.st.splice(e.st.length - (2 * M + 3), 2 * M + 3);
  }
  // tail: OP_TRUE is a push, not a charged opcode
  e.buf.push(OP.TRUE);
  e.st.push('TRUE'); e.touch();

  return {
    script: Uint8Array.from(e.buf), slots, W, ops: e.nops, peak: e.peak, wit, comm, dsig,
    sigNonce, pinSig, menu, rmenu, rung, ladU, ladCU, tl, ml, Kl, hs, preds, derOnly: DO,
    realPuzzles: real, cosig,
  };
}

function sizeGuard(e: Emit) {
  e.op(OP.SIZE); e.dup('#size');
  e.pushConst(33); e.st.pop();
  e.op(OP.EQUALVERIFY); e.drop(1);
}

function pushDerPubkey(e: Emit, pk33: boolean) {
  if (pk33) e.push('#pk33', DER_PUBKEY33);
  else e.pushConst(0);
}

function puzzleTailDer(e: Emit, real: boolean) {
  if (real) {
    e.op(OP.CHECKSIG); e.drop(2);
    e.st.push('#false'); e.touch();
    e.op(OP.DROP); e.drop(1);
  } else {
    e.op(OP.DROP); e.drop(1);
    e.op(OP.DROP); e.drop(1);
  }
}

function puzzleTailKey(e: Emit, real: boolean) {
  if (real) { e.op(OP.CHECKSIGVERIFY); e.drop(2); } else { e.op(OP.TWODROP); e.drop(2); }
}
