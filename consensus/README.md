# Offline Core script verification

The live submit path calls `CoreConsensus.verify` after the exact-spend check
and before creating the transaction intent. It independently reads the actual
previous transactions and confirms their outputs are unspent. It passes **all
ordered spent outputs**, with amounts and scripts, and the exact signed bytes to
a short-lived native child. The child has no provider credentials, no RPC and no
broadcast operation. Missing executable/library, timeout, nonzero exit, malformed
output or any invalid input fails closed.

## Interpreter and rules

Bitcoin Core **27.2** is used because the official release still ships
`libbitcoinconsensus`, API version 2. Core 27 deprecated the library and Core 28
removed it. It is not sufficient to call `verify_script_with_amount`: Taproot
needs `bitcoinconsensus_verify_script_with_spent_outputs`, including every
input's previous output. This adapter uses that function for each of the two QSB
inputs and requires both success and `ERR_OK`.

`VERIFY_ALL` in that header comprises P2SH, DERSIG, NULLDUMMY,
CHECKLOCKTIMEVERIFY, CHECKSEQUENCEVERIFY, WITNESS and TAPROOT. These are the
activated mainnet script rules (BIP16/66/65/112/141/147/341/342), not standardness
flags. No policy flags such as minimal pushes, low-S, or discouraging NOPs are
added. Unsupported future witness versions are rejected by the adapter. This
release must be reassessed if mainnet activates another script soft fork; the
library does not discover activation rules from a chain tip.

This checks **input scripts**, not standalone block validity, relay policy,
confirmation or mining. Exact layout, input/output amounts and fee come from the
preceding exact-spend check; confirmed unspent prevouts come from the chain
reader. The adapter also rejects individual or total values outside MoneyRange,
overspending, and coinbase prevouts with fewer than 100 confirmations. A
successful check does not authorize broadcast by itself. Miner policy
and later inclusion remain separate.

Primary sources:
- [27.2 API header](https://github.com/bitcoin/bitcoin/blob/v27.2/src/script/bitcoinconsensus.h)
- [27.2 implementation and spent-output handling](https://github.com/bitcoin/bitcoin/blob/v27.2/src/script/bitcoinconsensus.cpp)
- [Core 28 removal release note](https://bitcoincore.org/en/releases/28.0/)
- [Core 30 mainnet script flags](https://github.com/bitcoin/bitcoin/blob/v30.0/src/validation.cpp)
- [Official 27.2 checksums](https://bitcoincore.org/bin/bitcoin-core-27.2/SHA256SUMS)

## Build and test

`node consensus/build.mjs OUTPUT_DIRECTORY` uses a Linux/arm64 Amazon Linux 2023
container, checks the official upstream archive SHA256 and compiles the small
wrapper. It copies only the executable and consensus library. The executable
uses an origin-relative runtime library path. `terraform/scripts/build.mjs`
packages them in the API Lambda zip; no external runtime installation is needed.
The build needs Docker and access to the official release and package mirrors.
Generated native files are build artifacts, not committed source.

`QSB_TEST_CONSENSUS_BINARY=/absolute/path/qsb-consensus npm test -- tests/consensus.test.ts`
runs real signed synthetic SegWit, Taproot, and mixed SegWit/legacy-P2SH
two-input transactions against the
interpreter, accepting the original and rejecting destination, amount/fee,
extra-output and signature mutations. These have nonexistent funding and are
never broadcast. Without that environment variable the native cases are
explicitly skipped, rather than replaced by a mock. Ordinary tests cover missing
runtime and failed chain lookup. These are local component checks, not fresh QSB
withdrawal or miner inclusion evidence.

For the packaged Linux build, run
`node consensus/test-linux.mjs terraform/.build/api/native`. This runs the same
real signed mutation suite through network-disabled, read-only Linux containers
using the exact packaged executable/library. The 2026-09-25 local Linux/arm64
Amazon Linux 2023 run passed seven tests: four originals accepted, fifteen transaction mutations
and eight spent-output mutations rejected; missing executable and chain failure
also rejected. Additional contextual tests prove rejection before native launch
for output/input MoneyRange overflow, overspending and 99-confirmation coinbase
prevouts; the 100-confirmation boundary reaches an explicitly fake interpreter.
One Taproot test uses an unsigned OP_TRUE second input, showing
that changing only the other input amount or script breaks input zero's signature.
Legacy signatures do not commit other-input amounts: chain/exact-spend binding
is essential and cannot be replaced by the interpreter. This does not need
a Bitcoin node, a funded output or private wallet material.
