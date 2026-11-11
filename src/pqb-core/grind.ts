// The puzzle search, from the caller's side: turn a work packet into the GPU grinder's problem,
// and re-derive every hit the grinder reports. A port of pqb/gpu.py and the parts of
// pqb/grind.py it uses.
//
// Nothing a rented box says is trusted. `HitChecker.check` recomputes each digest from the
// packet's own public data, and every hit that parses as DER at all (plus a sample of the rest)
// is recomputed a second time through the slow canonical path, which rebuilds the transaction
// and runs FindAndDelete. A hit that does not reproduce is an error, not a statistic.
//
// No secret is in a packet or a problem: the menu is CURVE POINTS, never scalars, and the HORS
// preimages that authorise the spend never enter the search.
import type { Lock } from './lock.js';
import { type Menu, pushData } from './l1gen.js';
import {
  Bytes, N, P, Point, PointT, concat, equal, fromHex, hex, liftX, powmod, ripemd160, sha1, sha256,
  hash256, toInt, u32le, varint,
} from './primitives.js';
import { PIN_NONCE_SPACE, pinFields, pinNonceOf, recoverPubkey } from './spend.js';
import { Tx, findAndDelete, legacySighashAll, parseScript, serializeTx } from './tx.js';

export { PIN_NONCE_SPACE };

export const GATE_TAG = 0x301d0200;
export const DEFAULT_GATE_BITS = 24;

/** A work packet, as `pqb grind export` writes it (stageN.packet.json). */
export interface Packet {
  stage: number; kind: 'pinning' | 'round'; predicate: string; sha1_chain: boolean;
  scriptpubkey: string; tx_template: string; n_in: number; hashtype: number;
  only_33_byte_keys: boolean; ladder_levels: number; verify_form: boolean;
  menu?: { r_inv: string | number; variants: { add_n: boolean; odd: boolean; points: string[] }[] };
  fixed_sig?: { r: string | number; s: string | number };
  recovery_points_wanted?: number;
  round_table?: string[]; live_slots?: number[]; used_slots?: number[]; table_n?: number;
  t?: number; deletions_before?: string[];
  nonce_space?: string | number;
  pin_nonce?: string | number | null;
  pqb_packet_sha256?: string;
}

const big = (v: string | number | bigint): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v))
      throw new Error('this integer lost precision in JSON.parse: read packets with parsePacket');
    return BigInt(v);
  }
  return BigInt(v.trim());
};

/** Read a packet (or any pqb JSON) without losing big integers.
 *
 * A packet's `menu.r_inv` and `fixed_sig` are 128- to 256-bit integers, written by Python as
 * bare JSON numbers. `JSON.parse` would round them to doubles and silently corrupt the menu, so
 * integer literals too long for a double become strings here, and `big()` reads either. */
export function parsePacket<T = Packet>(text: string): T {
  return JSON.parse(quoteBigInts(text)) as T;
}

