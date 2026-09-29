# QSB TypeScript SDK and `qsb` CLI

**Research snapshot, not a production release. Mainnet operations are disabled by default**, and nothing here changes that: the server's switches decide whether deposits, withdrawals and submissions are accepted. Do not use this to hold real funds.

A non-custodial client for the existing `/api` routes in [`server/app.ts`](../server/app.ts). It does in Node what the webapp does in the browser, with the same code: QSB state generation and assembly run the same pinned Python in Pyodide ([`src/lib/qsb-runtime.ts`](../src/lib/qsb-runtime.ts)), and backups, PSBTs and checks come from `src/lib` and `src/mainnet`. It stays in this repository; it is not published to npm.

## Security model

Never leaves your machine, and is never in a request body, URL or header:

- the recovery state (`stateJson`: the one-time HORS secrets and the signature nonces). The unrevealed HORS secrets never leave your machine. The signed withdrawal reveals the preimages for the solved indices (15 of the 300), as every QSB spend does, which is why a vault is assembled only once;
- the recovery passphrase, and the encrypted backup files themselves;
- wallet keys: the SDK only asks a `Signer` for BIP-322 signatures and PSBT signatures.

Sent to the server:

- a BIP-322 signature of the sign-in challenge. The SDK signs only the app's session-only message for your address that names the expected app origin, so an endpoint can't relay another deployment's challenge; the session lasts an hour;
- the public vault record (script, public state, commitment hashes), after checking it has no private field;
- unsigned inputs to look up, the signed deposit transaction, the withdrawal intent (payout, fee, outpoints) and the signed withdrawal transaction.

The server relays, reserves, searches and checks, as it does for the webapp. Before anything is signed or sent, the SDK re-checks locally: that the backup's state matches the vault's script, that a returned PSBT is the one it prepared, and that the withdrawal it assembled matches the approved intent. Before a withdrawal is submitted, it requires an approval callback that receives the exact destination, payout, fee, fee rate and transaction ID.

The CLI creates every file owner-only (`0600`) and never overwrites one: an output that already exists, or that is also an input, is refused before any work. Backups are flushed to disk before the next step. The CLI caches the session token owner-only in `~/.qsb/session.json` (or keeps it in memory with `--no-cache`). It reads passphrases from a terminal prompt, a file descriptor or `QSB_PASSPHRASE`, never from arguments.

## SDK

```ts
import { QsbClient, type Signer } from "./sdk";

const signer: Signer = {
  address, // P2WPKH or nested SegWit payment address
  publicKey, // its compressed public key
  signMessage: (address, message) => wallet.bip322(address, message),
  signPsbt: (address, psbt, inputs) => wallet.signPsbt(psbt, inputs), // base64 in and out, never broadcast
};
const qsb = new QsbClient({ baseUrl: "https://app.example", signer });
await qsb.login();

// Vault: generated and encrypted here; only the public record is registered.
const { vault } = await qsb.vaults.create({ name: "cold-1", passphrase, saveBackup: keep });

// Deposit: one per vault. You sign the PSBT; the server relays it to MARA Slipstream.
const prepared = await qsb.deposits.prepare(vault.id, { backup, passphrase, amount: 200_000n, feeRate: "2", utxos });
const signed = await signer.signPsbt(signer.address, prepared.psbt, prepared.signInputs);
await qsb.deposits.submit(prepared, signed, { costAccepted: true });

// Withdrawal: saveBackup stores the backup that binds the payout before the search starts.
const { job } = await qsb.withdrawals.create({
  vaultId: vault.id, backup, passphrase, helper, destination, feeRate: "3", costAccepted: true, saveBackup: keep,
});
// Hours later, from the job id and that backup, in a new process:
const tx = await qsb.withdrawals.assemble(job.id, { backup: withdrawalBackup, passphrase, saveBackup: keep });
await qsb.withdrawals.submit(tx, { approve: async (review) => (await askUser(review)) ? review.txid : false });
```

`QsbClient` options: `baseUrl`, `signer`, and optionally `basePath` (`/v1`, the default, or the webapp's `/api` alias), `appOrigin` (the origin the server's challenge names, its `APP_ORIGIN`; default `baseUrl`'s origin), `fetch`, `qsb` (the local runtime, default Pyodide in-process), `pendingDeposits` (where a signed deposit waits until MARA has it), `authorizations` (this device's one intent and one assembly per vault), `token` (a cached session) and `timeoutMs`. `pendingDeposits` and `authorizations` default to memory; the CLI keeps both under `~/.qsb`. `QSB_NETWORK` (`mainnet` or `testnet4`) must be set when the SDK is imported; it refuses a server on another network.

The routes below are the webapp's `/api` paths; the SDK calls the same routes under `/v1` unless `basePath` is `/api`.

| Call | Route | Local work |
| --- | --- | --- |
| `login()` | `POST /api/auth/challenge`, `/verify` | checks the challenge text, then `signer.signMessage` |
| `config()`, `rates()`, `utxos()` | `GET /api/config`, `/rates`, `/payment-utxos` | |
| `vaults.create` | `POST /api/vaults` | generate, encrypt, `saveBackup`, re-open and validate |
| `vaults.list` | `GET /api/vaults` | |
| `deposits.prepare` | `/payment-input`, `/rates` | validate the backup against the vault, build the PSBT, check MARA's floor |
| `deposits.submit` | `POST /api/vaults/:id/fund/submit` | rebuild the expected PSBT, verify the signed one, keep it pending |
| `deposits.status`, `deposits.resubmit` | `GET …/funding`, `POST …/fund/submit` or `…/fund/resubmit` | resubmit resends the same bytes only |
| `withdrawals.create` | `POST /api/jobs` | fix the fee, bind the intent into a new backup (`saveBackup`) first |
| `withdrawals.list`, `status`, `pause`, `resume` | `/api/jobs…` | |
| `withdrawals.assemble` | `…/solved-result`, `…/funding`, `/payment-input` | assemble from the backup, seal the signing backup, sign the helper input |
| `withdrawals.submit` | `POST /api/jobs/:id/submit` | re-check the bytes against the job, then `approve(review)` |

