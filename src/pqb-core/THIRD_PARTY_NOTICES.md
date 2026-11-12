# Third-party notices

This repository is MIT-licensed (see [LICENSE](LICENSE)). It also contains, or is built from, the
third-party material below. Every item is under a licence compatible with MIT redistribution.

## Vendored in this repository

| path | what | origin | licence |
|---|---|---|---|
| `pqb/src/pqb/_research/_vendor/test_framework/` | Bitcoin Core's Python functional-test framework (legacy sighash, script, messages, key, ripemd160, secp256k1, siphash, descriptors), copied byte-for-byte; see its `LICENSE-NOTE.md` | [bitcoin/bitcoin](https://github.com/bitcoin/bitcoin), `test/functional/test_framework/` at `4519933391` | MIT (Bitcoin Core developers; individual files also credit Pieter Wuille, Jeff Garzik, and ArtForz, whose half-a-node code is public domain) |
| `explorer/test/core/script_tests.json`, `explorer/test/core/sighash.json` | Bitcoin Core's script and sighash test vectors | [bitcoin/bitcoin](https://github.com/bitcoin/bitcoin), `src/test/data/` | MIT (Bitcoin Core developers) |
| `pqb/src/pqb/data/bip39-english.txt`, `js/src/bip39-english.json` | the BIP-39 English wordlist | [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt) (bitcoin/bips) | redistributed as in [trezor/python-mnemonic](https://github.com/trezor/python-mnemonic) (MIT) |
| `pqb/tests/data/bip39_vectors.json` | BIP-39 test vectors (English, passphrase `TREZOR`) | [trezor/python-mnemonic](https://github.com/trezor/python-mnemonic/blob/master/vectors.json) | MIT (Trezor / SatoshiLabs) |
| `pqb/tests/data/electrum_seed_vectors.json` | Electrum seed test vectors, generated with Electrum 4.8.2; they never held value | [spesmilo/electrum](https://github.com/spesmilo/electrum) | MIT (Electrum developers) |
| `explorer/src/app/fx/*.wgsl.gen.ts` | generated shader modules: the project's own WGSL with noise and hash helpers from `@vgpu/wgsl-std` 0.5.0 inlined by `resolveShader()` | [vgpu](https://vgpu.sh) (Matias Gonzalez) | MIT |
| `explorer/test/fixtures/*`, `explorer/index/*.json` | raw Bitcoin transactions and blocks, and an index of them | public blockchain data | not copyrightable data; no licence needed |

Small algorithms reimplemented from public descriptions rather than copied: Electrum's
`push_script` (`pqb/src/pqb/electrum_script.py`; Electrum is MIT, and its function was
itself ported from btcd, ISC); the Bernstein-Yang "safegcd" modular inverse that libsecp256k1 (MIT)
also uses, in `grinder/`; and Inigo Quilez's `sdHexagon` distance function, credited in the
explorer's backdrop shader.

### Bitcoin Core licence (for the vendored test framework and test vectors)

```
The MIT License (MIT)

Copyright (c) 2009-2026 The Bitcoin Core developers
Copyright (c) 2009-2026 Bitcoin Developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Fetched at build time (not in this repository)

Exact versions are pinned in each `package.json` / `package-lock.json` and in
`pqb/pyproject.toml`.

| component | used by | licence |
|---|---|---|
| `coincurve` 21.0.0 (libsecp256k1 binding) | pqb runtime | MIT / Apache-2.0 (dual); libsecp256k1 is MIT |
| `@noble/curves`, `@noble/hashes`, `@scure/base` | js runtime | MIT |
| `vgpu` 0.5.0 and `@vgpu/*` | explorer: its browser graph is vendored into `dist/` at build | MIT |
| `typescript`, `esbuild`, `@types/node`, `wrangler` and their trees | build and test tooling only, never shipped | Apache-2.0, MIT, ISC and others. `wrangler` pulls `sharp`'s prebuilt libvips (LGPL-3.0-or-later) which is not redistributed |
| fonts embedded in `whitepaper/PQB.pdf`: XCharter, Source Sans Pro, Source Code Pro | the PDF | XCharter: Bitstream Charter licence (free redistribution); Source Sans / Source Code: SIL Open Font License 1.1 |
| Docker images used by tests and scripts: `bitcoin/bitcoin`, `cculianu/fulcrum`, `nvidia/cuda` | regtest node, Electrum server, GPU boxes | MIT (Bitcoin Core), GPL-3.0 (Fulcrum, run as a separate program, not linked), NVIDIA Deep Learning Container licence (pulled by the GPU host, not redistributed) |

Run `npm ls --all` in `js/` or `explorer/` (after `npm ci`) for the full dependency trees.
