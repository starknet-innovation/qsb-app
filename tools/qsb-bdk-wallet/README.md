# Encrypted local BDK signer

macOS-only, dedicated native P2WPKH wallet built with pinned `bdk_wallet` 3.2.0.
No Bitcoin Core installation, local node, remote wallet, or broadcast command.
This is a small experimental signer for the explicitly approved QSB mainnet test,
not a general wallet. Do not use it for savings.

```
cargo build --release --locked --manifest-path tools/qsb-bdk-wallet/Cargo.toml
tools/qsb-bdk-wallet/target/release/qsb-bdk-wallet init /absolute/private/wallet
tools/qsb-bdk-wallet/target/release/qsb-bdk-wallet verify-backup /absolute/private/wallet
tools/qsb-bdk-wallet/target/release/qsb-bdk-wallet backup /absolute/private/wallet
node tools/qsb-bdk-wallet/remote.mjs /absolute/private/wallet
```

`init` refuses an existing directory, generates a fresh random 256-bit seed,
encrypts it using age scrypt with a random 256-bit credential stored in macOS
Keychain (`org.starknet.qsb.bdk-wallet.v1`, account = payment address), and writes
private, exclusive files. It reopens the encrypted backup and checks the identity.
The output contains only the public address, compressed public key and derivation.
The same fixed BIP84 receive address is used for QSB authentication and funding;
this intentionally sacrifices address privacy for the app's single-wallet flow.

Before funding, create a portable backup. The 1Password path generates and saves
a 48-character password in the chosen vault, reads it back through `op`, pipes it
directly to Rust over stdin, writes `recovery.age` and verifies decryption and seed
identity. Only item IDs and completion status are printed. No wallet seed or
backup is uploaded to 1Password; it holds the recovery passphrase only.

```
python3 tools/qsb-bdk-wallet/onepassword-backup.py /absolute/path/to/qsb-bdk-wallet /absolute/private/wallet YOUR_VAULT_ID
```

The script reconciles an existing exact-title item rather than generating a new
password after interruption. It refuses to replace an existing recovery file.
Python subprocess buffers are not guaranteed to be erased from memory. Keep the
Mac and 1Password account protected while the wallet is unlocked.
Alternatively `backup` asks for a passphrase through two local hidden-password
dialogs; `backup-stdin` accepts one directly over a private pipe, never argv/env.
Copy `recovery.age` to durable offline storage. The `seed.backup.age` copy still
needs the Keychain credential; the portable `recovery.age` does not. Losing all
copies or necessary credentials loses the wallet. The Keychain stores the actual
printable age passphrase for the normal seed files, not raw binary randomness.
Never fund the deterministic public address emitted by Rust tests.

`sign-message` reads the exact UTF-8 challenge bytes from stdin (no automatic
newline removal) and returns a base64 BIP-322 witness, matching the service's
`bip322-js` verifier. Use the SDK's origin-bound session challenge checks.
It constructs the zero-value virtual transactions locally; no chain call is made.

`sign-deposit` reads JSON from stdin containing `psbt`, `approvedUnsignedTxid`
and `approvedFeeSats`, plus explicit `inputs` indices. It requires selected inputs to spend this wallet's index-zero
native P2WPKH output, full previous transactions for all inputs, matching witness UTXOs and
SIGHASH_ALL. It verifies the transaction identity and exact fee before signing.
Only use it after independently reviewing all inputs/outputs and obtaining the
user's exact approval. This is a signing gate, not evidence of human approval.
It returns partial signatures only for the selected inputs, leaving foreign inputs
unchanged, including the PQB vault input. The SDK finalizes and performs its
independent exact-spend checks. `sdk/bdk-signer.ts` supplies a Node adapter with
a mandatory exact-transaction approval callback. No command submits signed bytes.

`remote.mjs` performs HTTPS GET requests only against a remote Esplora-backed
Bitcoin node/indexer (default `https://mempool.space/api`). It checks mainnet's
genesis hash before querying the address's UTXOs, chain tip and fee estimates.
TLS verification stays enabled. The backend learns the queried address and can
misreport chain data; use the QSB chain checks and independently inspect the actual
funding transaction. No seed, credential or signing material is sent to it.
No local peer-to-peer node is started. An alternative compatible HTTPS endpoint
can be passed as the second argument.

Validation:

```
cargo test --locked --manifest-path tools/qsb-bdk-wallet/Cargo.toml
QSB_NETWORK=mainnet npx vitest run tests/bdk-wallet.test.ts
```

The integration test checks Rust BIP-322 output against the same strict verifier
used by the authentication endpoint, with message, address and signature negatives.
These public fixtures and local checks are not a funded end-to-end test.
Secret buffers are cleared where controlled, but BDK/rust-bitcoin may make copies;
encrypted storage does not protect an unlocked process or compromised local user.
