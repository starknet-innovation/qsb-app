// Bytes, hashes and secp256k1 for @pqb/core. The cryptography is @noble's; nothing here
// reimplements it.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 as _ripemd160, sha1 as _sha1 } from '@noble/hashes/legacy.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 as _sha256, sha512 } from '@noble/hashes/sha2.js';

export type Bytes = Uint8Array;

export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const P = 2n ** 256n - 2n ** 32n - 977n;

// ------------------------------------------------------------------------------------ bytes
export function concat(...parts: (Bytes | number[])[]): Bytes {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex(b: Bytes): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Bytes {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Big-endian integer of a byte string. */
export function toInt(b: Bytes): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** `v` as exactly `len` big-endian bytes. */
export function fromInt(v: bigint, len: number): Bytes {
  if (v < 0n) throw new Error('negative');
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('integer does not fit');
  return out;
}

/** The minimal big-endian encoding (Python's v.to_bytes((v.bit_length() + 7) // 8, 'big')). */
export function minimalBE(v: bigint): Bytes {
  if (v === 0n) return new Uint8Array(0);
  return fromInt(v, Math.ceil(v.toString(16).length / 2));
}

export function u32le(v: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

export function u64le(v: bigint): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

export function varint(n: number): Bytes {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concat([0xfe], u32le(n));
}

// ----------------------------------------------------------------------------------- hashes
export const sha256 = (b: Bytes): Bytes => _sha256(b);
export const sha1 = (b: Bytes): Bytes => _sha1(b);
export const ripemd160 = (b: Bytes): Bytes => _ripemd160(b);
export const hash160 = (b: Bytes): Bytes => _ripemd160(_sha256(b));
export const hash256 = (b: Bytes): Bytes => _sha256(_sha256(b));
export const hmacSha512 = (key: Bytes, msg: Bytes): Bytes => hmac(sha512, key, msg);
export const hmacSha256 = (key: Bytes, msg: Bytes): Bytes => hmac(_sha256, key, msg);
export const pbkdf2Sha512 = (pw: Bytes, salt: Bytes, c: number): Bytes =>
  pbkdf2(sha512, pw, salt, { c, dkLen: 64 });

// -------------------------------------------------------------------------------- secp256k1
export const Point = secp256k1.Point;
export type PointT = InstanceType<typeof secp256k1.Point>;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

export function powmod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** The curve point with x-coordinate `x` and the given y parity, or null (Python's lift_x). */
export function liftX(x: bigint, odd = false): PointT | null {
  if (!(x > 0n && x < P)) return null;
  const y2 = mod(x * x * x + 7n, P);
  let y = powmod(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null;
  if ((y % 2n === 1n) !== odd) y = P - y;
  return Point.fromAffine({ x, y });
}

export function pubkeyOf(secret: bigint, compressed = true): Bytes {
  return Point.BASE.multiply(secret).toBytes(compressed);
}

/** RFC 6979 ECDSA, low-S, DER: what Bitcoin Core (and pqb's Python) produce. */
export function signDer(msg32: Bytes, secret: bigint): Bytes {
  return secp256k1.sign(msg32, fromInt(secret, 32), { prehash: false, format: 'der', lowS: true });
}
