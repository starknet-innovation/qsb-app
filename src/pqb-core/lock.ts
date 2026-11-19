// A vault's locking script: construction version + 32-byte seed -> script bytes, real puzzles
// always. Versions mirror pqb.versions: configs.json is generated from it (tools/js_vectors.py).
import configs from './configs.json' with { type: 'json' };
import { build, L1Params, L1Result } from './l1gen.js';
import { Bytes, hex, sha256 } from './primitives.js';
import { electrumScripthash, esploraScripthash } from './address.js';

export type ConfigTag = typeof configs.tag;
export const DEFAULT_CONFIG: ConfigTag = configs.tag;
/** A construction version id: 'v1', 'v2', ... (pqb.versions). */
export type VersionId = keyof typeof configs.versions;
/** Every construction version @pqb/core builds, oldest first. */
export const VERSIONS = Object.keys(configs.versions) as VersionId[];
/** The version new locks get unless one is asked for. */
export const LATEST_VERSION = configs.latest as VersionId;
/** @deprecated the scheme tag list; use VERSIONS for what can be built. */
export const SUPPORTED: ConfigTag[] = [configs.tag];

/** The generator parameters of `version` (throws on an unknown one). */
export function versionParams(version: string): L1Params {
  const v = (configs.versions as Record<string, { params: unknown }>)[version];
  if (!v) throw new Error(`construction version ${version} is not available in @pqb/core (versions: ${VERSIONS.join(', ')})`);
  return v.params as L1Params;
}

/** How people see a version: 'PQB'. */
export function versionLabel(version: string): string {
  versionParams(version);
  return (configs.versions as Record<string, { label: string }>)[version].label;
}

export interface Lock {
  config: ConfigTag;
  /** The construction version it was built with: record it, and rebuild with it. */
  version: VersionId;
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
 *  `opts.version` picks the construction version (default: the latest); a lock that already
 *  exists must be rebuilt with the version it was made with.
 *  `seed === null` uses the frozen research seed, whose secrets are public: for checking only,
 *  never for funding. */
export function buildLock(config: ConfigTag, seed: Bytes | null,
  opts: { allowPublicSeed?: boolean; version?: string } = {}): Lock {
  if (config !== configs.tag) throw new Error(`configuration ${config} is not available in @pqb/core (it ships ${configs.tag})`);
  const version = (opts.version ?? LATEST_VERSION) as VersionId;
  const kw = versionParams(version);
  if (seed === null && !opts.allowPublicSeed)
    throw new Error('a null seed builds the published artefact, whose preimages are public');
  if (seed !== null && seed.length !== 32) throw new Error('a vault seed is 32 bytes');
  const detail = build({ ...kw, seed, real_puzzles: true });
  const script = detail.script;
  return {
    config, version, realPuzzles: true, script, sha256: hex(sha256(script)),
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