`publicApi({ baseUrl })` reads `config()` and `rates()` without a signer. Errors from the server are `ApiRequestError`s with `status` and, when the server sends one, a machine-readable `code` ([docs/API.md](../docs/API.md)); the CLI prints the code after the message.

Per-owner limits ([docs/API.md](../docs/API.md#per-owner-limits)): the SDK reads `ownerLimits` from `/api/config` first, and refuses before generating, saving or signing anything when the signed-in wallet isn't allowlisted or the limits are misconfigured (`ownerLimits: null`). A refusal the server returns anyway (`owner_not_allowlisted`, `owner_active_withdrawal_limit`, `owner_gpu_budget_reached`, `owner_limits_invalid`) is final for that request: nothing was written or sent by it. A signed deposit stays pending for `deposits.resubmit`, and a new withdrawal's intent stays in its new backup for a later `withdrawals.create`. `qsb config` shows `ownerLimits`.

Rules that carry over from the webapp:

- A vault takes one deposit. A signed deposit is kept as pending before it is sent, and only those bytes are ever resent. `deposits.prepare` refuses while one is pending or the vault is funded, and MARA's floor is checked again right before a deposit is sent.
- A withdrawal's one-time keys are bound to one intent and one assembly. `withdrawals.create` with a backup that already holds an intent resumes it unchanged, and `withdrawals.assemble` refuses a backup bound to another solution. Like the webapp's `qsb-intent:` and `qsb-assembly:` keys, `authorizations` remembers the intent and the assembled transaction per vault and refuses a different one, even from an older backup that doesn't bind it yet.
- `withdrawals.submit` shows values only after checking that the stored intent hashes to the one bound at assembly. Only the server's own disabled refusal counts as "nothing was accepted"; any other failure, including a gateway 503, is reported as an uncertain outcome that must not be submitted again.

## CLI

```sh
export QSB_NETWORK=mainnet QSB_API_URL=https://app.example
export QSB_ADDRESS=bc1q... QSB_PUBLIC_KEY=02...
npm run qsb -- login --message-out challenge.txt      # sign the message (BIP-322), paste the signature
npm run qsb -- vault create --name cold-1 --backup vault.json
npm run qsb -- utxos
npm run qsb -- deposit prepare <vault> --backup vault.json --amount 0.002 --fee-rate 2 --utxo <txid:vout> --out deposit.json
#   sign deposit.psbt in your wallet (Sparrow, HWI, …) without broadcasting
npm run qsb -- deposit submit --prepared deposit.json --signed deposit-signed.psbt --accept-costs
npm run qsb -- deposit status <vault>
npm run qsb -- withdraw create <vault> --backup vault.json --out-backup withdrawal.json \
  --helper <txid:vout> --destination bc1q... --fee-rate 3 --accept-costs
npm run qsb -- withdraw status <job>
npm run qsb -- withdraw assemble <job> --backup withdrawal.json --out-backup signing.json --out signed.json
#   writes the helper PSBT; on a terminal it asks for the signed file, in a script it exits 3. Sign input 0, then:
npm run qsb -- withdraw assemble <job> --backup signing.json --out signed.json --signed-psbt helper-signed.psbt
npm run qsb -- withdraw submit --signed signed.json   # shows the transaction; type its ID to submit
```

`npm run qsb -- --help` lists every command and option. Output on stdout is JSON; prompts and explanations go to stderr. Exit codes: 0 done, 1 refused, failed or not final (for example, MARA's answer was lost), 2 usage, 3 waiting for an external signature.

The default signer is external: the CLI writes each request (the sign-in message to stderr and `--message-out`, PSBTs to files) and reads the signature back from stdin or `--signed-psbt`, so any wallet can sign. `withdraw submit` prints the destination, payout, fee, fee rate and transaction ID, then submits only when you type that transaction ID.

`--approve-txid <txid>` answers that question in advance. It bypasses a person at the terminal, so it is meant for integrators who run their own approval gate first. The CLI still prints every value and a warning that approval is non-interactive, and it submits only if the ID matches the transaction exactly.

`--signer test-key` uses a raw WIF key from `QSB_TEST_SIGNER_KEY`, for tests and local development against `npm run dev`. It refuses any API URL that isn't loopback (127.0.0.1, localhost or [::1]). With `npm run dev`, use `--api http://127.0.0.1:5173 --base-path /api`: Vite proxies `/api` only, and the challenge names that origin. Elsewhere the CLI calls `/v1`.

`config` and `rates` need no wallet. Every other command needs `--address` and `--public-key`, or the test key.

## Limits

- Phase 1 of #85: the existing `/api` routes only. There is no `/v1`, API key, webhook or OpenAPI spec yet.
- Withdrawal assembly uses the Step Functions coordinator's solved result, which the server delivers on mainnet only, so `withdrawals.assemble` and `withdrawals.submit` refuse on testnet4.
- The tests can't run a GPU search. [`tests/sdk-e2e.test.ts`](../tests/sdk-e2e.test.ts) drives the CLI against `createApp` with the in-memory store, a fake chain and a fake miner; it stands in for the coordinator's solution and for the Python assembler, which refuses anything but a real hit ([`tests/sdk-runtime.test.ts`](../tests/sdk-runtime.test.ts)).
- No licence has been chosen for the application code, including this SDK (see the top-level README).
