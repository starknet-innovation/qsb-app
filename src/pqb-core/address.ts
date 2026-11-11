// Addresses and script hashes. bech32 / bech32m (BIP173/350) and base58check via @scure/base.
import { base58check, bech32, bech32m } from '@scure/base';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { Bytes, concat, hash160, hex, sha256 } from './primitives.js';

/**
 * The chains a vault can be funded and then spent on. A spend is refused by every mempool on
 * every chain, so it has to be handed to a miner, and MARA's Slipstream is the only public route:
 * mainnet and testnet4. Signet and testnet3 are not offered because a lock made there could not
 * then be opened.
 */
export type Network = 'main' | 'testnet4' | 'regtest';
export const HRP: Record<Network, string> = { main: 'bc', testnet4: 'tb', regtest: 'bcrt' };
const P2PKH: Record<Network, number> = { main: 0x00, testnet4: 0x6f, regtest: 0x6f };
const P2SH: Record<Network, number> = { main: 0x05, testnet4: 0xc4, regtest: 0xc4 };
const b58 = base58check(nobleSha256);

export function p2wpkh(pubkey33: Bytes, network: Network): { address: string; scriptPubKey: Bytes } {
  if (pubkey33.length !== 33) throw new Error('P2WPKH needs a compressed public key');
  const h = hash160(pubkey33);
  return { address: segwitAddress(0, h, network), scriptPubKey: concat([0x00, 0x14], h) };
}

export function segwitAddress(version: number, program: Bytes, network: Network): string {
  const words = [version, ...bech32.toWords(program)];
  return (version === 0 ? bech32 : bech32m).encode(HRP[network], words);
}

/** The scriptPubKey an address pays: strict (checksum, network, witness version/length). */
export function toScript(address: string, network: Network): Bytes {
  const a = address.trim();
  const hrp = HRP[network];
  if (!hrp) throw new Error(`unknown network ${network}`);
  if (a.toLowerCase().startsWith(hrp + '1')) {
    let dec: { prefix: string; words: number[] };
    let isM = false;
    try { dec = bech32.decode(a as `${string}1${string}`); } catch {
      dec = bech32m.decode(a as `${string}1${string}`); isM = true;
    }
    if (dec.prefix.toLowerCase() !== hrp) throw new Error(`address is for another network (${dec.prefix})`);
    if (!dec.words.length) throw new Error('empty witness program');
    const ver = dec.words[0];
    const prog = bech32.fromWords(dec.words.slice(1));
    if ((ver === 0) === isM) throw new Error('wrong bech32 variant for the witness version');
    if (ver === 0 && prog.length !== 20 && prog.length !== 32) throw new Error('bad v0 program');
    if (ver > 16 || prog.length < 2 || prog.length > 40) throw new Error('bad witness program');
    return concat([ver === 0 ? 0 : 0x50 + ver, prog.length], prog);
  }
  if (network !== 'main' && a.toLowerCase().startsWith('bc1'))
    throw new Error(`that is a mainnet address; this vault is on ${network}`);
  const raw = b58.decode(a);
  if (raw.length !== 21) throw new Error('not an address');
  if (raw[0] === P2PKH[network]) return concat([0x76, 0xa9, 0x14], raw.slice(1), [0x88, 0xac]);
  if (raw[0] === P2SH[network]) return concat([0xa9, 0x14], raw.slice(1), [0x87]);
  throw new Error('address is for another network');
}

/** Electrum protocol: sha256(scriptPubKey), byte-reversed, hex. */
export function electrumScripthash(spk: Bytes): string {
  return hex(sha256(spk).reverse());
}

/** Esplora / mempool.space: sha256(scriptPubKey), NOT reversed. */
export function esploraScripthash(spk: Bytes): string {
  return hex(sha256(spk));
}
