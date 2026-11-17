# QSB TypeScript SDK and `qsb` CLI

Research software; the npm workspace `@starknet-innovation/qsb-sdk` is private. The deployment's mainnet switches govern operations. QSB deploys on mainnet only.

The SDK plans and validates public transactions and calls the service API. **All vault key material, wallet keys, recovery backups, passphrases, credential storage and durable one-time authorization live in caller-owned components outside qsb-app.** PQB seeds never enter the SDK or CLI. A signed withdrawal intentionally contains its selected HORS preimages, menu signatures and ECDSA co-signature/public key.

## External providers

```ts
import { QsbClient, type ExternalCustody, type AuthorizationStore, type Credentials,
  type Signer, type VaultDescriptor } from "@starknet-innovation/qsb-sdk";

// These adapters talk to your own manager/wallet, preferably in separate processes.
declare const custody: ExternalCustody;
declare const authorizations: AuthorizationStore;
declare const credentials: Credentials;
declare const signer: Signer;
declare const descriptor: VaultDescriptor; // generated and backed up outside qsb-app

const qsb = new QsbClient({ baseUrl: "https://app.example", custody, authorizations, credentials, signer });
const { vault } = await qsb.vaults.create({ name: "cold-1", descriptor });
const prepared = await qsb.deposits.prepare(vault.id, {
  amount: 200_000n, feeRate: "2", utxos,
});
const signed = await signer.signPsbt(signer.address, prepared.psbt, prepared.signInputs);
await qsb.deposits.submit(prepared, signed, { costAccepted: true });

const { job } = await qsb.withdrawals.create({ vaultId: vault.id, helper, destination,
  feeRate: "3", costAccepted: true });
// After a restart or an unanswered create, use the same durable external store:
await qsb.withdrawals.create({ vaultId: vault.id, costAccepted: true });

// After the search completes:
const request = await qsb.withdrawals.prepare(job.id); // public, exportable for review
const result = await qsb.withdrawals.assemble(job.id); // external vault authorization + helper signature
await qsb.withdrawals.submit(result, { approve: async review =>
  await yourApprovalGate(review) ? review.txid : false });
```

Set `QSB_NETWORK=mainnet` before importing the SDK. `basePath` defaults to `/v1`; `/api` is the compatibility alias. `fetch`, `timeoutMs` and `pendingDeposits` are optional. Use durable pending-deposit storage across process restarts. `publicApi({ baseUrl })` reads configuration, rates and the optional service fee without any providers.

`Signer` supplies the compressed public key, its P2WPKH or P2SH-P2WPKH address, and `signPsbt(address, psbt, inputs)`. It signs without broadcasting. That wallet owns the service session, funds the deposit and supplies the helper input. Authentication happens externally: `credentials.get()` supplies a fresh session token or scoped mainnet API key for each request. The SDK uses it transiently in `X-Qsb-Authorization`, follows no redirects and stores no credential cache. The external login implementation must validate the BIP-322 challenge's address, network, expected app origin and session-only purpose before signing it.

## PQB external custody

A `VaultDescriptor` contains exactly `config`, `scriptHex`, `scriptHash` and `publicStateJson`. For PQB, its public state contains the dummy-signature table and curve-point menus; no seed, scalar or private co-signature key is accepted. The SDK checks the schema, script hash, configuration and public-state/script binding. `custody.confirmVault(vault)` must independently establish that the exact descriptor can be recovered from durably stored material. It runs before registration and deposit preparation. A public descriptor alone cannot prove recoverability. The external manager must also prevent one-time material reuse across wallets and deployments; the SDK's additional overlap check covers the current owner's registered vaults only.

Before authorization, the SDK verifies every PQB hit with the canonical public reference, including the pinning nonce, both selections and FindAndDelete-based problems. It checks both previous transactions and their output values/scripts, and the helper's ownership. `WithdrawalSigningRequest` includes the public vault, solved result, unsigned transaction, both previous transactions, helper identity and ordered selections. The external manager must independently verify these inputs and approve the exact destination, amount and fee, rather than trust supplied labels or hashes.

`custody.authorizeWithdrawal(request)` must durably bind one intent and one assembly **before revealing any one-time material**, and return the same vault-authorized transaction bytes on an identical retry. Input 0 must remain unsigned; input 1 contains the complete legacy PQB scriptSig. The SDK checks its exact spend, executes its supported script/stack operations and verifies every ECDSA signature before asking the wallet for the helper's SIGHASH_ALL signature. These local checks are not Bitcoin Core consensus evidence. The service still runs Core's interpreter on the exact signed transaction before its one permitted MARA submission.

