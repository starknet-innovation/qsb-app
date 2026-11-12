// A vault's locking script: configuration + 32-byte seed -> script bytes, real puzzles always.
import configs from './configs.json' with { type: 'json' };
import { build, L1Params, L1Result } from './l1gen.js';
import { Bytes, hex, sha256 } from './primitives.js';
import { electrumScripthash, esploraScripthash } from './address.js';

export const SUPPORTED = Object.keys(configs) as ConfigTag[];
export type ConfigTag = keyof typeof configs;
export const DEFAULT_CONFIG: ConfigTag = 'PQB';

export interface Lock {
  config: ConfigTag;
  realPuzzles: boolean;
  script: Bytes;
  sha256: string;
  /** The raw() output descriptor (BIP385): any wallet or node can watch the vault with it. */
  descriptor: string;
  electrumScripthash: string;
  esploraScripthash: string;
  /** Everything the generator produced: secrets included. Never log or serialise this. */
  detail: L1Result;
}

/** Build a lock, with the real anti-replay puzzles: spending it needs the 2^46 grind.
 *  `seed === null` uses the frozen research seed, whose secrets are public: for checking only,
 *  never for funding. */
export function buildLock(config: ConfigTag, seed: Bytes | null,
  opts: { allowPublicSeed?: boolean } = {}): Lock {
  const kw = (configs as Record<string, unknown>)[config] as L1Params | undefined;
  if (!kw) throw new Error(`configuration ${config} is not available in @pqb/core (supported: ${SUPPORTED.join(', ')})`);
  if (seed === null && !opts.allowPublicSeed)
    throw new Error('a null seed builds the published artefact, whose preimages are public');
  if (seed !== null && seed.length !== 32) throw new Error('a vault seed is 32 bytes');
  const detail = build({ ...kw, seed, real_puzzles: true });
  const script = detail.script;
  return {
    config, realPuzzles: true, script, sha256: hex(sha256(script)),
    descriptor: descriptor(script), electrumScripthash: electrumScripthash(script),
    esploraScripthash: esploraScripthash(script), detail,
  };
}

/** BIP380 descriptor checksum, as Bitcoin Core computes it. */
export function descriptorChecksum(desc: string): string {
  const INPUT = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
  const polymod = (c: bigint, v: number): bigint => {
    const c0 = c >> 35n;
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
    return c;
  };
  let c = 1n; let cls = 0; let clscount = 0;
  for (const ch of desc) {
    const pos = INPUT.indexOf(ch);
    if (pos < 0) throw new Error('invalid descriptor character');
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) { c = polymod(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

export function descriptor(script: Bytes): string {
  const d = `raw(${hex(script)})`;
  return `${d}#${descriptorChecksum(d)}`;
}