export function quoteBigInts(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {                                   // copy the whole string literal verbatim
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const m = /^-?\d+/.exec(text.slice(i));
    if (m && (i === 0 || !/[\w.$]/.test(text[i - 1]))) {
      const after = text[i + m[0].length];
      const isInt = after !== '.' && after !== 'e' && after !== 'E';
      const digits = m[0].replace('-', '').length;
      out += isInt && digits > 15 ? `"${m[0]}"` : m[0];
      i += m[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ------------------------------------------------------------------------------ subsets
/** The `rank`-th t-subset of range(n), lexicographic (grind.unrank_subset). */
export function unrankSubset(rank: bigint, n: number, t: number): number[] {
  const out: number[] = [];
  let x = 0;
  let remaining = t;
  let r = rank;
  while (remaining) {
    const c = comb(n - x - 1, remaining - 1);
    if (r < c) { out.push(x); remaining--; } else { r -= c; }
    x++;
    if (x > n) throw new Error('subset rank out of range');
  }
  return out;
}

export function rankSubset(subset: number[], n: number): bigint {
  let rank = 0n;
  let prev = -1;
  const t = subset.length;
  subset.forEach((x, k) => {
    if (!(prev < x && x < n)) throw new Error(`not a sorted subset of range(${n})`);
    for (let y = prev + 1; y < x; y++) rank += comb(n - y - 1, t - k - 1);
    prev = x;
  });
  return rank;
}

const _comb = new Map<string, bigint>();
export function comb(n: number, k: number): bigint {
  if (k < 0 || n < 0 || k > n) return 0n;
  const key = `${n},${k}`;
  const hit = _comb.get(key);
  if (hit !== undefined) return hit;
  let r = 1n;
  const kk = BigInt(Math.min(k, n - k));
  for (let i = 0n; i < kk; i++) r = (r * BigInt(n - Number(i))) / (i + 1n);
  if (_comb.size < 100_000) _comb.set(key, r);
  return r;
}

export function roundSelection(p: Packet, nonce: bigint): number[] {
  const live = p.live_slots ?? [...Array(p.table_n ?? 0).keys()];
  return unrankSubset(nonce, live.length, p.t!).map((k) => live[k]);
}

// ------------------------------------------------------------------------------ DER
/** Bitcoin's IsValidSignatureEncoding on a digest treated as a signature (grind). */
export function parseStrictDer(d: Bytes): [bigint, bigint] | null {
  const n = d.length;
  if (n < 9 || n > 73) return null;
  if (d[0] !== 0x30 || d[1] !== n - 3) return null;
  const lenR = d[3];
  if (5 + lenR >= n) return null;
  const lenS = d[5 + lenR];
  if (lenR + lenS + 7 !== n) return null;
  if (d[2] !== 0x02 || lenR === 0 || (d[4] & 0x80)) return null;
  if (lenR > 1 && d[4] === 0 && !(d[5] & 0x80)) return null;
  if (d[lenR + 4] !== 0x02 || lenS === 0 || (d[lenR + 6] & 0x80)) return null;
  if (lenS > 1 && d[lenR + 6] === 0 && !(d[lenR + 7] & 0x80)) return null;
  return [toInt(d.slice(4, 4 + lenR)), toInt(d.slice(6 + lenR, 6 + lenR + lenS))];
}

export function derPrefixBytes(d: Bytes): number {
  const n = d.length;
  let got = 0;
  if (d[0] === 0x30) {
    got = 1;
    if (d[1] === n - 3) {
      got = 2;
      if (d[2] === 0x02) {
        got = 3;
        const lenR = d[3];
        if (lenR > 0 && 5 + lenR < n && !(d[4] & 0x80)) {
          got = 4;
          if (d[lenR + 4] === 0x02) got = 5;
        }
      }
    }
  }
  return got;
}

/** A solved digest becomes a signature; its last byte becomes the hashtype. One in 32 lands in
 *  the SIGHASH_SINGLE class, which is demonstrated theft (rules.is_spendable_der). */
export const isSpendableDer = (d: Bytes): boolean => (d[d.length - 1] & 0x1f) !== 3;

/** Hybrid public keys are refused wherever STRICTENC is enforced (upstream's default policy). */
export const mineableEncoding = (encoding: number): boolean => encoding !== 2;

export function solves(p: Packet, digest: Bytes, z: bigint): boolean {
  const rs = parseStrictDer(digest);
  if (rs === null || !isSpendableDer(digest)) return false;
  if (!p.verify_form) return true;
  return (recoverPubkey(rs[0], rs[1], z, 0) ?? recoverPubkey(rs[0], rs[1], z, 1)) !== null;
}

// ------------------------------------------------------------------------------ keys
/** Every serialisation of a public key Core's parser accepts (grind.encodings). */
export function encodings(point: PointT, only33: boolean): Bytes[] {
  const comp = point.toBytes(true);
  if (only33) return [comp];
  const full = point.toBytes(false);
  // the hybrid-encoded public key (0x06/0x07 prefix): consensus-valid, refused by STRICTENC
  const hybridEncoded = concat([0x06 | (full[64] & 1)], full.slice(1));
  return [comp, full, hybridEncoded];
}

/** The digest the script computes for ladder option `option` (grind.ladder_digest). */
export function ladderDigest(predicate: string, levels: number, sha1Chain: boolean,
  keyBytes: Bytes, option: number): Bytes {
  const n32 = predicate === 'sha256' || predicate === 'hash256';
  const s1 = sha1Chain && !n32;
  if (levels === 0) return single(predicate, keyBytes);
  if (s1) {
    let d = sha1(keyBytes);
    for (let i = 0; i < option; i++) d = sha1(d);
    return d;
  }
  let d = sha256(keyBytes);
  for (let i = 0; i < option; i++) d = sha256(d);
  return n32 ? d : ripemd160(d);
}

function single(predicate: string, b: Bytes): Bytes {
  switch (predicate) {
    case 'sha256': return sha256(b);
    case 'hash256': return hash256(b);
    case 'sha1': return sha1(b);
    case 'ripemd160': return ripemd160(b);
    case 'hash160': return ripemd160(sha256(b));
    default: throw new Error('unknown predicate ' + predicate);
  }
}

/** The R points a signature with this `r` admits (grind.recovery_points). */
export function recoveryPoints(r: bigint, want: number) {
  const out: { add_n: boolean; odd: boolean; point: PointT }[] = [];
  for (const addN of [false, true]) {
    const x = r + (addN ? N : 0n);
    if (x >= P) continue;
    for (const odd of [false, true]) {
      const p = liftX(x, odd);
      if (p !== null) out.push({ add_n: addN, odd, point: p });
    }
    if (out.length >= want) break;
  }
  return out.slice(0, want);
}

export interface Variant { add_n: boolean; odd: boolean; points: PointT[] }

/** (r^-1, recovery variants, is a menu) from a packet (grind._points_from_packet). */
export function pointsFromPacket(p: Packet): { rinv: bigint; variants: Variant[]; menu: boolean } {
  if (p.menu) {
    return {
      rinv: big(p.menu.r_inv), menu: true,
      variants: p.menu.variants.map((v) => ({
        add_n: v.add_n, odd: v.odd, points: v.points.map((h) => Point.fromBytes(fromHex(h))),
      })),
    };
  }
  if (!p.fixed_sig) throw new Error('packet has neither a menu nor a fixed signature');
  const r = big(p.fixed_sig.r);
  const s = big(p.fixed_sig.s);
  const rinv = powmod(r, N - 2n, N);
  const variants = recoveryPoints(r, p.recovery_points_wanted ?? 2).map((pt) => ({
    add_n: pt.add_n, odd: pt.odd, points: [pt.point.multiply((rinv * s) % N)],
  }));
  return { rinv, variants, menu: false };
}

// ------------------------------------------------------------------------------ the canonical path
function templateTx(txHex: string, nonce: bigint, nIn: number): Tx {
  const tx = parseTxHex(txHex);
  const [lt, seq] = pinFields(nonce);
  tx.locktime = lt;
  tx.vin[nIn].sequence = seq;
  return tx;
}

/** A raw transaction (no witness, as a packet template always is) into a Tx. */
export function parseTxHex(h: string): Tx {
  const b = fromHex(h);
  let o = 0;
  const u32 = () => { const v = new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true); o += 4; return v; };
  const vi = () => {
    const x = b[o++];
    if (x < 0xfd) return x;
    if (x === 0xfd) { const v = b[o] | (b[o + 1] << 8); o += 2; return v; }
    if (x === 0xfe) { return u32(); }
    const v = new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
    o += 8;
    if (v > 1_000_000n) throw new Error('varint too large');
    return Number(v);
  };
  const version = u32();
  const nin = vi();
  const vin = [];
  for (let i = 0; i < nin; i++) {
    const txid = hex(b.slice(o, o + 32).reverse()); o += 32;
    const vout = u32();
    const sl = vi();
    const scriptSig = b.slice(o, o + sl); o += sl;
    vin.push({ txid, vout, scriptSig, sequence: u32() });
  }
  const nout = vi();
  const vout = [];
  for (let i = 0; i < nout; i++) {
    const value = new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true); o += 8;
    const sl = vi();
    vout.push({ value, script: b.slice(o, o + sl) });
    o += sl;
  }
  const locktime = u32();
  if (o !== b.length) throw new Error('trailing bytes in the transaction template');
  return { version, vin, vout, locktime };
}

/** One trial from the packet's public data: (digest, z). The slow, canonical path, which
 *  rebuilds the transaction and runs FindAndDelete exactly as the script will (grind.evaluate). */
export function evaluate(p: Packet, nonce: bigint, variant: number, menuIndex: number,
  encoding: number, ladder: number): { digest: Bytes | null; z: bigint } {
  const script = fromHex(p.scriptpubkey);
  let tx: Tx;
  let code: Bytes;
  if (p.kind === 'pinning') {
    tx = templateTx(p.tx_template, nonce, p.n_in);
    code = script;
  } else {
    tx = parseTxHex(p.tx_template);
    const pats = [...(p.deletions_before ?? []),
      ...roundSelection(p, nonce).map((j) => p.round_table![j])].map(fromHex);
    code = script;
    for (const pat of pats) code = findAndDelete(code, pushData(pat))[0];
  }
  if (p.hashtype !== 1) throw new Error('only SIGHASH_ALL packets are supported');
  const z = toInt(legacySighashAll(tx, p.n_in, code)) % N;
  const { rinv, variants } = pointsFromPacket(p);
  const digest = digestFor(p, variants, rinv, z, variant, menuIndex, encoding, ladder);
  return { digest, z };
}

function digestFor(p: Packet, variants: Variant[], rinv: bigint, z: bigint, variant: number,
  menuIndex: number, encoding: number, ladder: number): Bytes | null {
  const v = variants[variant];
  if (!v || menuIndex < 0 || menuIndex >= v.points.length) return null;
  const A = v.points[menuIndex];
  const neg = (N - (rinv * z) % N) % N;
  const key = neg === 0n ? A : A.add(Point.BASE.multiply(neg));
  if (key.is0()) return null;
  const encs = encodings(key, p.only_33_byte_keys);
  if (encoding < 0 || encoding >= encs.length) return null;
  if (!(ladder >= 0 && ladder < (1 << p.ladder_levels))) return null;
  return ladderDigest(p.predicate, p.ladder_levels, p.sha1_chain, encs[encoding], ladder);
}

// ------------------------------------------------------------------------------ the GPU problem
export interface Problem {
  track: string; kind: 'pin' | 'round'; gate_bits: number; gate_tag: number;
  K: number; npts: number; nenc: number; H: number;
  B: [bigint, bigint]; C: [bigint, bigint][][];
  preimage: Bytes; preimage_len: number;
  seq_off?: number; lt_off?: number;
  t?: number; n_table?: number; used_slots?: number[]; n_slots?: number; slot_len?: number;
  slot_offs?: number[];
  pqb_packet_sha256?: string; pqb_stage: number;
}

/** Bitcoin's legacy SIGHASH_ALL preimage of `tx` at n_in with scriptCode `code` (gpu._preimage). */
function preimageOf(p: Packet, tx: Tx, code: Bytes): Bytes {
  const t: Tx = {
    version: tx.version, locktime: tx.locktime,
    vin: tx.vin.map((v, i) => ({ ...v, scriptSig: i === p.n_in ? code : new Uint8Array(0) })),
    vout: tx.vout.map((o) => ({ ...o })),
  };
  return concat(serializeTx(t), u32le(p.hashtype));
}

const xy = (pt: PointT): [bigint, bigint] => [pt.x, pt.y];

/** (offset, length) of the one place FindAndDelete removes `pat` (gpu._unique_push_offset). */
function uniquePushOffset(script: Bytes, pat: Bytes): [number, number] {
  const enc = pushData(pat);
  const hits: number[] = [];
  for (const [pc, , data, len] of parseScript(script)) {
    if (data !== null && len === enc.length && equal(script.slice(pc, pc + len), enc)) hits.push(pc);
  }
  if (hits.length !== 1) throw new Error(`table entry appears ${hits.length} times in the script`);
  return [hits[0], enc.length];
}

/** The GPU problem for one packet, in the grinder's P.json shape (gpu.problem_from_packet). */
export function problemFromPacket(p: Packet, gateBits = DEFAULT_GATE_BITS): Problem {
  if (p.predicate !== 'sha256' || p.sha1_chain)
    throw new Error(`the GPU grinder implements the SHA-256 ladder only; this stage uses ${p.predicate}`);
  if (!(gateBits >= 1 && gateBits <= 24)) throw new Error('gate_bits must be 1..24');
  if (p.hashtype !== 1) throw new Error('only SIGHASH_ALL packets are supported');
  if (p.deletions_before?.length)
    throw new Error('this round deletes a fixed signature as well; the problem format has no slot for it');
  const { rinv, variants } = pointsFromPacket(p);
  variants.forEach((v, rid) => {
    if (v.add_n !== !!(rid >> 1) || v.odd !== !!(rid & 1))
      throw new Error('recovery variants are not in recid order');
  });
  const K = variants[0].points.length;
  const B = xy(Point.BASE.multiply((N - rinv) % N));
  const C: [bigint, bigint][][] = [];
  for (let j = 0; j < K; j++) C.push(variants.map((v) => xy(v.points[j])));
  const script = fromHex(p.scriptpubkey);
  const pinning = p.kind === 'pinning';
  const prob: Problem = {
    track: pinning ? 'pin' : `round${p.stage - 1}`, kind: pinning ? 'pin' : 'round',
    gate_bits: gateBits, gate_tag: GATE_TAG, K, npts: variants.length,
    nenc: p.only_33_byte_keys ? 1 : 3, H: 1 << p.ladder_levels, B, C,
    preimage: new Uint8Array(0), preimage_len: 0,
    pqb_packet_sha256: p.pqb_packet_sha256, pqb_stage: p.stage,
  };
  if (pinning) {
    const a = templateTx(p.tx_template, 0n, p.n_in);
    const b = templateTx(p.tx_template, PIN_NONCE_SPACE - 1n, p.n_in);
    const pa = preimageOf(p, a, script);
    const pb = preimageOf(p, b, script);
    const diff: number[] = [];
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff.push(i);
    const ltOff = pa.length - 8;
    const seqOff = Math.min(...diff);
    const inFields = diff.every((i) => (i >= seqOff && i < seqOff + 4) || (i >= ltOff && i < ltOff + 4));
    if (!(seqOff + 4 <= ltOff && inFields)) throw new Error('cannot locate nSequence/nLockTime in the preimage');
    const pre = pa.slice();
    pre.set(new Uint8Array(4), seqOff);
    pre.set(new Uint8Array(4), ltOff);
    prob.seq_off = seqOff;
    prob.lt_off = ltOff;
    prob.preimage = pre;
  } else {
    const tx = parseTxHex(p.tx_template);
    const t = p.t!;
    const table = p.round_table!.map(fromHex);
    const located = table.map((d) => uniquePushOffset(script, d));
    const slen = located[0][1];
    if (located.some(([, n]) => n !== slen)) throw new Error('table entries differ in length');
    const full = preimageOf(p, tx, script);
    const at = indexOfBytes(full, script);
    const vl = varint(script.length);
    const short = varint(script.length - t * slen);
    if (at < vl.length || !equal(full.slice(at - vl.length, at), vl) || short.length !== vl.length)
      throw new Error('cannot rewrite the scriptCode length');
    const pre = concat(full.slice(0, at - vl.length), short, full.slice(at));
    const live = p.live_slots!;
    const liveOffs = live.map((j) => at + located[j][0]);
    if (liveOffs.some((v, i) => i && v < liveOffs[i - 1])) throw new Error('live slots are not in script order');
    prob.t = t;
    prob.n_table = table.length;
    prob.used_slots = p.used_slots ?? [];
    prob.n_slots = live.length;
    prob.slot_len = slen;
    prob.slot_offs = liveOffs;
    prob.preimage = pre;
  }
  prob.preimage_len = prob.preimage.length;
  return prob;
}

function indexOfBytes(hay: Bytes, needle: Bytes): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** P.json as the CUDA grinder reads it: byte arrays as hex, bigints as decimal strings. */
export function problemJson(prob: Problem): string {
  const enc = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return hex(v);
    if (Array.isArray(v)) return v.map(enc);
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prob)) out[k] = enc(v);
  return JSON.stringify(out);
}