For Config A, the SDK rebuilds public state from commitments, verifies the solution through the pinned manifest-checked Python runtime and reconstructs the returned authorization from only the preimages it discloses. It never receives the complete secret set. Both protocols use the same external authorization journal and transaction approval path. A withdrawal pins the release the deployment serves when created; a deposit is never bound to a solver release.

## Durable one-time journal

`AuthorizationStore.get(key)` reads a public record. `claim(key, value)` must atomically insert it only if absent, succeed unchanged for an identical value, and reject a different value. A resolved claim must survive crashes. **Every device/process using the vault must share this store; never expire, overwrite or restore it to an earlier snapshot.** There is no in-memory default.

Keys bind the mainnet script hash to an exact canonical withdrawal intent (`qsb-intent:mainnet:<hash>`), public transaction/solution (`qsb-assembly:mainnet:<hash>`), and returned assembly bytes (`…:raw`). The intent is durable before starting paid search work; the public assembly is bound before the manager releases material; the raw assembly is bound before helper signing. An unanswered operation retains its claims. The manager must enforce equivalent bindings at its own signing boundary even if another client bypasses the SDK. Claims alone are not permission to disclose secrets.

A conflicting claim stops the operation. Resume the original intent/assembly; do not reset claims to authorize a replacement. Provider errors before search creation keep the saved intent available for an identical retry. Unknown withdrawal submission outcomes require operator reconciliation and must never be resubmitted. Deposit retries resend only their original signed bytes. Each vault takes one deposit; stray payments are never spent or recovered through this app.

## CLI and agent protocol

The CLI uses a caller-owned executable via `--agent /absolute/path/to/adapter` or `QSB_AGENT`. It spawns it without a shell or arguments, sends one JSON request on stdin, and reads one JSON response on stdout. The adapter should communicate with your wallet, secret manager and durable store. QSB ships no secret-holding agent implementation.

```json
{"format":"qsb-agent-request-v1","operation":"credentials.get","context":{"baseUrl":"https://app.example","network":"mainnet","address":"…","publicKey":"…"},"input":null}
```

The adapter responds with exactly `{"result": value}` and exits zero. Nonzero exits, malformed responses and requests exceeding two minutes fail closed. Agent stderr is drained without being retained or echoed; never return secrets except the bearer credential requested for an authenticated header or the witness material the signed transaction reveals.

| Operation | Input | Result |
| --- | --- | --- |
| `credentials.get` | `null` | Session token or mainnet API key |
| `custody.confirmVault` | `{ vault }` | `true` after durable recovery verification |
| `authorizations.get` | `{ key }` | Stored string, or `null` |
| `authorizations.claim` | `{ key, value }` | `true` after the atomic durable claim |
| `custody.authorizeWithdrawal` | `WithdrawalSigningRequest` | Vault-authorized raw transaction hex, helper unsigned |
| `wallet.signPsbt` | `{ address, psbt, inputs }` | Signed PSBT as base64; never broadcast |

`qsb --help` lists commands. `vault create --descriptor <file>` registers a public descriptor; `withdraw prepare <job> --out <file>` exports a public signing request; `withdraw assemble` obtains external authorizations. The CLI accepts no backup, seed, passphrase, raw-key or credential options and creates no session cache. `--home` stores only public pending-deposit records. Files are owner-only, flushed before success, and never overwritten. Exit codes: 0 success, 1 failed/refused/uncertain, 2 usage. `withdraw submit` displays the exact destination, payout, fee and txid and requires that txid as approval. `--approve-txid` bypasses terminal interaction and requires your own approval gate first.

## Compatibility and validation

The public SDK has no `login()`, `token`, `apiKey`, `qsb`, backup or passphrase options. Move those responsibilities into the external providers. A vault already authorized through a backup-based client must have its existing intent and assembly bindings migrated to the shared external journal before use; never start it with an empty journal. Recovery verification and migration belong to the external manager.

Build with `npm run build -w @starknet-innovation/qsb-sdk`; run `node sdk/check-package.mjs` to pack, install outside the repository and check consumer declarations. The package includes public Config A validation sources and PQB notices. The production SDK and CLI do not export or bundle secret-generation, seed-import, backup-decryption or test-key APIs. The API is handwritten; see [API.md](../docs/API.md) for routes not wrapped by the SDK. Publishing requires a licence decision and npm scope access.

Tests use a fake chain/miner, public synthetic material and, for orchestration flows, a public-planner double instead of an actual GPU solution. PQB public hit rejection and witness checks have separate component coverage, including seed-free replay of the archived public synthetic full solution. These tests are not a real solve, consensus acceptance, mainnet inclusion or an end-to-end funded withdrawal.
