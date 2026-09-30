# Key custody

Who holds each key, passphrase and credential through vault creation, deposit and withdrawal, and what the service receives. This page is the text version of the [diagram](key-custody.png); its source is [`key-custody.html`](key-custody.html).

**Spending takes all three: the backup file, its passphrase and the wallet. Only the user holds them. The service holds no key that can move funds.** Everything secret stays on the user's machine. The service only receives public data and signed transactions.

![Key custody diagram: the same stages, holders and tables as the text on this page.](key-custody.png)

## Holders

- **Bitcoin wallet**: Xverse in the web app, or any BIP-322 and PSBT signer through the SDK (hardware wallet, Sparrow, HSM). Holds the wallet private key.
- **User's browser, or the SDK / CLI**: runs the local QSB worker (Pyodide) from pinned, hash-checked sources. Holds the HORS one-time secrets (in memory only while the vault is unlocked), the passphrase and the backup files.
- **QSB service on AWS**: API Lambda, records table, Step Functions coordinator and CPU verifier. Holds vault and job records, session and API key hashes and webhook secrets, and reads the MARA credential. Holds no spending key.
- **Outside parties**: GPU solver, MARA Slipstream, Bitcoin. They see no secrets.

## 1. Create vault

| Holder | What happens |
| --- | --- |
| Wallet | Signs the sign-in challenge (BIP-322). The same address later funds the deposit and provides the withdrawal's helper input. |
| Wallet ↔ browser | The challenge goes to the wallet; the signature comes back. |
| Browser | Generates 2 × 150 one-time HORS secrets and their hash commitments, then builds the vault script. Encrypts them with the passphrase (14+ characters; PBKDF2-SHA256 with 600,000 rounds, then AES-256-GCM). The user downloads the backup, `qsb-recovery-<id>.json`, and re-opens it to prove it works. Then the app shuts the worker down and drops the secrets. |
| Crosses to the service | The public vault: script, script hash, HORS commitments and payment address. The service returns a session token that lasts 1 hour. |
| Service | Verifies the BIP-322 signature and issues a random session token, storing only its SHA-256. Stores the public vault record. It never receives a private key or a HORS secret. |
| Outside parties | Nothing leaves the service. |

## 2. Deposit

| Holder | What happens |
| --- | --- |
| Wallet | Signs the deposit PSBT. Broadcast is off: the app submits the signed bytes itself. |
| Wallet ↔ browser | The deposit PSBT goes to the wallet; the signed PSBT comes back. |
| Browser | Unlocks the backup locally to check it still opens; nothing secret is sent. Builds a deposit paying the vault script. Each vault takes exactly one deposit. |
| Crosses to the service | The signed deposit transaction. |
| Service | Checks the transaction pays the vault script, records the exact bytes and submits them to MARA. Reads the optional MARA credential from Secrets Manager; only the API roles can. |
| Outside parties | MARA Slipstream relays the raw transaction to Bitcoin, and the deposit confirms to the vault script. |

## 3. Withdraw: search

| Holder | What happens |
| --- | --- |
| Wallet | Supplies a small helper UTXO for the withdrawal. It's a public outpoint; nothing is signed yet. |
| Wallet ↔ browser | The helper UTXO (public) comes back from the wallet. |
| Browser | Unlocks the backup; the user chooses the destination, amount and fee. Saves a `-withdrawal` backup that binds this one-time intent, so the keys can't be used for a different withdrawal. |
| Crosses to the service | The withdrawal manifest: destination, amount, fee, and the funding and helper outpoints. The service later returns the solution: sequence, locktime and the selected indices. |
| Service | Reserves both outpoints atomically, then the coordinator runs the search. The CPU verifier re-checks every GPU hit before a solution is stored. |
| Outside parties | The GPU solver on AWS Batch (attested qsb-solver image, pinned by digest) receives public search parameters and returns candidate hits. It isn't trusted: every hit is re-checked on CPU. |

## 4. Withdraw: sign and submit

| Holder | What happens |
| --- | --- |
| Wallet | Signs helper input 0 with SIGHASH_ALL, which fixes the destination, amount and fee. |
| Wallet ↔ browser | The withdrawal PSBT goes to the wallet; the helper signature comes back. |
| Browser | Unlocks the backup and assembles the transaction locally, revealing only the 15 of 300 secrets the solution selects (vault input 1). Saves a `-signing` backup that binds this exact transaction. Locks again. The revealed secrets are single-use, so this vault is finished. |
| Crosses to the service | The signed withdrawal transaction. |
| Service | Checks the exact spend (inputs, single output, amount, fee) and runs Bitcoin Core's consensus check on the signed bytes. Records one submission intent, then POSTs to MARA exactly once. An unknown outcome goes to an operator and is never resent. |
| Outside parties | MARA Slipstream relays the raw transaction to Bitcoin, and the funds go to the destination the wallet signed. |

## Secrets and credentials

| Item | Created by | Held by | What the service stores |
| --- | --- | --- | --- |
| Wallet private key | User's wallet | The wallet only | Nothing; the public key and address only |
| HORS one-time secrets, 2 rounds × 150 | Browser QSB worker | Browser memory while unlocked; encrypted backups at rest | Hash commitments only. The 15 revealed at withdrawal become public, by design |
| Recovery passphrase | User | User | Nothing |
| Backup files: vault, `-withdrawal`, `-signing` | Browser | User's own storage | Nothing |
| Session token (1 hour) / API key (scoped, up to 90 days) | API, after a BIP-322 sign-in | Browser, or the SDK caller | SHA-256 hash only |
| Webhook signing secret | API, shown once to the owner | Owner's webhook receiver | The secret, to sign deliveries (HMAC-SHA256) |
| MARA Slipstream credential (optional) | Administrator | AWS Secrets Manager | Read at runtime by API roles; sent only to MARA |

## Who can do what

- **User**: the only party that can spend, with the backup file, passphrase and wallet together.
- **QSB service**: can refuse or delay a withdrawal, but not redirect it: the destination is fixed by signatures made on the user's machine.
- **GPU solver**: untrusted compute on public data. A wrong hit is caught by the CPU re-check.
- **Operator**: an MFA-backed role that reconciles records after an unknown outcome. It can't sign, and the tool never resubmits.
- **MARA**: receives fully signed transactions only.

**Trust note.** The web app is served from the deployment, so whoever can deploy controls the code that runs in the browser and can read the MARA credential. The SDK and CLI run code the user installs.

## Sources

Written against `main` at `e150b56` (30 September 2026): `src/lib/backup.ts`, `public/qsb/bridge.py`, `public/qsb/qsb_pipeline.py`, `src/lib/wallet.ts`, `src/mainnet/localSignature.ts`, `server/app.ts`, `server/scoped-keys.ts`, `server/webhooks.ts`, `terraform/variables.tf` and [EXACT-SUBMIT.md](EXACT-SUBMIT.md). Keep this page, `key-custody.html` and `key-custody.png` in step; see "Docs" in `AGENTS.md`.