const TXT_KEYS = ['track', 'kind', 'gate_bits', 'gate_tag', 'K', 'npts', 'nenc', 'H', 'preimage_len',
  'seq_off', 'lt_off', 't', 'n_slots', 'slot_len'] as const;

/** P.txt, the line format the CUDA grinder reads (gpu.problem_txt). */
export function problemTxt(prob: Problem): string {
  const h = (v: bigint) => v.toString(16).padStart(64, '0');
  const lines: string[] = [];
  for (const k of TXT_KEYS) if (prob[k] !== undefined) lines.push(`${k} ${prob[k]}`);
  (prob.slot_offs ?? []).forEach((o, i) => lines.push(`slot ${i} ${o}`));
  lines.push(`B ${h(prob.B[0])} ${h(prob.B[1])}`);
  prob.C.forEach((row, j) => row.forEach((pt, rid) => lines.push(`C ${j} ${rid} ${h(pt[0])} ${h(pt[1])}`)));
  lines.push(`preimage ${hex(prob.preimage)}`);
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------------------ hits
export interface Candidate {
  nonce: bigint; variant: number; menuIndex: number; encoding: number; ladder: number;
  digest: Bytes; derBytes: number;
}

/** One grinder hit line -> what it claims (gpu.parse_hit). */
export function parseHit(p: Packet, line: string): {
  nonce: bigint; variant: number; menuIndex: number; encoding: number; ladder: number } {
  const parts = line.trim().split(/\s+/);
  const num = (s: string) => {
    if (!/^\d{1,20}$/.test(s)) throw new Error(`hit field ${JSON.stringify(s)} is not a number`);
    return Number(s);
  };
  if (p.kind === 'pinning') {
    if (parts.length !== 6) throw new Error('a pinning hit has six fields');
    const [seq, lt, j, rid, enc, lvl] = parts.map(num);
    const nonce = pinNonceOf(lt, seq);
    if (nonce === null) throw new Error(`hit (nSequence ${seq}, nLockTime ${lt}) is outside the usable ranges`);
    return { nonce, variant: rid, menuIndex: j, encoding: enc, ladder: lvl - 1 };
  }
  if (parts.length !== 5) throw new Error('a round hit has five fields');
  const pos = parts[0].split(',').map(num);
  const [j, rid, enc, lvl] = parts.slice(1).map(num);
  const nLive = (p.live_slots ?? [...Array(p.table_n ?? 0).keys()]).length;
  return { nonce: rankSubset(pos, nLive), variant: rid, menuIndex: j, encoding: enc, ladder: lvl - 1 };
}

export class HitMismatch extends Error {}

/** Re-derive GPU hits fast enough for a fleet (gpu.HitChecker).
 *
 * The fast path recomputes the digest from the problem's preimage: one fixed-base multiplication
 * and one addition. The first `canonicalFirst` hits, one in every `canonicalEvery`, and every hit
 * that parses as DER at all also go through `evaluate`, which rebuilds the transaction. A
 * disagreement between the two is a bug here, not in the grinder, and is raised as such. */
export class HitChecker {
  readonly rinv: bigint;
  readonly variants: Variant[];
  private readonly shift: number;
  private readonly want: number;
  private readonly zCache = new Map<string, bigint>();
  checked = 0;
  full = 0;
  canonical = 0;
  best: Candidate | null = null;
  bestFull = false;
  solutions: Candidate[] = [];

  constructor(readonly packet: Packet, readonly prob: Problem,
    gateBits = DEFAULT_GATE_BITS, readonly canonicalFirst = 20, readonly canonicalEvery = 2000) {
    const { rinv, variants } = pointsFromPacket(packet);
    this.rinv = rinv;
    this.variants = variants;
    this.shift = 32 - gateBits;
    this.want = GATE_TAG >>> this.shift;
  }

  private zOf(nonce: bigint): bigint {
    const key = nonce.toString();
    const hit = this.zCache.get(key);
    if (hit !== undefined) return hit;
    const p = this.prob;
    let b: Bytes;
    if (p.kind === 'pin') {
      const [lt, seq] = pinFields(nonce);
      b = p.preimage.slice();
      b.set(u32le(seq), p.seq_off!);
      b.set(u32le(lt), p.lt_off!);
    } else {
      const pos = unrankSubset(nonce, p.n_slots!, p.t!);
      const parts: Bytes[] = [];
      let last = 0;
      for (const i of pos) {
        const o = p.slot_offs![i];
        parts.push(p.preimage.slice(last, o));
        last = o + p.slot_len!;
      }
      parts.push(p.preimage.slice(last));
      b = concat(...parts);
    }
    const z = toInt(hash256(b)) % N;
    if (this.zCache.size > 4096) this.zCache.clear();
    this.zCache.set(key, z);
    return z;
  }

  /** Check one hit line; returns the candidate, throws if it does not reproduce. */
  check(line: string): Candidate {
    let h: ReturnType<typeof parseHit>;
    try {
      h = parseHit(this.packet, line);
    } catch (e) {
      throw new HitMismatch(`GPU hit ${JSON.stringify(line.slice(0, 120))} does not parse: ${(e as Error).message}`);
    }
    const v = this.variants[h.variant];
    if (!v || h.menuIndex < 0 || h.menuIndex >= v.points.length)
      throw new HitMismatch(`GPU hit ${JSON.stringify(line)} names a menu entry the packet does not have`);
    const z = this.zOf(h.nonce);
    const d = digestFor(this.packet, this.variants, this.rinv, z, h.variant, h.menuIndex,
      h.encoding, h.ladder);
    if (d === null || (new DataView(d.buffer, d.byteOffset, 4).getUint32(0) >>> this.shift) !== this.want)
      throw new HitMismatch(`GPU hit ${JSON.stringify(line)} does not reproduce: the grinder and pqb disagree about this problem`);
    this.checked++;
    const der = derPrefixBytes(d);
    if (this.checked <= this.canonicalFirst || this.checked % this.canonicalEvery === 0 ||
      parseStrictDer(d) !== null) {
      const slow = evaluate(this.packet, h.nonce, h.variant, h.menuIndex, h.encoding, h.ladder);
      this.canonical++;
      if (slow.digest === null || !equal(slow.digest, d) || slow.z !== z)
        throw new Error(`the fast hit check and evaluate disagree on ${JSON.stringify(line)}: this is a pqb bug, not the grinder`);
    }
    const c: Candidate = { ...h, digest: d, derBytes: der };
    if (!mineableEncoding(h.encoding)) return c;
    if (parseStrictDer(d) !== null && solves(this.packet, d, z)) {
      this.full++;
      this.solutions.push(c);
      if (!this.bestFull) { this.best = c; this.bestFull = true; }
    } else if (!this.bestFull && (this.best === null || der > this.best.derBytes)) {
      this.best = c;
    }
    return c;
  }

  stats() {
    return {
      checked: this.checked, fullSolutions: this.full, canonicalRechecks: this.canonical,
      bestIsFull: this.bestFull, bestDerBytes: this.best?.derBytes ?? 0,
    };
  }
}

/** The result file `pqb grind verify` reads, for a solved stage. */
export function resultJson(p: Packet, c: Candidate, searched: bigint, gateBits = DEFAULT_GATE_BITS) {
  return {
    pqb_result: 2, stage: p.stage, kind: p.kind,
    packet_sha256: p.pqb_packet_sha256,
    searched: searched.toString(),
    solution: {
      nonce: c.nonce.toString(), variant: c.variant, menu_index: c.menuIndex,
      encoding: c.encoding, ladder: c.ladder, digest: hex(c.digest),
      der_prefix_bytes: c.derBytes,
    },
    gate_bits: gateBits,
  };
}

// ------------------------------------------------------------------------------ export
// Making the work packets, and turning solved stages back into a witness. Ports of
// grind.stages_from_lock, grind.packets_for_lock and grind.witness_plan.

export const PACKET_VERSION = 2;

export interface Stage {
  index: number; predicate: string; m: number; ladderLevels: number; sha1Chain: boolean;
  verifyForm: boolean; menuR: Packet['menu'] | null; menuPoints: { points: string[] }[];
  fixedSig: { r: string; s: string } | null; t: number | null; tableN: number;
  only33: boolean; nPoints: number; menuWidth: number; triesPerZ: number;
}

export function stagesFromLock(lock: Lock, menuPointBudget?: number): Stage[] {
  const d = lock.detail;
  const R = d.tl.length;
  const out: Stage[] = [];
  for (let i = 0; i <= R; i++) {
    const m = d.ml[i];
    const levels = d.hs[i][1];
    const menu: Menu | null = i === 0 ? d.menu : d.rmenu[i - 1];
    const only33 = m === 2 || m === 4;
    const nPoints = (m === 4 || m === 12) ? 4 : 2;
    let menuR: Packet['menu'] | null = null;
    let fixedSig: { r: string; s: string } | null = null;
    let menuPoints: { points: string[] }[] = [];
    if (menu) {
      const rinv = powmod(menu.r, N - 2n, N);
      const budget = menuPointBudget === undefined ? menu.s.length
        : Math.max(1, Math.min(menuPointBudget, menu.s.length));
      const variants = recoveryPoints(menu.r, nPoints).map((pt) => ({
        add_n: pt.add_n, odd: pt.odd,
        points: menu.s.slice(0, budget).map((s) => hex(pt.point.multiply((rinv * s) % N).toBytes(false))),
      }));
      menuPoints = variants;
      menuR = { r: menu.r.toString(), r_inv: rinv.toString(), variants,
        disclosed: budget, total: menu.s.length } as Packet['menu'];
    } else {
      const sig = i === 0 ? d.pinSig : d.sigNonce[i - 1];
      fixedSig = { r: sig.r.toString(), s: sig.s.toString() };
    }
    const width = menuPoints.length ? menuPoints[0].points.length : 1;
    out.push({
      index: i, predicate: d.preds[i], m, ladderLevels: levels, sha1Chain: false,
      verifyForm: !d.derOnly[i], menuR, menuPoints, fixedSig,
      t: i ? d.tl[i - 1] : null, tableN: d.comm.length, only33, nPoints, menuWidth: width,
      triesPerZ: nPoints * (only33 ? 1 : 3) * width * (1 << levels),
    });
  }
  return out;
}

/** Work packets for every stage that can be searched now (grind.packets_for_lock).
 *  A round stage needs the solved pinning nonce, and on a shared table also every earlier
 *  round's selection: until pinning lands, a round search is aimed at a sighash about to move. */
export function packetsForLock(lock: Lock, txHex: string, o: {
  nIn?: number; menuPointBudget?: number; pinNonce?: bigint | null;
  priorSelections?: number[][]; } = {}): Packet[] {
  const d = lock.detail;
  const nIn = o.nIn ?? 0;
  const prior = o.priorSelections ?? [];
  const out: Packet[] = [];
  for (const st of stagesFromLock(lock, o.menuPointBudget)) {
    if (st.index === 0) { out.push(packetForStage(lock, st, txHex, nIn, {})); continue; }
    const r = st.index - 1;
    if (o.pinNonce === undefined || o.pinNonce === null || prior.length < r) continue;
    const before = d.rmenu[r] ? [] : [hex(d.sigNonce[r].sig)];
    const table = d.dsig.map(hex);
    const used = [...new Set(prior.slice(0, r).flat())].sort((a, b) => a - b);
    const live = table.map((_x, j) => j).filter((j) => !used.includes(j));
    out.push(packetForStage(lock, st, txHex, nIn, {
      deletionsBefore: before, roundTable: table, liveSlots: live, usedSlots: used,
      pinNonce: o.pinNonce,
    }));
  }
  return out;
}

function packetForStage(lock: Lock, st: Stage, txHex: string, nIn: number, o: {
  deletionsBefore?: string[]; roundTable?: string[]; liveSlots?: number[]; usedSlots?: number[];
  pinNonce?: bigint;
}): Packet {
  const pinning = st.index === 0;
  const liveN = o.liveSlots?.length;
  const nTotal = pinning ? PIN_NONCE_SPACE : comb(liveN ?? st.tableN, st.t!);
  const tx = templateTx(txHex, pinning ? 0n : o.pinNonce!, nIn);
  // A caller may hand in an assembled spend, whose scriptSig IS the witness. Blanking it keeps
  // contains_no_secret true and does not move the sighash (preimageOf rewrites every scriptSig).
  tx.vin.forEach((v) => { v.scriptSig = new Uint8Array(0); });
  const raw: Record<string, unknown> = {
    pqb_packet: PACKET_VERSION, config: lock.config, script_sha256: lock.sha256,
    scriptpubkey: hex(lock.script), stage: st.index, kind: pinning ? 'pinning' : 'round',
    tx_template: hex(serializeTx(tx)), n_in: nIn, hashtype: 1,
    nonce_field: pinning ? 'nSequence+nLockTime' : 'subset_rank',
    nonce_start: 0, nonce_count: nTotal.toString(), nonce_space: nTotal.toString(),
    predicate: st.predicate.replace('_der', ''), verify_form: st.verifyForm,
    ladder_levels: st.ladderLevels, sha1_chain: st.sha1Chain, only_33_byte_keys: st.only33,
    recovery_points_wanted: st.nPoints, tries_per_nonce: st.triesPerZ,
    single_class_filter: true, menu: st.menuR, fixed_sig: st.fixedSig,
    table_n: liveN ?? st.tableN, t: st.t,
    deletions_before: o.deletionsBefore ?? [], round_table: o.roundTable ?? null,
    live_slots: o.liveSlots ?? null, used_slots: o.usedSlots ?? null,
    pin_nonce: pinning ? null : o.pinNonce!.toString(),
    contains_no_secret: true,
  };
  return raw as unknown as Packet;
}

export interface SolvedStage {
  stage: number; nonce: bigint; variant: number; menuIndex: number; encoding: number;
  ladder: number; digest: Bytes;
}

export interface WitnessPlan {
  pinNonce: bigint | null; selection: number[][];
  menuPick: Record<string, number>; hashPick: Record<string, number>;
  puzzleKeys: Record<string, Bytes>; complete: boolean; stages: number;
}

/** Everything the solved stages fix about the witness (grind.witness_plan), re-derived here
 *  from the packets rather than taken from a box's word. */
export function witnessPlan(lock: Lock, packets: Map<number, Packet>,
  solved: Map<number, SolvedStage>, o: { requireFull?: boolean } = {}): WitnessPlan {
  // `requireFull: false` accepts partial solves: for rehearsal scripts only, NEVER a spend (a
  // partial digest is not a signature, so the real script refuses it).
  const requireFull = o.requireFull !== false;
  const R = lock.detail.tl.length;
  const plan: WitnessPlan = { pinNonce: null, selection: [], menuPick: {}, hashPick: {},
    puzzleKeys: {}, complete: false, stages: 0 };
  for (let stage = 0; stage <= R; stage++) {
    const s = solved.get(stage);
    const p = packets.get(stage);
    if (!s || !p) break;
    const { digest, z } = evaluate(p, s.nonce, s.variant, s.menuIndex, s.encoding, s.ladder);
    if (!digest || !equal(digest, s.digest))
      throw new Error(`stage ${stage}'s solution does not reproduce from its packet`);
    if (requireFull && !solves(p, digest, z))
      throw new Error(`stage ${stage}'s digest does not solve it`);
    if (stage === 0) {
      plan.pinNonce = s.nonce;
    } else {
      const pin = p.pin_nonce === undefined || p.pin_nonce === null ? null : big(p.pin_nonce);
      if (pin !== plan.pinNonce)
        throw new Error(`stage ${stage} was ground against a different pinning nonce: re-export it`);
      plan.selection.push(roundSelection(p, s.nonce));
    }
    const tag = stage === 0 ? 'pin' : `r${stage - 1}`;
    plan.menuPick[stage === 0 ? 'pin' : String(stage - 1)] = s.menuIndex;
    plan.hashPick[tag] = s.ladder;
    // the puzzle key in the encoding the grinder solved: another encoding hashes differently
    const { rinv, variants } = pointsFromPacket(p);
    const A = variants[s.variant].points[s.menuIndex];
    const neg = (N - (rinv * z) % N) % N;
    const key = neg === 0n ? A : A.add(Point.BASE.multiply(neg));
    plan.puzzleKeys[stage === 0 ? 'knpin' : `kn${stage - 1}`] =
      encodings(key, p.only_33_byte_keys)[s.encoding];
    const rs = parseStrictDer(digest);
    if (p.verify_form && rs) {
      const q = recoverPubkey(rs[0], rs[1], z, 0) ?? recoverPubkey(rs[0], rs[1], z, 1);
      if (!q) throw new Error(`stage ${stage}: no key recovers from the solved digest`);
      plan.puzzleKeys[stage === 0 ? 'Xpin' : `X${stage - 1}`] = q.toBytes(true);
    } else if (p.verify_form && requireFull) {
      throw new Error(`stage ${stage}: the digest is not a DER signature`);
    }
    plan.stages++;
  }
  plan.complete = plan.stages === R + 1;
  return plan;
}
